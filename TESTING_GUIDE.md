# Chatwoot Test Environment — Testing Guide

This covers the whole local test environment: the Chatwoot instance itself (email/widget
ticket creation, dashboard) and the proprietary `support-gateway` service being built on top
of it per `Chatwoot_Headless_Integration_Specification.docx`. The gateway is the actual
deliverable here — your existing in-house React/Next.js app is the real consumer of its API
and isn't something built in this repo. Everything here runs on one Docker host; nothing is
production.

## 1. What's running

| Component | How | URL / Port |
|---|---|---|
| Chatwoot (Rails + Sidekiq) | Docker Compose, image pinned to `chatwoot/chatwoot:v4.16.0-ce` | `https://chatwoot.hunterclipper.com` (via reverse proxy) or `http://localhost:3005` (direct) |
| Postgres / Redis | Docker Compose | internal only (127.0.0.1:5432 / 6379) |
| Support gateway (Node.js) | `npm run dev` in `services/support-gateway/`, not containerized yet | `http://localhost:4000` |

**Start/stop Chatwoot:**
```
cd /home/pbdweller/Projects/Chatwoot
docker compose up -d          # start everything
docker compose ps             # check status
docker compose logs -f rails  # tail logs
```

**Start the gateway:**
```
cd services/support-gateway
npm install                   # first time only
cp .env.example .env          # first time only - see section 5 for what to fill in
npm run dev
```

## 2. Chatwoot dashboard

Log in at the URL above with your existing admin account. (Not documented here on purpose —
it's a personal login, not a shared test credential. If you need dashboard access, ask for an
agent invite via **Settings → Agents → Add New Agent**.)

### Email → ticket

- Support inbox: **Hunter Clippers Support**, polling `hunter@hunterclipper.com` via IMAP
- To test: send an email from any external account to `hunter@hunterclipper.com` with a
  distinct subject line. IMAP polling runs on an interval (roughly every minute, not instant)
  - check **Conversations** after that.
- Known behavior, not a bug: any email *sent from* `hunter@hunterclipper.com` itself (e.g. a
  system notification) is deliberately filtered out and will never become a ticket - Chatwoot
  does this to stop its own outgoing mail from looping back in as fake tickets.

### Widget / live chat → ticket

- Widget inbox: **HunterClipper** (`Channel::WebWidget`), embedded on the Help Center at
  `/hc/hunter-clippers-help-center`
- To test: open the help center, start a chat, send a message. Should appear in
  **Conversations** within a few seconds (no polling delay like email).
- **If you get a 429 / "disconnected" banner:** see section 4 (Rack::Attack).

## 3. Multi-tenant test data

Two separate Chatwoot **accounts** exist, simulating two different customers of the product
this gateway will serve - useful for testing that data never crosses between them.

| Tenant label | Chatwoot account | Inbox | Agents |
|---|---|---|---|
| `tenant-a` | Account 1, "HunterClipper.com" | Hunter Clippers Support (real email, inbox 1), HunterClipper (widget, inbox 2), **Gateway Test Inbox (API channel, inbox 4 - use this for fixtures/automated writes)** | Hunter Clipper (administrator), Jordan Tech (agent) |
| `tenant-b` | Account 2, "Tenant B Corp" | Tenant B Support (API channel, inbox 3, no real email/widget - created only to have test data) | Tenant B Admin (administrator) |

Account 2 has no real email or widget configured - it exists purely so the gateway's
tenant-isolation logic has a second, genuinely separate dataset to test against. Don't expect
to log into it via the normal dashboard flow unless you're specifically testing that.

**Why tenant-a has a dedicated API-channel test inbox (inbox 4):** its real email inbox (inbox
1) shares one live mailbox (`hunter@hunterclipper.com`) for both outgoing SMTP *and* the IMAP
polling that creates tickets. Any write against a conversation on that inbox sends a real
email; a bounce for a fake/fixture contact address comes right back into that same polled
mailbox as a brand-new "undeliverable" ticket. Every automated test and `CHATWOOT_TENANT_DEFAULT_INBOX`
now point at inbox 4 instead - see section 4's gotcha entry for how this was found.

