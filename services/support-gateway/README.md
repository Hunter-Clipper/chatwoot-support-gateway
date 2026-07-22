# Support Gateway

Proprietary Node.js boundary between an existing in-house React/Next.js product and Chatwoot
CE. See `../../Chatwoot_Headless_Integration_Specification.docx` for the full architecture
decision - that in-house app is the real consumer of this API and isn't something built in
this repo. (A throwaway Next.js test harness was built and later removed during development,
purely to prove this API works from a real UI consumer rather than curl alone - not part of
the deliverable.)

Everything below this point was, until recently, verified only through manual one-off curl
sessions. A real automated contract/integration test suite now exists - see `test/README.md`.
Run it with `npm test` before trusting any of the "verified live" claims below still hold after
a change.

## Run it

```
npm install
cp .env.example .env   # fill in CHATWOOT_API_TOKEN and CHATWOOT_WEBHOOK_SECRETS
npm run dev
```

To receive real webhooks, register one **per Chatwoot account/tenant** pointing at this
gateway - each account gets its own independently-generated secret, so the URL is
tenant-scoped and the secret goes into `CHATWOOT_WEBHOOK_SECRETS` under that same tenantId:

```
POST /api/v1/accounts/{accountId}/webhooks
{"webhook": {"name": "support-gateway",
             "url": "http://host.docker.internal:4000/internal/support/chatwoot/webhooks/{tenantId}",
             "subscriptions": ["conversation_created", "conversation_updated", "conversation_status_changed", "message_created"]}}
```

The response includes the `secret` - add it to `CHATWOOT_WEBHOOK_SECRETS` as
`"{tenantId}": "<secret>"`. Repeat per tenant/account - see the webhook bullet below for why a
single shared secret doesn't work here.

Every `/support/conversations/*` route requires a session token. Mint one for testing (never
used by real server code):

```
npx tsx scripts/issue-test-session.ts <tenantId> <actingUserId> [expiresIn=15m]
curl -H "Authorization: Bearer $(npx tsx scripts/issue-test-session.ts tenant-a stub-user)" \
  http://localhost:4000/support/conversations
```

`tenantId` must be a key in `CHATWOOT_TENANT_ACCOUNTS` and `actingUserId` a key in
`CHATWOOT_AGENT_TOKENS`.

## What's implemented

- `GET /healthz`, `GET /readyz` (pings Chatwoot)
- `GET /support/conversations`, `GET /support/conversations/:id`, `GET /support/conversations/:id/messages`
  (Appendix A.1 routes, read-only slice)
- `SupportProvider` interface (spec 11.1) backed by `ChatwootSupportProvider`, so the UI layer
  never touches Chatwoot's raw shapes
- Appendix A.2 error translation (401/403/404/409/429/5xx -> typed `SupportProviderError` codes)
- Per-agent token resolution via `ProviderIdentityService` (spec 16.1, 7), backed by
  `CHATWOOT_AGENT_TOKENS` - a JSON map of `actingUserId -> Chatwoot personal access token`.
  The acting agent is provisioned through Chatwoot's real Platform API (spec 6.2): a
  `PlatformApp` created a second user, added them to account 1 as `agent` via
  `platform/api/v1/accounts/:id/account_users`, and their token came back directly from the
  create call (also independently confirmed via `platform/api/v1/users/:id/token`). Verified
  live: replies sent as different acting users attribute to the correct, different Chatwoot
  agent; an unregistered acting user is rejected by the gateway itself before any Chatwoot
  call is made.

  This is still a flat-file stand-in for the real design (spec 7.1/7.4: encrypted storage,
  rotation, revocation) - but `actingUserId` itself now comes from a verified session token,
  not a trusted header (see `SupportAuthorizationService` below).

  **Real finding along the way, not a bug:** a newly provisioned agent's token was rejected
  by Chatwoot ("You are not authorized to do this action") until they were explicitly added
  as a member of the target inbox (`POST /api/v1/accounts/:id/inbox_members`) - account
  membership with an `agent` role alone isn't sufficient. `ConversationPolicy` only grants
  access via `administrator?`, inbox membership, or team membership. Any real provisioning
  flow needs to add new agents to their relevant inbox(es), not just the account.
