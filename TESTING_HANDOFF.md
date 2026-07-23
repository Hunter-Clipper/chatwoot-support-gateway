# Support Gateway — Testing Handoff

Prepared 2026-07-22, against the actual running stack (not a description of intended behavior).
This is the single entry point for the testing team: what got built, why, how to run it, and a
real test sweep captured today. The three docs it points into (`TESTING_GUIDE.md`,
`services/support-gateway/README.md`, `services/support-gateway/test/known-gaps.test.ts`) are
the living references going forward - this doc is the one-time orientation.

**Source of truth for requirements:** `Chatwoot_Headless_Integration_Specification.docx` in this
directory. Everything below is checked against it, and it's referenced by section number
throughout (e.g. "spec 18.2") so you can look anything up yourself.

---

## 1. What we did

**The ask:** replace a paid ticketing tool with self-hosted Chatwoot CE, but per an architecture
spec from a stakeholder, Chatwoot may never be called directly by the product. A proprietary
Node.js "support gateway" (`services/support-gateway/`) sits in between as the only thing
allowed to talk to Chatwoot - it owns tenant authorization, token handling, webhook
verification, and translates Chatwoot's raw shapes into a stable, provider-neutral API contract.
**The gateway/API is the entire deliverable here** - the UI that will actually call this API is
an existing in-house React/Next.js application, not something built in this repo.

**What's built and verified live** (not just implemented - each of these was exercised against
the real running stack, and real bugs found along the way are called out):

- Full read/write/create conversation API (list, get, messages, replies, private notes, status,
  assignment, labels, and ticket creation from scratch)
- Session-based auth (verified JWTs) and full tenant isolation across two simulated tenants
- Webhook receipt with HMAC signature verification, timestamp freshness, and durable
  (SQLite-backed) delivery deduplication that survives a process restart
- Reconciliation - both on-demand and scheduled - that repairs drift between Chatwoot and the
  gateway's local read model, including pruning conversations that vanish entirely (found via a
  real backup/restore drill, not designed in up front)
- Idempotent writes (`Idempotency-Key` header) so a retried request never double-creates a
  message or ticket
- A circuit breaker around every Chatwoot call, and gateway-level rate limiting
- Realtime (Server-Sent Events) publication of live events to subscribed UI sessions
- A verified backup/restore procedure for both Chatwoot's Postgres database and the gateway's
  own SQLite store - actually drilled, including two real gotchas caught along the way (see
  `BACKUP_RESTORE.md`)
- A verified Chatwoot version-upgrade procedure - actually drilled on an isolated stack, real
  migrations run, full suite passed before and after (see `UPGRADE_TESTING.md`)

**Real bugs found and fixed during this work**, worth knowing about even though they're fixed:
- Every automated test run was filling the real support inbox with "undeliverable" bounce
  tickets - traced to a real Channel::Email inbox sharing one live mailbox for both outgoing
  SMTP and inbound polling. Fixed by moving all test/fixture writes to a dedicated API-channel
  test inbox that can't send real mail.
- Reconciliation didn't originally notice a conversation that vanished *entirely* (as opposed to
  one that just changed status) - found during the backup/restore drill, now fixed and covered
  by a regression test.
- A SQLite restore could be silently undone by leftover files from an unclean process shutdown -
  found during the same drill, now documented as a required step in the restore procedure.

**What's NOT done, honestly** - 18 items, tracked as `test.todo()` entries in
`services/support-gateway/test/known-gaps.test.ts` so they show up in every test run rather than
living only in a doc someone can forget to check. Section 4 below explains these in more detail
and groups them by who actually owns closing each one.

---

## 2. How to use it

### Prerequisites
Docker, Docker Compose, Node.js (this was built/tested against the versions already installed
on this host - see `services/support-gateway/package.json` for the toolchain).

### Start everything
```bash
cd /home/user/Projects/Chatwoot
docker compose up -d              # Chatwoot: Rails + Sidekiq + Postgres + Redis
docker compose ps                  # confirm all 4 containers are Up

cd services/support-gateway
npm install                        # first time only
npm run dev                        # or: npx tsx src/server.ts
```
Chatwoot: `http://localhost:3005` Gateway: `http://localhost:4000`

**Important:** if you edit any file under `services/support-gateway/src/`, you must kill and
restart the gateway process for the change to take effect - `/healthz` responding only proves
the process is *running*, not that it's running your latest code. This bit us more than once
during development.

