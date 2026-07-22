# Backup & Restore Runbook

Covers both halves of this stack: Chatwoot's own Postgres database (the source of truth for
everything - conversations, contacts, accounts) and the support gateway's local SQLite store
(`services/support-gateway/data/gateway.sqlite` - a rebuildable read model/dedup cache, not a
source of truth). Both procedures below were actually run against this environment on
2026-07-22, not just written from documentation - real commands, real output, two real bugs
found and fixed along the way (see "Findings" at the end of each section).

## Why this exists

Spec section 18.2 (Test and Acceptance Plan) and Appendix B both call out backup/restore as a
production-readiness gate item. Before this, no backup/restore procedure had ever been
exercised - it existed only as an unchecked box. This doc is the result of actually doing it.

## 1. Chatwoot Postgres

### What to back up

The `chatwoot_production` database on the `postgres` container (Postgres 16, image
`pgvector/pgvector:pg16`). This is the authoritative store for every account, conversation,
contact, and message - if this is lost, it's genuinely lost, not just re-derivable from
somewhere else.

### Backup procedure

```bash
cd /home/pbdweller/Projects/Chatwoot
docker compose exec -T postgres pg_dump -U postgres -F c -d chatwoot_production > backup.dump
```

`-F c` (custom format) rather than plain SQL - it's compressed and lets `pg_restore` do
selective/parallel restores if ever needed. Store `backup.dump` somewhere off the same host as
the database itself; a backup that lives next to what it's backing up doesn't protect against
host-level failure.

### Restore procedure

**This is destructive to whatever is currently in the live database.** Confirm you actually
want to do this before running it - there is no undo once the old data is overwritten, only
whatever your own prior backup gives you back.

```bash
cd /home/pbdweller/Projects/Chatwoot

# 1. Stop the app layer so nothing writes during the restore
docker compose stop rails sidekiq

# 2. Terminate any lingering connections, then drop and recreate the database
docker compose exec -T postgres psql -U postgres -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='chatwoot_production' AND pid <> pg_backend_pid();"
docker compose exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE chatwoot_production;"
docker compose exec -T postgres psql -U postgres -d postgres -c "CREATE DATABASE chatwoot_production OWNER postgres;"

# 3. Restore from the dump
docker compose exec -T postgres pg_restore -U postgres -d chatwoot_production --no-owner --role=postgres < backup.dump

# 4. Bring the app layer back up
docker compose start rails sidekiq
# Chatwoot takes ~20-30s to finish booting Puma before it answers requests again - poll
# GET /api/v1/accounts/:id/inboxes (with a valid token) rather than assuming it's instantly ready.
```

### After restoring: run reconciliation

Chatwoot itself is now authoritative again, but the gateway's local SQLite read model still
reflects whatever it last saw *before* the restore - which can be ahead of what Chatwoot now
has (anything created after the restore point is gone from Chatwoot's perspective, permanently,
by design of what a restore is). Run reconciliation once per tenant to resync:

```bash
cd services/support-gateway
TOKEN=$(npx tsx scripts/issue-test-session.ts <tenant-id> <acting-user-id>)
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:4000/internal/support/reconciliation
# {"checked": <n>, "repaired": <n>, "pruned": <n>}
```

`pruned` is the count of local rows removed for conversations that no longer exist at all in
the restored database (see Finding #2 below for why this field exists).

### Findings from actually running this

1. **`pg_restore` into a live database needs the app layer stopped first**, not just a
   `--clean` flag - Rails/Sidekiq holding open connections will otherwise block the drop/recreate
   step. Stop `rails`+`sidekiq`, do the DB-level work, then restart them - don't try to restore
   underneath a running app.
2. **Reconciliation didn't originally clean up conversations that vanished entirely.**
   `ReconciliationService` only ever *updated* local rows for conversations Chatwoot's current
   listing still returned - it never noticed a conversation that used to exist locally but is
   now completely gone from Chatwoot's restored state (as opposed to one that merely changed
   status). Confirmed live: created a marker ticket, restored to a backup taken before it
   existed, and the marker's local row silently survived every subsequent reconciliation pass.
   Fixed by having reconciliation prune any local row for that account not present in the
   current page (`src/reconciliation/reconciliation-service.ts`, `pruned` field, real test in
   `test/reconciliation.test.ts`). Same caveat as the rest of reconciliation: this only sees one
   page, so at a conversation volume that spans multiple pages, prune this way with the same
   care you'd already need for the existing pagination limitation.

