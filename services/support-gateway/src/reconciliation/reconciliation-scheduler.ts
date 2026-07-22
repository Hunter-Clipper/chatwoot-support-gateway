import type { ReconciliationResult, ReconciliationService } from './reconciliation-service.js';

export interface ReconciliationLogger {
  info(message: string): void;
  error(message: string, error: unknown): void;
}

const consoleLogger: ReconciliationLogger = {
  info: (message) => console.log(message),
  error: (message, error) => console.error(message, error),
};

export type ReconciliationRunResult = Record<string, ReconciliationResult | { error: string }>;

// Appendix B: "reconciliation scheduled periodically" - previously only reachable via the
// on-demand POST /internal/support/reconciliation route. Runs once immediately on start() (so
// a fresh deploy is caught up right away) and then every intervalMs, once per configured
// tenant. One tenant's failure doesn't stop the others from reconciling in the same tick.
//
// Each tenant needs an actingUserId to reconcile "as" - the same acknowledged shortcut spec 7.4
// already flags for agent tokens generally (a real service credential belongs here eventually,
// not a borrowed personal agent token). Configured via CHATWOOT_RECONCILIATION_ACTORS; a tenant
// missing an entry there is silently skipped by the scheduler, not an error - it's just not
// opted into scheduled reconciliation yet, and remains reachable via the on-demand route.
export class ReconciliationScheduler {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly service: Pick<ReconciliationService, 'reconcile'>,
    private readonly tenantActors: Record<string, string>,
    private readonly intervalMs: number,
    private readonly logger: ReconciliationLogger = consoleLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<ReconciliationRunResult> {
    const results: ReconciliationRunResult = {};
    for (const [tenantId, actingUserId] of Object.entries(this.tenantActors)) {
      try {
        const result = await this.service.reconcile({ tenantId, actingUserId });
        results[tenantId] = result;
        this.logger.info(`scheduled reconciliation for ${tenantId}: checked ${result.checked}, repaired ${result.repaired}, pruned ${result.pruned}`);
      } catch (error) {
        results[tenantId] = { error: (error as Error).message };
        this.logger.error(`scheduled reconciliation failed for ${tenantId}`, error);
      }
    }
    return results;
  }
}