### Mint a test session (there's no real login flow yet - that's the in-house app's job)
```bash
cd services/support-gateway
npx tsx scripts/issue-test-session.ts tenant-a stub-user
# prints a JWT - use as: -H "Authorization: Bearer <token>"
```
Valid identities: `stub-user`/`jordan-tech` (tenant-a), `tenantb-admin` (tenant-b) - these are
the keys in `CHATWOOT_AGENT_TOKENS` in `services/support-gateway/.env`.

### Try it
```bash
TOKEN=$(npx tsx scripts/issue-test-session.ts tenant-a stub-user)

curl http://localhost:4000/healthz
curl http://localhost:4000/readyz
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/support/conversations
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/support/conversations/1

# Create a brand-new ticket (not from inbound email/widget)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4000/support/conversations \
  -d '{"content": "I need help", "contact": {"name": "Jane Customer", "email": "jane@example.com"}}'
```

### Run the automated suite (do this first, every time)
```bash
cd services/support-gateway
npm run typecheck   # tsc --noEmit
npm test             # vitest run - requires Chatwoot + gateway both running
```

### Credentials
Real tokens/secrets live only in `.env` files (`services/support-gateway/.env`, root `.env`),
never copied into any doc. If you need dashboard access, ask for an agent invite rather than
sharing a login.

### Multi-tenant test data
Two Chatwoot accounts simulate two customers of the product, specifically to test that data
never crosses between them:

| Tenant | Account | Purpose |
|---|---|---|
| `tenant-a` | Account 1 | Real email + widget inboxes, plus a dedicated API-channel test inbox (inbox 4) that all automated writes use |
| `tenant-b` | Account 2 | API-channel only, no real email/widget - exists purely for isolation testing |

Full detail: `TESTING_GUIDE.md` section 3.

---

## 3. Test sweep output

Captured 2026-07-22, against the live stack described above (real Chatwoot + real gateway
process, not mocks). Typecheck first, then the full suite in verbose mode so every individual
test name is visible, not just the summary counts.

### Typecheck
```
> support-gateway@0.1.0 typecheck
> tsc --noEmit -p tsconfig.test.json

(clean - no output means no errors)
```