All of the above agents' Chatwoot API tokens, and the tenant→account mapping itself, live in
`services/support-gateway/.env` (`CHATWOOT_AGENT_TOKENS`, `CHATWOOT_TENANT_ACCOUNTS`) - see
section 6 to mint a usable test session from them.

## 4. Known gotchas (read before filing a bug)

- **Widget returns 429 / shows "disconnected"**: Chatwoot rate-limits fresh widget page-loads
  to 5/hour per IP by design (anti-spam). If you're reload-testing repeatedly, your IP may need
  adding to `RACK_ATTACK_ALLOWED_IPS` in the main `.env` (comma-separated list, already includes
  the IPs used during development - add yours if testing from elsewhere) and the `rails`/
  `sidekiq` containers restarted (`docker compose up -d rails sidekiq`).
- **"Reconnect with Google" banner on the email inbox**: cosmetic. The inbox uses plain
  IMAP/SMTP, not Google OAuth - the banner appears to be a Chatwoot UI quirk keyed off the
  `imap.gmail.com` hostname, not an actual connection problem. Confirmed the underlying IMAP
  polling itself works fine via Sidekiq logs regardless of this banner.
- **A newly invited/provisioned agent can't act on a conversation** ("You are not authorized to
  do this action"): being added to the *account* isn't enough - they also need to be a member
  of the specific *inbox* (Settings → Inboxes → [inbox] → Collaborators, or via API). This bit
  us once during gateway testing.
- **Login fails right after creating an account with "Invalid login credentials"**: check for
  an email casing mismatch - Chatwoot doesn't reliably lowercase email on signup in every path,
  and Postgres string comparison is case-sensitive.
