# Chatwoot Upgrade Testing Runbook

Spec section 18.2 (Test and Acceptance Plan) requires: "a staging upgrade passes the full
contract suite before production rollout." Before this, upgrading the pinned Chatwoot image had
never actually been tried - it existed only as an unchecked box. This doc is the result of
actually doing it, once, for real (2026-07-22), plus the reusable procedure for doing it again.

## What this proves (and what it doesn't)

Proves: a specific version bump doesn't break the gateway's contract with Chatwoot - real data
survives the migration, and every route/webhook/reconciliation behavior the gateway suite
checks still works afterward. Doesn't prove: every future version bump is automatically safe -
run this again for the *next* version you actually want to move to. Treat "we ran this once, on
this version pair" as the standard, not "upgrades are now safe forever."

## The one real drill so far: v4.15.1-ce → v4.16.0-ce

v4.16.0-ce (what's pinned in `docker-compose.yaml`) turned out to already be the latest
published `-ce` release at the time of this test - there was no newer version to upgrade *to*.
So this drill instead proved the upgrade *process* using the immediately prior release as the
starting point (a realistic one-version-back scenario, matching normal ops cadence), landing on
the exact version this environment actually runs today.

**Result: full pass, both before and after.** 55/55 gateway tests passed against a fresh
v4.15.1-ce instance, then 55/55 again after migrating that same instance to v4.16.0-ce with real
data (two conversations, one per simulated tenant) carried across the migration intact.
**Real migrations did run** between these versions (new tables for data-import mappings, agent
sessions, Captain FAQ suggestions, a schema change on `captain_assistants.description`, and
more) - this wasn't a no-op version bump.

## The isolated staging stack

`docker-compose.staging.yaml` + `.env.staging` (repo root) stand up a **completely separate**
Chatwoot instance - its own Postgres/Redis/Rails/Sidekiq, own Docker project name
(`chatwoot-staging`), own volumes, own host ports (3006 for Chatwoot, 5433/6380 for
Postgres/Redis internally). It never touches the real dev/test instance
(`docker-compose.yaml`, ports 3005/5432/6379). No real SMTP is configured in `.env.staging` on
purpose - even if a bug existed, nothing could send a real email from this stack.

### 1. Bring up the staging stack on the CURRENT production version

```bash
cd /home/pbdweller/Projects/Chatwoot
docker compose -p chatwoot-staging -f docker-compose.staging.yaml --env-file .env.staging pull
docker compose -p chatwoot-staging -f docker-compose.staging.yaml --env-file .env.staging up -d
# A stray "base" container may start too (it's just the YAML anchor, not meant to run) -
# stop/remove it: docker compose -p chatwoot-staging -f docker-compose.staging.yaml rm -sf base
```

### 2. First-time database setup (fresh instance, no schema yet)

```bash
docker compose -p chatwoot-staging -f docker-compose.staging.yaml --env-file .env.staging \
  run --rm base bundle exec rails db:chatwoot_prepare
```

### 3. Create real test data - two minimal tenants, mirroring the real dev setup

Via `rails runner`, create an `Account`, an admin `User`, an `AccountUser` linking them, a
`Channel::Api` inbox (not email/widget - no real message delivery risk), and grab the user's
access token. Do this twice (two accounts, to exercise tenant isolation), then register a
webhook on each account pointing at `http://host.docker.internal:<staging-gateway-port>/internal/support/chatwoot/webhooks/<tenant>`
and create one real conversation+message per account as a "does this survive the upgrade"
marker. See the git-free history of this doc's own creation session for the exact Ruby snippets
used, or just reuse the same pattern as any other account/inbox/token setup already documented
in `TESTING_GUIDE.md` section 3.

### 4. Point a second gateway instance at staging

`services/support-gateway/.env.staging` mirrors the real `.env` but targets the staging
instance - different port (4001), `CHATWOOT_BASE_URL=http://localhost:3006`, and the
account ids/tokens/secrets from step 3. Fill in the same `CHATWOOT_AGENT_TOKENS` **key names**
the test suite hardcodes (`stub-user`, `tenantb-admin` as of this writing - check
`grep -rhoE "asTenant\('[^']+', '[^']+'" test/*.ts` for the current list) rather than renaming
tests to fit new names - it's a config-only change, not a code change, for a one-off drill.

```bash
cd services/support-gateway
DOTENV_CONFIG_PATH=.env.staging npx tsx src/server.ts &
```

### 5. Run the full suite against the pre-upgrade version (establish a clean baseline)

```bash
DOTENV_CONFIG_PATH=.env.staging GATEWAY_URL=http://localhost:4001 npx vitest run
```

All tests should pass here first - if they don't, that's a staging-setup problem, not an
upgrade regression. Don't proceed to the actual upgrade until this is clean.

### 6. Perform the upgrade

```bash
cd /home/pbdweller/Projects/Chatwoot
docker compose -p chatwoot-staging -f docker-compose.staging.yaml --env-file .env.staging stop rails sidekiq
# Edit docker-compose.staging.yaml: bump the `base` image tag to the target version
docker compose -p chatwoot-staging -f docker-compose.staging.yaml --env-file .env.staging \
  run --rm base bundle exec rails db:migrate
docker compose -p chatwoot-staging -f docker-compose.staging.yaml --env-file .env.staging up -d rails sidekiq
```

Confirm the new version answers (`curl http://localhost:3006/api`) and that the pre-upgrade
marker conversation(s) from step 3 are still there with the right content before moving on.

### 7. Restart the staging gateway and rerun the full suite

```bash
cd services/support-gateway
# kill the step-4 process first
DOTENV_CONFIG_PATH=.env.staging npx tsx src/server.ts &
DOTENV_CONFIG_PATH=.env.staging GATEWAY_URL=http://localhost:4001 npx vitest run
```

A full pass here is the actual spec 18.2 acceptance criterion. Any failure that wasn't present
in step 5's baseline is a real upgrade regression - investigate before rolling the same version
bump out to the real instance.

### 8. Tear down

This is throwaway verification infrastructure, not something to leave running:

```bash
cd /home/pbdweller/Projects/Chatwoot
docker compose -p chatwoot-staging -f docker-compose.staging.yaml --env-file .env.staging down -v
rm -f services/support-gateway/data/gateway-staging.sqlite
```

`docker-compose.staging.yaml` and both `.env.staging` files are left in place, ready to reuse
for the next upgrade drill - just repeat from step 1 with the then-current production version.