### Full suite (verbose)
```
 RUN  v4.1.10 /home/pbdweller/Projects/Chatwoot/services/support-gateway

 ✓ test/reconciliation.test.ts > reconciliation > runs and returns a checked/repaired/pruned count
 ✓ test/reconciliation.test.ts > reconciliation > rejects reconciliation for an unmapped tenant
 ✓ test/reconciliation.test.ts > reconciliation > prunes a local row for a conversation that no longer exists at the provider (post-restore drift)
 ✓ test/reconciliation.test.ts > ReconciliationScheduler wired to the real ReconciliationService > reconciles every tenant in CHATWOOT_RECONCILIATION_ACTORS in one pass
 ✓ test/ticket-creation.test.ts > POST /support/conversations (ticket creation) > creates a conversation against the tenant's configured default inbox
 ✓ test/ticket-creation.test.ts > POST /support/conversations (ticket creation) > reuses an existing contact by email instead of creating a duplicate
 ✓ test/ticket-creation.test.ts > POST /support/conversations (ticket creation) > rejects a request missing contact info with 400
 ✓ test/ticket-creation.test.ts > POST /support/conversations (ticket creation) > is idempotent: retrying the same Idempotency-Key and body returns the same conversation, not a new one
 ✓ test/ticket-creation.test.ts > POST /support/conversations (ticket creation) > same Idempotency-Key with a different body is a 409 conflict, not a second ticket
 ✓ test/ticket-creation.test.ts > POST /support/conversations (ticket creation) > creates tenant-b tickets against tenant-b's own default inbox (account 2, not account 1)
 ✓ test/auth.test.ts > session authentication > rejects a request with no Authorization header
 ✓ test/auth.test.ts > session authentication > rejects a tampered token
 ✓ test/auth.test.ts > session authentication > rejects an expired token
 ✓ test/auth.test.ts > session authentication > rejects a well-formed session for an unregistered acting user
 ✓ test/auth.test.ts > session authentication > rejects a session for an unmapped tenant
 ✓ test/auth.test.ts > session authentication > accepts a valid session
 ✓ test/conversations-write.test.ts > conversations: write path > sends a public reply with private: false
 ✓ test/conversations-write.test.ts > conversations: write path > creates a private note with private: true
 ✓ test/conversations-write.test.ts > conversations: write path > rejects empty reply content before ever calling Chatwoot
 ✓ test/conversations-write.test.ts > conversations: write path > updates status and it actually persists
 ✓ test/conversations-write.test.ts > conversations: write path > rejects an invalid status value
 ✓ test/conversations-write.test.ts > conversations: write path > updates labels and they actually persist
 ✓ test/conversations-write.test.ts > conversations: write path > rejects an assignment with neither agentId nor teamId
 ✓ test/conversations-write.test.ts > conversations: write path > assigns to a valid agent and it actually persists
 ✓ test/conversations-read.test.ts > conversations: read path > lists conversations matching the ConversationPage contract
 ✓ test/conversations-read.test.ts > conversations: read path > gets a single conversation matching the Conversation contract
 ✓ test/conversations-read.test.ts > conversations: read path > lists messages for a conversation matching the MessagePage contract
 ✓ test/conversations-read.test.ts > conversations: read path > 404s for a conversation id that does not exist, per Appendix A.2
 ✓ test/idempotency.test.ts > idempotent writes (Idempotency-Key) > retrying the same Idempotency-Key + body returns the same message, not a new one
 ✓ test/idempotency.test.ts > idempotent writes (Idempotency-Key) > reusing the same key with a different body is a 409, not a silent overwrite
 ✓ test/idempotency.test.ts > idempotent writes (Idempotency-Key) > without an Idempotency-Key header, behavior is unchanged - every call executes
 ✓ test/health.test.ts > health > GET /healthz returns ok
 ✓ test/health.test.ts > health > GET /readyz confirms Chatwoot is reachable
 ✓ test/tenant-isolation.test.ts > tenant isolation > the same conversation id returns genuinely different data for different tenants
 ✓ test/tenant-isolation.test.ts > tenant isolation > rejects a session whose agent does not belong to the claimed tenant account
 ✓ test/rate-limiter.test.ts > RateLimiter (unit) > allows requests below the threshold within the window
 ✓ test/rate-limiter.test.ts > RateLimiter (unit) > limits once a key exceeds max requests within the window
 ✓ test/rate-limiter.test.ts > RateLimiter (unit) > tracks separate keys independently
 ✓ test/rate-limiter.test.ts > RateLimiter (unit) > resets once the window elapses
 ✓ test/rate-limiter.test.ts > rateLimitMiddleware wired into Express > rejects with 429 and GATEWAY_RATE_LIMITED once the limit is exceeded
 ✓ test/webhooks.test.ts > webhook signature verification (spec 10.2) > accepts a validly signed payload
 ✓ test/webhooks.test.ts > webhook signature verification (spec 10.2) > flags a replayed delivery id as a duplicate
 ✓ test/webhooks.test.ts > webhook signature verification (spec 10.2) > rejects a tampered body
 ✓ test/webhooks.test.ts > webhook signature verification (spec 10.2) > rejects a stale timestamp outside the acceptance window
 ✓ test/webhooks.test.ts > webhook signature verification (spec 10.2) > rejects a payload signed with the wrong tenant secret
 ✓ test/circuit-breaker.test.ts > CircuitBreaker (unit) > stays closed and just rethrows below the failure threshold
 ✓ test/circuit-breaker.test.ts > CircuitBreaker (unit) > opens after the failure threshold and fails fast without calling the function
 ✓ test/circuit-breaker.test.ts > CircuitBreaker (unit) > goes half-open after the cooldown and closes again on a successful trial
 ✓ test/circuit-breaker.test.ts > CircuitBreaker (unit) > a failed half-open trial reopens immediately, not after re-accumulating the threshold
 ✓ test/circuit-breaker.test.ts > CircuitBreaker wired into ChatwootClient > fails fast after repeated connection failures to an unreachable host
 ✓ test/reconciliation-scheduler.test.ts > ReconciliationScheduler (unit) > reconciles every configured tenant on runOnce()
 ✓ test/reconciliation-scheduler.test.ts > ReconciliationScheduler (unit) > one tenant failing does not stop the others from reconciling in the same tick
 ✓ test/reconciliation-scheduler.test.ts > ReconciliationScheduler (unit) > start() reconciles immediately and again after the interval elapses
 ✓ test/reconciliation-scheduler.test.ts > ReconciliationScheduler (unit) > stop() halts further scheduled runs
 ✓ test/reconciliation-scheduler.test.ts > ReconciliationScheduler (unit) > a tenant with no configured actor is simply skipped, not an error
 □ test/known-gaps.test.ts (18 known gaps, listed in full in section 4 below - these are
   test.todo() by design, not failures; see below for what each one means and who owns it)

 Test Files  12 passed | 1 skipped (13)
      Tests  55 passed | 18 todo (73)
   Start at  09:19:35
   Duration  33.31s (transform 703ms, setup 0ms, import 3.92s, tests 21.58s, environment 9ms)
```

