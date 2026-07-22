import { describe, expect, it } from 'vitest';
import { asTenant } from './helpers.js';
import { config } from '../src/config.js';
import { ChatwootClient } from '../src/providers/chatwoot/chatwoot-client.js';
import { ChatwootSupportProvider } from '../src/providers/chatwoot/chatwoot-provider.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation-service.js';
import { ReconciliationScheduler } from '../src/reconciliation/reconciliation-scheduler.js';
import { LocalConversationStore } from '../src/store/local-conversation-store.js';

// Full acceptance test for "a missed webhook is repaired by reconciliation" (spec 18.2)
// requires killing the gateway process and causing a real missed delivery - not something a
// test run against a live process can orchestrate safely. This is a narrower contract check:
// the endpoint runs, returns the expected shape, and checked >= 0 (it should see at least the
// conversations created by the write-path tests, if those ran first in this suite).
describe('reconciliation', () => {
  it('runs and returns a checked/repaired/pruned count', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', '/internal/support/reconciliation', { method: 'POST' });
    expect(status).toBe(200);
    const parsed = body as { checked: number; repaired: number; pruned: number };
    expect(typeof parsed.checked).toBe('number');
    expect(typeof parsed.repaired).toBe('number');
    expect(typeof parsed.pruned).toBe('number');
    expect(parsed.checked).toBeGreaterThan(0);
  });

  it('rejects reconciliation for an unmapped tenant', async () => {
    const { status } = await asTenant('tenant-nonexistent', 'stub-user', '/internal/support/reconciliation', { method: 'POST' });
    expect(status).toBe(403);
  });

  // Spec 18.2: "a database restore preserves mappings and allows reconciliation to resume."
  // Found via a real backup/restore drill against this instance: restoring Chatwoot's Postgres
  // to an earlier point doesn't just roll back conversations that changed - it can make a
  // conversation the local read model already knows about vanish entirely (anything created
  // after the restore point never existed from Chatwoot's perspective again). The upsert loop
  // above only ever touches ids Chatwoot still returns, so a stale row for a since-vanished
  // conversation would otherwise survive every future reconciliation pass silently. This
  // reproduces that exact scenario without needing a real restore: seed a stale local row
  // pointing at a conversation id real enough to be plausible but that this account will never
  // actually have, and confirm reconciliation removes it.
  it('prunes a local row for a conversation that no longer exists at the provider (post-restore drift)', async () => {
    const accountId = config.chatwootTenantAccounts['tenant-a'];
    const store = new LocalConversationStore();
    const ghostId = 9_999_001; // implausibly high display_id for this account - never real

    store.upsert({
      accountId,
      providerConversationId: ghostId,
      status: 'open',
      subject: null,
      lastActivityAt: Math.floor(Date.now() / 1000),
      syncedAt: Date.now(),
      syncedVia: 'webhook',
    });
    expect(store.get(accountId, ghostId)).toBeDefined();

    const { status, body } = await asTenant('tenant-a', 'stub-user', '/internal/support/reconciliation', { method: 'POST' });
    expect(status).toBe(200);
    const parsed = body as { pruned: number };
    expect(parsed.pruned).toBeGreaterThanOrEqual(1);
    expect(store.get(accountId, ghostId)).toBeUndefined();
  });
});

// Appendix B: "reconciliation scheduled periodically." The scheduler's own control-flow logic
// (immediate + interval runs, per-tenant error isolation) is covered against a stub in
// test/reconciliation-scheduler.test.ts. This proves the real wiring: a real
// ReconciliationService, built from real config (same tenant/agent setup as the rest of this
// suite), actually reconciles both configured tenants when asked - via runOnce() directly,
// never start(), so no live interval is left running against the shared gateway process this
// whole suite talks to.
describe('ReconciliationScheduler wired to the real ReconciliationService', () => {
  it('reconciles every tenant in CHATWOOT_RECONCILIATION_ACTORS in one pass', async () => {
    const provider = new ChatwootSupportProvider(new ChatwootClient());
    const service = new ReconciliationService(provider);
    const scheduler = new ReconciliationScheduler(service, config.chatwootReconciliationActors, 10_000, { info: () => {}, error: () => {} });

    const results = await scheduler.runOnce();

    for (const tenantId of Object.keys(config.chatwootReconciliationActors)) {
      const result = results[tenantId] as { checked: number; repaired: number; pruned: number };
      expect(result).toBeDefined();
      expect(typeof result.checked).toBe('number');
      expect(typeof result.repaired).toBe('number');
      expect(typeof result.pruned).toBe('number');
    }
  });
});