- `POST /internal/support/chatwoot/webhooks/:tenantId` - verifies the raw-body HMAC-SHA256
  signature and timestamp freshness (spec 10.2 steps 1-4) via `WebhookVerifier`, then dedupes
  by `X-Chatwoot-Delivery` and processes synchronously via `WebhookProcessor`. Verified
  end-to-end against this instance: valid signature accepted, tampered body rejected (401),
  stale timestamp rejected (401), replayed delivery flagged as duplicate.

  **Real finding, discovered while testing the second tenant:** each Chatwoot account's
  Webhook record gets its own independently-generated secret (`has_secure_token`, not
  something you can pin to a shared value) - a single global secret verified account 1's
  deliveries fine and would have silently rejected every other account's as a signature
  mismatch. Fixed by parameterizing the route with `:tenantId` and looking up that tenant's
  secret from `CHATWOOT_WEBHOOK_SECRETS` - the tenantId comes from the URL Chatwoot was
  configured with, never trusted from the (unverified-until-checked) request body.
- `POST /support/conversations/:id/replies` and `/notes` - `sendReply`/`createPrivateNote`,
  both backed by the same Chatwoot message-create endpoint with `private` toggled. Verified
  live: a public reply and a private note both post successfully with the correct `private`
  flag in the response, each independently triggers its own signed `message_created` webhook
  back to this gateway (full write -> push loop), invalid/empty content is rejected with 400,
  and a nonexistent conversation id 404s.