- **Test runs fill the real support inbox with "undeliverable"/bounce tickets**: happened
  because test fixtures and `CHATWOOT_TENANT_DEFAULT_INBOX` used to point at inbox 1 (the real
  `Channel::Email` inbox), whose outgoing SMTP and inbound IMAP polling share the same real
  mailbox in this environment. Every conversation/message a test creates there sends a real
  outbound email; a bounce for a fake fixture address comes right back in as a new ticket.
  Fixed by moving all automated writes to a dedicated `Channel::Api` inbox (inbox 4, "Gateway
  Test Inbox") that never sends real mail - see section 3. If this recurs, check what inbox the
  offending conversation is on before assuming it's a gateway bug.

## 5. Automated test suite (run this first)

```
cd services/support-gateway
npm test
```

A real, repeatable contract/integration test suite - requires Chatwoot and the gateway both
running (section 1). Full detail in `services/support-gateway/test/README.md`. As of this
writing: 55 passing tests covering auth, tenant isolation, webhooks, on-demand and scheduled
reconciliation (including pruning after a restore), idempotent writes (including ticket
creation), a circuit breaker and rate limiter around/on top of Chatwoot calls, and the full
read/write/create conversation API, plus 18 `test.todo()` entries for known gaps against the
spec's *entire* acceptance plan and Appendix B checklist (not just section 18) - things like
email threading, license-boundary checks, Platform API provisioning, observability/correlation
IDs, and per-tenant rate limiting that aren't implemented or tested yet. The count jumped from 9
to 18 on 2026-07-22 after a full line-by-line pass against Appendix B and sections 12.4/15.1
turned up real gaps that had gone untracked - see `services/support-gateway/README.md`'s
"Deliberately not implemented yet" section for the full list. Run this before trusting anything
still works after a change; the todo list is what's still owed before this is genuinely
production-ready.

## 6. Support gateway (API) testing (manual/exploratory)

Full details, endpoint list, and what's been verified live: `services/support-gateway/README.md`.
This section is for manual/ad-hoc checks beyond what the automated suite covers.

Every `/support/*` and `/internal/support/*` route requires a signed session token - there's no
real product login flow yet (that's your in-house app's job once it integrates), so tests mint
one directly:

```
cd services/support-gateway
npx tsx scripts/issue-test-session.ts tenant-a stub-user
# prints a JWT - use it as: -H "Authorization: Bearer <token>"
```

`stub-user` = Hunter Clipper, `jordan-tech` = Jordan Tech (both tenant-a); `tenantb-admin` =
Tenant B Admin (tenant-b). These names are the keys in `CHATWOOT_AGENT_TOKENS` in `.env` - open
that file to see (or add) valid names, not this doc.

**Common checks:**
```bash
TOKEN=$(npx tsx scripts/issue-test-session.ts tenant-a stub-user)

curl http://localhost:4000/healthz
curl http://localhost:4000/readyz                                    # confirms Chatwoot is reachable
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/support/conversations
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/support/conversations/1
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4000/support/conversations/1/replies -d '{"content": "test reply"}'

# Create a new ticket (not from inbound email/widget) - goes to the tenant's configured
# CHATWOOT_TENANT_DEFAULT_INBOX
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4000/support/conversations \
  -d '{"content": "I need help", "contact": {"name": "Jane Customer", "email": "jane@example.com"}}'
```

**Cross-tenant isolation check** (should return *different* data despite the same conversation
number - this is the main thing worth spot-checking after any change here):
```bash
curl -H "Authorization: Bearer $(npx tsx scripts/issue-test-session.ts tenant-a stub-user)" \
  http://localhost:4000/support/conversations/1
curl -H "Authorization: Bearer $(npx tsx scripts/issue-test-session.ts tenant-b tenantb-admin)" \
  http://localhost:4000/support/conversations/1
```

**Webhooks**: registered separately per tenant/account against the gateway - if webhooks stop
arriving after a Chatwoot restart or a new tenant is added, check
`services/support-gateway/README.md`'s webhook section for the registration command and the
per-tenant-secret requirement.

## 7. What's implemented vs. still a stand-in

Full detail in `services/support-gateway/README.md` and `services/support-gateway/test/known-gaps.test.ts` (the latter
is the authoritative, always-current list - it shows up in every `npm test` run). As of this
writing: the full read/write/create conversation API, webhooks with signature verification,
tenant isolation, session-based auth, durable dedup + on-demand/scheduled reconciliation
(including post-restore pruning), idempotent writes, a circuit breaker + rate limiter on
Chatwoot calls, realtime (SSE) publication, a verified backup/restore procedure for both
Chatwoot's Postgres and the gateway's SQLite store, and a verified staging-upgrade procedure
are all built and verified live. **Not production-ready per the spec's own gate (section 20)**:
email threading is untested, no Platform API provisioning route or observability layer exists,
rate limiting isn't per-tenant, and the license-boundary/SBOM review hasn't happened - see the
todo list for the full, current set (18 items as of 2026-07-22). Real product auth (replacing
the test-minted sessions in
section 6) is your in-house app's responsibility, not something built here.

## 8. Backup & restore

Full runbook: `BACKUP_RESTORE.md` at the repo root - covers both Chatwoot's Postgres database
and the gateway's own SQLite store, with the exact commands to back up and restore each, why
each step matters, and two real gotchas found by actually running the procedure (not just
written from documentation): reconciliation needed a fix to notice conversations that vanish
entirely after a restore, and a SQLite restore can be silently undone by leftover `-wal`/`-shm`
files from an unclean shutdown if you don't remove them first. Read that doc before doing either
for real, especially the restore side - it's destructive to whatever's currently live.

## 9. Testing a Chatwoot version upgrade

Full runbook: `UPGRADE_TESTING.md` at the repo root, plus `docker-compose.staging.yaml` - spins
up a completely separate, isolated Chatwoot stack (its own ports/volumes/project name) for
testing a real version bump without touching this real dev/test instance. Already run once for
real: upgraded from v4.15.1-ce to v4.16.0-ce (the version this instance actually runs), with
real migrations and real data carried across, and the full gateway suite passed both before and
after. Reuse the same isolated stack for the next version bump rather than testing an upgrade
against this real instance directly.
