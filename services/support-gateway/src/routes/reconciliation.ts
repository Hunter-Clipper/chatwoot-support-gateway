import { Router } from 'express';
import type { ReconciliationService } from '../reconciliation/reconciliation-service.js';
import type { SupportAuthorizationService } from '../auth/authorization-service.js';
import { bearerToken } from '../auth/bearer-token.js';

// Appendix A.1: POST /internal/support/reconciliation. Real ops tooling (a cron job, an admin
// action) would likely authenticate this with a service credential rather than a user session -
// reusing SupportAuthorizationService here is a simplification, not a claim that reconciliation
// should be "acting as an agent."
export function reconciliationRouter(service: ReconciliationService, authz: SupportAuthorizationService): Router {
  const router = Router();

  router.post('/internal/support/reconciliation', async (req, res, next) => {
    try {
      const context = authz.verifySession(bearerToken(req));
      const result = await service.reconcile(context);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