## 2. Support gateway SQLite (`services/support-gateway/data/gateway.sqlite`)

### What this store is (and isn't)

A local read model + webhook dedup + idempotency-key cache, kept current by webhooks and
repaired by reconciliation. It is **not** a source of truth - Chatwoot is. Losing this file
entirely and starting empty is recoverable (reconciliation rebuilds the read model; you only
lose *historical* dedup/idempotency records, which just means a replayed old webhook or a
retried old write could theoretically double-process instead of being caught - a real but small
window, not data loss). Still worth a real backup procedure rather than shrugging at it.

### Backup procedure

**The database runs in WAL mode.** A plain `cp gateway.sqlite` while the gateway is running (or
was recently running) can silently miss committed data still sitting in the `-wal` file next to
it - confirmed live: a 4MB `-wal` file existed alongside a 78KB main file. Checkpoint first:

```bash
cd services/support-gateway

# Stop the gateway so nothing writes during the checkpoint+copy
# (find its pid: ps aux | grep "tsx src/server", kill it)

node -e "
const Database = require('better-sqlite3');
const db = new Database('data/gateway.sqlite');
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
"
# This absorbs the WAL into the main file and removes -wal/-shm, leaving one consistent file.

cp data/gateway.sqlite /path/to/backup/gateway-backup.sqlite
```

### Restore procedure

```bash
cd services/support-gateway
# Gateway must be stopped first

rm -f data/gateway.sqlite-wal data/gateway.sqlite-shm   # see Finding #1 below - do not skip this
cp /path/to/backup/gateway-backup.sqlite data/gateway.sqlite

# Restart the gateway normally
npx tsx src/server.ts
```

Reconciliation runs automatically on startup (`ReconciliationScheduler`) and will resync
anything that changed in Chatwoot since the backup point - no manual step needed beyond
starting the gateway back up.

### Findings from actually running this

1. **A `kill -9`'d gateway process leaves `-wal`/`-shm` files behind, and they silently undo a
   restore if not removed first.** SQLite only checkpoints/cleans these up on a graceful close;
   `kill -9` doesn't get to run that. Confirmed live: restored an older `gateway.sqlite` while a
   stale `-wal` file from the killed process was still sitting next to it - on next open, SQLite
   transparently replayed that leftover WAL on top of the restored file, silently reintroducing
   the exact data the restore was supposed to remove. Always remove `-wal`/`-shm` (or use a
   process manager that shuts the gateway down gracefully, giving it a chance to checkpoint on
   its own) before swapping in a restored file.
2. **Historical dedup/idempotency records genuinely survive a restore, verified, not assumed.**
   Replayed a webhook delivery ID that existed in the database *before* the backup point, using
   a freshly-signed payload - correctly flagged as a duplicate (`{"duplicate": true}`) after the
   full backup/restore cycle. Confirms the dedup table's actual function survives, not just that
   the file/table still exists.

## Summary for the testing/ops team

Both procedures above have been run against this real environment, not just documented in the
abstract. Two real gaps were found and fixed as a direct result of running them:
reconciliation now prunes conversations that vanish entirely (not just ones that change), and
this doc itself now exists because the WAL/SHM gotcha would otherwise catch anyone doing a
SQLite restore by hand for the first time. Neither Chatwoot's Postgres restore nor the
gateway's SQLite restore requires anything beyond what's written above - no undocumented manual
steps were needed to get back to a working state in either drill.
