# Chatwoot Support Gateway

Self-hosted Chatwoot CE, deployed as a private communications backend, sitting behind a
proprietary Node.js "support gateway" (`services/support-gateway/`). The gateway is the entire
deliverable in this repo - it's the only thing allowed to call Chatwoot directly. The UI that
actually calls this API is an existing in-house React/Next.js application, not something in
this repo.

Architecture source of truth: `Chatwoot_Headless_Integration_Specification.docx`.

## Start here

**→ [`TESTING_HANDOFF.md`](TESTING_HANDOFF.md)** - what was built, how to run it, a real test
sweep, and everything else worth knowing before testing. This is the one-time orientation doc;
read it first.

## Other docs

| Doc | Use it for |
|---|---|
| [`TESTING_GUIDE.md`](TESTING_GUIDE.md) | The ongoing reference: starting the stack, dashboard testing, multi-tenant test data, known gotchas |
| [`services/support-gateway/README.md`](services/support-gateway/README.md) | Developer-facing detail on every implemented capability, what was verified live, and real bugs found along the way |
| [`services/support-gateway/test/known-gaps.test.ts`](services/support-gateway/test/known-gaps.test.ts) | The authoritative, always-current list of what's *not* done yet - shows up in every `npm test` run |
| [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) | Runbook for backing up/restoring Chatwoot's Postgres and the gateway's SQLite store |
| [`UPGRADE_TESTING.md`](UPGRADE_TESTING.md) | Runbook + isolated staging stack for testing a Chatwoot version upgrade before rolling it out |

## Quick start

```bash
docker compose up -d                        # Chatwoot: Rails + Sidekiq + Postgres + Redis
cd services/support-gateway
cp .env.example .env                        # fill in real values - ask for these, don't guess
npm install
npm test                                    # 55 passing tests, 18 tracked gaps as of writing
npm run dev                                 # starts the gateway on :4000
```

Full detail, including how to mint a test session token and example API calls, is in
`TESTING_HANDOFF.md`.

## Credentials

Real tokens/secrets are never committed here - only `.env.example` templates. If you need real
values, ask whoever set this up rather than guessing at placeholders.
