# Contract / integration test suite

Run with:
```
npm test
```

**Requires the real stack running first** — these are integration/contract tests (spec
sections 18-19: "run contract tests," "a staging upgrade passes the full contract suite"),
not unit tests with mocks. They hit the actual gateway process and the actual Chatwoot
instance:

1. Chatwoot up (`docker compose up -d` from the project root)
2. The gateway running (`npm run dev` in this directory)
3. `.env` filled in with the test tenants/agents documented in `../../TESTING_GUIDE.md`

## What's covered

- `health.test.ts` — healthz/readyz
- `auth.test.ts` — `SupportAuthorizationService`: missing/tampered/expired/unregistered/unmapped
  sessions, and the valid-session happy path
- `conversations-read.test.ts` — list/get/messages, validated against zod contract schemas in
  `contracts.ts` (mirrors `src/domain/types.ts` - this is what catches response-shape drift if
  a future Chatwoot upgrade changes a field the mapper depends on), plus 404 handling
- `conversations-write.test.ts` — reply/note/status/assignment/labels against a **freshly
  created fixture conversation** (not the long-lived manually-tested conversation #1), with
  real invalid-input rejection cases
- `tenant-isolation.test.ts` — the same conversation id returns different data per tenant; a
  mismatched tenant/agent pairing is rejected
- `webhooks.test.ts` — signature verification: valid, replayed (deduped), tampered, stale,
  wrong-secret
- `reconciliation.test.ts` — endpoint runs and returns the expected shape
- `known-gaps.test.ts` — **no assertions, all `test.todo()`**. Every acceptance-plan item from
  spec section 18 / Appendix B that isn't implemented or hasn't been exercised yet, so `npm
  test` output shows them as pending rather than silently absent. Update this file (remove the
  todo, add a real test) as gaps get closed - don't let it go stale.

## What this suite deliberately does NOT do

- Doesn't test the full "gateway restart mid-flight" or "genuinely missed webhook repaired by
  reconciliation" scenarios from spec 18.2 - those require killing/restarting the gateway
  process, which isn't something a test run can safely orchestrate against a shared dev
  instance. Those were verified manually once (see `../README.md`) but aren't automated here.
- Doesn't clean up its fixture data. Each run of `conversations-write.test.ts` creates a new
  contact + conversation in Chatwoot account 1. Fine for a test environment; would need
  teardown or a dedicated ephemeral Chatwoot instance for CI running against shared state.
- Doesn't run against multiple Chatwoot versions. Spec 18.2's "staging upgrade passes the full
  contract suite" means: pull a newer `-ce` tag, point `CHATWOOT_BASE_URL` at it, rerun `npm
  test`, confirm it's still green before rolling the pin forward. Not automated - a manual step
  when upgrading.