- `PATCH /support/conversations/:id/status`, `/assignment`, `/labels` - `setStatus`/`assign`/
  `updateLabels`, all returning 204 per the `SupportProvider` interface (no response body to
  map). Verified live and cross-checked directly against Chatwoot's own conversation record
  (not just the gateway's response): status transitions, agent assignment, and labels all
  actually persisted. Invalid status enum and an empty assignment (`{}`, which Chatwoot itself
  would silently no-op rather than error on) are both rejected with 400 at the gateway boundary.

  `SupportProvider` is now fully implemented end to end.
- Idempotent writes (spec 18.2: "a timed-out write does not create a duplicate message when
  retried") via an optional `Idempotency-Key` header on `/replies` and `/notes`
  (`withIdempotency`, `IdempotencyStore`, same SQLite-backed pattern as webhook dedup). No
  header -> unchanged behavior, every call executes. Same key + same body -> the first
  response is replayed, Chatwoot is never called a second time. Same key + a *different* body
  -> `409 SUPPORT_STATE_CONFLICT`, since silently picking one would hide a real client bug.
  Covered by real tests (`test/idempotency.test.ts`), not just a todo - including a caught
  mistake worth noting: the first test run showed 2 failures because the running gateway
  process turned out to be a stale one-shot `tsx` process from hours earlier, never restarted
  after the code changed, so it had no idea the new database table existed. Restarting it
  fixed it - a reminder that "the process responds to /healthz" only proves it's *running*,
  not that it's running the *current* code.
- `POST /support/conversations` (ticket creation) - not in Appendix A.1 originally (every
  conversation was assumed to originate from inbound email/widget), but confirmed as a real
  future requirement: the in-house app will eventually need to originate a ticket itself, not
  just act on ones email/chat already created. Takes `{content, contact: {name, email}}`,
  resolves the contact by searching Chatwoot for an existing one by email before creating a new
  one (so repeat customers don't get a fresh contact record per ticket), then creates the
  conversation against a new per-tenant `CHATWOOT_TENANT_DEFAULT_INBOX` config entry - ticket
  creation has no natural inbox of its own the way an inbound message does, so every tenant
  needs one nominated. Wrapped in the same `withIdempotency` helper as `/replies`/`/notes`, for
  the same reason: a client retrying a timed-out "create ticket" call should get the same
  ticket back, not a duplicate.

  Verified live for both tenants (`test/ticket-creation.test.ts`): creates against the correct
  tenant-specific inbox, a second ticket from the same contact email reuses the existing
  contact rather than creating a duplicate, idempotent retry returns the same conversation,
  same key with a different body 409s, and invalid/missing contact info is rejected with 400.

  **Real bug found and fixed in this pass:** a created conversation's first message defaults to
  `message_type: outgoing` (as if written by an agent), not `incoming`. On a real
  `Channel::Email` inbox that triggers an actual outbound SMTP send - and in this environment
  the same real mailbox is used for both sending and the IMAP polling that creates tickets, so
  a bounce for a fake/test contact address comes right back in as a brand-new "undeliverable"
  ticket. `CHATWOOT_TENANT_DEFAULT_INBOX` must point at a `Channel::Api` inbox (never a real
  email/widget inbox) - see `TESTING_GUIDE.md` section 3/4 for the dedicated test inbox this
  led to creating.
- Circuit breaker around every Chatwoot call (spec 5.3's availability table, Appendix B),
  `src/providers/chatwoot/circuit-breaker.ts`. Closed/open/half-open states; only a thrown
  network error/timeout or a 5xx counts as a failure - a 404/401/403/409 means Chatwoot is up
  and answering correctly, so those don't trip it. After 3 consecutive real failures it opens
  and fails every call immediately (`SUPPORT_PROVIDER_UNAVAILABLE`) without touching the
  network, for a cooldown period; then lets one trial request through to detect recovery.
  Verified two ways: pure unit tests of the state machine (no network), and pointing a real
  `ChatwootClient` at an unreachable host - after tripping, a call that would otherwise wait
  out the 5-second request timeout instead fails in single-digit milliseconds
  (`test/circuit-breaker.test.ts`).
- Rate limiting on the gateway itself (spec Appendix B - the other half of the "rate limits and
  circuit breakers" line), `src/middleware/rate-limiter.ts`. Fixed-window counter, in-memory,
  keyed by client IP (`RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS`, defaults 60s / 600
  requests), mounted globally ahead of every `/support/*` and `/internal/support/*` route -
  `/healthz`/`/readyz` are mounted before it so orchestration/monitoring polling never counts
  against it. Over the limit, returns `429 {"code": "GATEWAY_RATE_LIMITED"}` plus a
  `Retry-After` header, matching the same `{code, message}` error shape as everything else in
  Appendix A.2.

  Deliberate scope choice, not an oversight: this is keyed by IP rather than by tenant/session,
  because every caller here is expected to be your in-house app's own backend, not individual
  end-user browsers - so it protects the gateway process as a whole from a runaway or
  misbehaving caller, the same role Chatwoot's own Rack::Attack plays for it. Per-tenant limits
  would need this to run *after* `SupportAuthorizationService.verifySession()`, which currently
  happens inside each route handler, not in shared app-level middleware - revisit if per-tenant
  quotas become a real requirement.

  Verified with `test/rate-limiter.test.ts`: pure unit tests of the counter itself, plus a
  throwaway Express app + limiter instance spun up just for that test (not the real gateway's
  shared limiter instance) to confirm the middleware wiring and 429 response shape. Deliberately
  isolated from the live stack - the real gateway's limiter is one shared instance across this
  entire test run (`fileParallelism: false`), so a test that tripped it for real would have
  risked 429ing every other test file that ran afterward.
- Tenant-to-account resolution via `TenantService` (spec 8.1, 15.1), backed by
  `CHATWOOT_TENANT_ACCOUNTS` - a JSON map of `tenantId -> Chatwoot account_id`. `ChatwootClient`
  now takes `accountId` as a required per-call argument (same pattern as the token) instead of
  one fixed global account.

  This matters more than it sounds: Chatwoot's conversation/contact `id` in the API is
  actually the per-account `display_id`, not the global database primary key - confirmed
  directly against this instance's DB (two different conversations, global ids 1 and 4, both
  show up as `"id": 1` in their respective accounts' JSON). So resolving the wrong account for
  a tenant doesn't 404, it silently returns a *different tenant's* data under an id that looks
  valid. Verified live with a second real Chatwoot account (created via Platform API, its own
  admin, inbox, and conversation): `conversation 1` under `tenant-a` and `conversation 1` under
  `tenant-b` return two genuinely different customers' data; an unmapped tenant is rejected
  (403) rather than falling back to a default account; and a mismatched pairing (tenant-b's
  account with an agent who only belongs to account 1) is independently rejected by Chatwoot's
  own account-membership check - a real defense-in-depth property, not something this gateway
  had to build itself.
- `SupportAuthorizationService` (spec 16.1, 15.1): every route now derives its
  `RequestContext` from a signed session token (`Authorization: Bearer <token>`, HS256,
  verified against `SESSION_SIGNING_SECRET`) instead of trusted `X-Tenant-Id`/
  `X-Acting-User-Id` headers - that stand-in has been retired, not layered under this one.
  Session **issuance** is deliberately kept out of server code entirely
  (`scripts/issue-test-session.ts`, a standalone script, never imported by `server.ts`) -
  in the real architecture, issuing sessions is the product's own login flow, not something
  the gateway does; the gateway's only job is verification. Verified live: no
  `Authorization` header rejected (401), a valid session works end-to-end, a tampered token
  is rejected with "invalid signature," an expired token (1s TTL) is rejected with "jwt
  expired," and switching the session's `tenantId` alone correctly switches which Chatwoot
  account is reached, consistent with the tenant-isolation testing above.
- Durable webhook dedup + local read model + reconciliation (spec 10.3, 12.2), backed by
  SQLite (`data/gateway.sqlite`, see `src/store/`). `WebhookDeliveryStore` replaces the
  earlier in-memory dedup Map; `LocalConversationStore` is a minimal mirror of conversation
  state (status/subject/last_activity_at), kept current by `WebhookProcessor` and repaired by
  the new `ReconciliationService` (`POST /internal/support/reconciliation`, Appendix A).

  Verified with two acceptance-test-style scenarios, not just unit-level checks:
  - **Restart durability:** sent a real reply, captured its webhook's delivery id, killed the
    gateway process entirely, started a brand-new process (no shared memory with the old
    one), and replayed a validly-signed payload with that same delivery id - correctly
    flagged as a duplicate, proving dedup state survives a real process restart, not just
    surviving within one process's lifetime.
  - **Reconciliation repairs a genuinely missed webhook:** killed the gateway, changed a
    conversation's status directly via Chatwoot's API (bypassing the gateway entirely), and
    confirmed in Sidekiq's logs that the resulting webhook delivery failed with connection
    refused and was never retried (account-level webhooks don't retry on network failure,
    unlike agent-bot webhooks). Restarted the gateway - the local read model still showed the
    stale status. Called reconciliation - it correctly repaired conversation 1 to the live
    `resolved` status and picked up two other conversations it had never seen before.

  **Real bug found and fixed in this pass, not a Chatwoot quirk:** the first reconciliation
  attempt returned `{checked: 0, repaired: 0}` even though the drift was real. Cause:
  Chatwoot's conversation list defaults to `status=open` when no filter is given
  (`conversation_finder.rb`: `DEFAULT_STATUS = 'open'`) - so a conversation that had left the
  open state (like the one being tested) was invisible to `listConversations(context, {})`.
  Fixed by having `ReconciliationService` explicitly request `status: 'all'`. Worth noting
  because it's exactly the kind of undocumented-default bug spec section 19's "Undocumented
  API behavior" risk is about, and it would have made reconciliation silently useless for
  its most important case (a conversation getting resolved without the gateway hearing about it).

  Still not real: true async queueing (spec 12.2's "Event queue," at-least-once with
  idempotent consumers) - events are still processed synchronously inline in the HTTP
  request, not handed to a worker.
- Scheduled reconciliation (Appendix B - the other half of the "reconciliation" line, the
  on-demand route above was the first half), `src/reconciliation/reconciliation-scheduler.ts`.
  Runs once immediately on startup (so a fresh deploy is caught up right away) and then every
  `RECONCILIATION_INTERVAL_MS` (default 5 minutes; 0 disables it, on-demand still works), once
  per tenant listed in `CHATWOOT_RECONCILIATION_ACTORS` - a JSON map of
  `tenantId -> actingUserId`, since reconciliation needs to run "as" someone with a valid
  Chatwoot token, and there's no separate service-credential concept yet (same acknowledged
  shortcut as agent tokens generally, spec 7.4). One tenant's failure doesn't stop the others
  reconciling in the same tick; a tenant with no entry there is just skipped, not an error.

  Verified live: startup logs show both configured tenants actually reconciling
  (`scheduled reconciliation for tenant-a: checked 22, repaired 0`), confirming the map and
  timer are wired to the real service, not just unit-tested against a stub. The stub-based
  control-flow tests (`test/reconciliation-scheduler.test.ts`) cover immediate + interval
  firing, per-tenant error isolation, and `stop()` halting further runs; a separate real-service
  test (`test/reconciliation.test.ts`) proves the wiring end to end via a single direct
  `runOnce()` call - deliberately never `start()` against the live suite, since a real interval
  left running would keep firing after the test file finishes.
- Backup/restore, for both Chatwoot's Postgres and the gateway's own SQLite store (spec 18.2,
  Appendix B). Full runbook: `BACKUP_RESTORE.md` at the repo root - both procedures were
  actually run against this environment, not just written from documentation.

  **Two real findings from actually running it, both now fixed:**
  - Reconciliation didn't originally notice a conversation that vanished *entirely* after a
    restore (as opposed to one that merely changed status) - it only ever updated rows for
    conversations Chatwoot's current listing still returned. Fixed: reconciliation now prunes
    any local row not present in the current page, added as a `pruned` field on
    `ReconciliationResult` alongside `checked`/`repaired`. Real test:
    `test/reconciliation.test.ts` ("prunes a local row for a conversation that no longer
    exists at the provider").
  - Restoring the gateway's SQLite file without first removing leftover `-wal`/`-shm` files
    (left behind by a `kill -9`'d process, which never gets to checkpoint) silently undoes the
    restore - SQLite transparently replays the stale WAL on top of the restored file. Caught
    live: a restore appeared to do nothing until the leftover WAL/SHM files were removed first.
    See `BACKUP_RESTORE.md` section 2, Finding #1.

  Also verified live: a replayed pre-restore webhook delivery ID is still correctly flagged as
  a duplicate after a full SQLite backup/restore cycle - proving historical dedup records
  genuinely survive, not just that the table still exists.
- Staging upgrade testing (spec 18.2: "a staging upgrade passes the full contract suite before
  production rollout"). Full runbook: `UPGRADE_TESTING.md` at the repo root, plus
  `docker-compose.staging.yaml` - a completely isolated second Chatwoot stack (own project name,
  ports, volumes) for exercising a real version bump without touching the real dev/test
  instance.

  **Actually run once, for real:** v4.16.0-ce (the version pinned in `docker-compose.yaml`)
  turned out to already be the latest published `-ce` release, so this drill upgraded from the
  immediately prior release (v4.15.1-ce) instead - a realistic one-version-back scenario landing
  on the exact version this environment runs today. Created two tenants' worth of real data on
  the older version, ran the full gateway suite against it (55/55 passed - a clean baseline),
  upgraded in place (`rails db:migrate` did run real migrations - new tables for data-import
  mappings, agent sessions, Captain FAQ suggestions, among others), confirmed the pre-upgrade
  data survived intact, then reran the full suite against the upgraded instance (55/55 passed
  again). The isolated stack was torn down afterward - it's reusable infrastructure for the next
  drill, not something left running.
- `SupportRealtimePublisher` (spec 16.1) via Server-Sent Events at `GET /support/realtime`
  (SSE chosen over WebSocket for simplicity - plain HTTP, no upgrade handshake, testable with
  curl). Subscriptions are keyed by Chatwoot `account_id`, resolved from the session's
  `tenantId` at connect time via `TenantService` - the same tenant isolation built earlier
  applies here too. `WebhookProcessor` publishes to subscribers as real events arrive.

  Verified live with two concurrent SSE clients, one per tenant: an event triggered on
  tenant-a's account reached only tenant-a's stream; a second event triggered on tenant-b's
  account (after registering that account's own webhook - see below) reached only tenant-b's
  stream. Neither stream received the other's event.

  In-memory only: connections and subscriptions don't survive a gateway restart, same as any
  bare SSE/WebSocket server without a backing broker (Redis pub/sub, etc.) - out of scope here.

## Deliberately not implemented yet

Authoritative, always-current list: `test/known-gaps.test.ts` (shows up as `test.todo()`
entries in every `npm test` run). As of this writing that covers: attachments and priority
(Appendix A's route table lists them but spec 11.1's `SupportProvider` interface doesn't, so
they're out of scope for this pass), email threading (never tested), audit records,
ticket-linkage mapping, license/SBOM review, token encryption/rotation, Platform API
provisioning (never built as a gateway route - done ad-hoc via `rails runner` throughout this
project instead), Platform App token isolation, observability/correlation IDs, per-user/
per-tenant rate limiting (only IP-based exists), Redis/worker monitoring, object storage
privacy, data retention policy, rollback-specifically testing, and incident response ownership.

That last batch (from "Platform API provisioning" onward) was added after a full line-by-line
pass against Appendix B's checklist and spec sections 12.4/15.1 - the original list was checked
carefully against section 18's acceptance plan but not against the *entire* document, and
several real gaps had gone untracked as a result. Lesson worth keeping: "checked against the
spec" needs to mean the whole document's checklists, not just the one section most recently
discussed. **None of this is production-ready per the spec's own gate (section 20)** until that
list is empty.

## Known trust-boundary shortcuts

- `ChatwootClient` sends `X-Forwarded-Proto: https` on every request so Chatwoot's `FORCE_SSL`
  doesn't redirect internal calls to a TLS port that doesn't exist locally. This is only valid
  because the gateway calls Chatwoot over a private network the browser never reaches - if that
  stops being true, this needs a real internal-only Chatwoot origin instead.
- Chatwoot's `.env` now has `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true`. Chatwoot blocks outbound
  webhook/fetch requests to private IPs by default (SSRF protection) - required here since the
  gateway currently runs on the host machine at `host.docker.internal`, a private address.
  **This is an app-wide relaxation, not scoped to our one webhook URL.** It's acceptable now
  because only administrators can register webhook URLs on this instance. If this Chatwoot
  instance is ever exposed to untrusted users who can register their own webhook URLs, this
  needs to be turned back off and the gateway given a real non-private address instead.
- `SESSION_SIGNING_SECRET` is shared between this gateway and `scripts/issue-test-session.ts`
  purely so tests can mint tokens the gateway will accept. In the real architecture this
  secret (or a JWKS-based public-key equivalent) is owned by the product's own auth system;
  the gateway only ever verifies, never issues.
