import { describe, expect, it, afterEach } from 'vitest';
import { ReconciliationScheduler } from '../src/reconciliation/reconciliation-scheduler.js';
import type { ReconciliationService } from '../src/reconciliation/reconciliation-service.js';

const silentLogger = { info: () => {}, error: () => {} };

// Pure unit tests against a stub service, like circuit-breaker.test.ts and
// rate-limiter.test.ts - no live stack required. The real-provider path is covered separately
// in test/reconciliation.test.ts (single on-demand call) and below via one direct runOnce()
// against the real ReconciliationService, never via start()'s live interval.
describe('ReconciliationScheduler (unit)', () => {
  let scheduler: ReconciliationScheduler | undefined;

  afterEach(() => {
    scheduler?.stop();
  });

  it('reconciles every configured tenant on runOnce()', async () => {
    const calls: string[] = [];
    const stub: Pick<ReconciliationService, 'reconcile'> = {
      reconcile: async (context) => {
        calls.push(context.tenantId);
        return { checked: 1, repaired: 0, pruned: 0 };
      },
    };
    scheduler = new ReconciliationScheduler(stub, { 'tenant-a': 'stub-user', 'tenant-b': 'tenantb-admin' }, 10_000, silentLogger);

    const results = await scheduler.runOnce();
    expect(calls.sort()).toEqual(['tenant-a', 'tenant-b']);
    expect(results['tenant-a']).toEqual({ checked: 1, repaired: 0, pruned: 0 });
    expect(results['tenant-b']).toEqual({ checked: 1, repaired: 0, pruned: 0 });
  });

  it('one tenant failing does not stop the others from reconciling in the same tick', async () => {
    const stub: Pick<ReconciliationService, 'reconcile'> = {
      reconcile: async (context) => {
        if (context.tenantId === 'tenant-a') throw new Error('boom');
        return { checked: 3, repaired: 1, pruned: 0 };
      },
    };
    scheduler = new ReconciliationScheduler(stub, { 'tenant-a': 'stub-user', 'tenant-b': 'tenantb-admin' }, 10_000, silentLogger);

    const results = await scheduler.runOnce();
    expect(results['tenant-a']).toEqual({ error: 'boom' });
    expect(results['tenant-b']).toEqual({ checked: 3, repaired: 1, pruned: 0 });
  });

  it('start() reconciles immediately and again after the interval elapses', async () => {
    let callCount = 0;
    const stub: Pick<ReconciliationService, 'reconcile'> = {
      reconcile: async () => {
        callCount += 1;
        return { checked: 0, repaired: 0, pruned: 0 };
      },
    };
    scheduler = new ReconciliationScheduler(stub, { 'tenant-a': 'stub-user' }, 30, silentLogger);

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(callCount).toBe(1); // immediate run, before the interval has even elapsed once

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callCount).toBeGreaterThanOrEqual(2); // interval fired at least once more
  });

  it('stop() halts further scheduled runs', async () => {
    let callCount = 0;
    const stub: Pick<ReconciliationService, 'reconcile'> = {
      reconcile: async () => {
        callCount += 1;
        return { checked: 0, repaired: 0, pruned: 0 };
      },
    };
    scheduler = new ReconciliationScheduler(stub, { 'tenant-a': 'stub-user' }, 20, silentLogger);

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    scheduler.stop();
    const countAtStop = callCount;

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(callCount).toBe(countAtStop); // no further calls after stop()
  });

  it('a tenant with no configured actor is simply skipped, not an error', async () => {
    const stub: Pick<ReconciliationService, 'reconcile'> = { reconcile: async () => ({ checked: 0, repaired: 0, pruned: 0 }) };
    scheduler = new ReconciliationScheduler(stub, {}, 10_000, silentLogger);

    const results = await scheduler.runOnce();
    expect(results).toEqual({});
  });
});