**55/55 passing, 0 failures.** The 18 `test.todo()` entries are deliberate placeholders for
known gaps (explained next), not silent failures - `npm test` always exits 0 as long as no real
test fails, so a CI pipeline built on this won't be fooled by a growing todo list, but a human
should still read it.

---

## 4. Everything else worth knowing before testing

### The 18 tracked gaps - grouped by who actually closes each one

The full list with exact wording lives in `services/support-gateway/test/known-gaps.test.ts` -
it's the authoritative, always-current source, checked against the spec's entire acceptance
plan (section 18) and Appendix B checklist, not just a subset. Grouped here so it's clear what
testing can/can't meaningfully cover for each:

**Needs your input or the in-house app's own data model (not an engineering decision to make
solo):**
- Ticket-linkage mapping (needs the in-house app's ticket ID scheme)
- Attachments and priority updates (Appendix A's route table lists them, but the interface spec
  itself doesn't - a real spec-internal mismatch, not an oversight; needs a scope decision)
- Product-side audit records (needs the in-house app's audit event format)

**Legal/ops, not engineering:**
- License/SBOM/enterprise-exclusion review (spec says "have counsel review")
- Incident response ownership documentation
- Data retention/legal-hold policy for messages and attachments

**Real engineering gaps, buildable, just not done yet:**
- No Platform API provisioning route - every account/agent in this project so far was
  provisioned via manual scripts, not a proper gateway-owned workflow
- No isolated Platform App token (personal tokens got reused for provisioning)
- No observability layer (no correlation IDs, no latency/error/queue metrics)
- Rate limiting is IP-only, not per-user/per-tenant as the spec asks for
- No Redis/Sidekiq worker monitoring
- Object storage is local disk, not private/encrypted
- No rollback-specifically drill (distinct from the forward-upgrade test already done)
- Email threading is untested (needs a real external mailbox to send from, not configured here)
- Inbound HTML sanitization (arguably belongs to whichever app renders the content now - a
  scope question as much as a build question)
- Administrative Chatwoot UI has no network-level restriction, only login (spec 3.3)

### Known gotchas (read before filing a bug)
Full list with more detail: `TESTING_GUIDE.md` section 4. Highlights:
- Widget returns 429 / "disconnected": Chatwoot's own anti-spam rate limit, not a gateway bug -
  add your IP to `RACK_ATTACK_ALLOWED_IPS`.
- A newly invited agent can't act on a conversation: needs *inbox* membership, not just account
  membership.
- `/healthz` responding does not prove the gateway is running your latest code - always restart
  the process after a source change.

### Runbooks for infrastructure-level testing
- `BACKUP_RESTORE.md` - backing up/restoring both Chatwoot's Postgres and the gateway's SQLite,
  with two real gotchas documented (WAL/SHM leftovers, reconciliation not pruning vanished
  conversations - now fixed, but the runbook explains why it mattered).
- `UPGRADE_TESTING.md` - testing a Chatwoot version bump against an isolated staging copy before
  touching the real instance. Already run once for real; reuse the same stack for the next bump.

### What's explicitly out of scope here
No UI exists in this repo, and none should be built here - the real UI is an existing in-house
React/Next.js application that consumes this API. If you're looking for something to click
through, you're looking for the wrong repo; this is API/contract testing.

### If something looks wrong
Check `test/known-gaps.test.ts` first - it might be a known, tracked gap rather than a new bug.
If it's not there, it's either a real regression (please report it) or something this handoff
doc missed - in which case, flag that gap in the doc itself so the next person doesn't have to
rediscover it.
