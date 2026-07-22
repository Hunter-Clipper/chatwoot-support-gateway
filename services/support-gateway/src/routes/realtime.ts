import { Router } from 'express';
import type { SupportAuthorizationService } from '../auth/authorization-service.js';
import { TenantService } from '../auth/tenant-service.js';
import { bearerToken } from '../auth/bearer-token.js';
import type { SupportRealtimePublisher } from '../realtime/realtime-publisher.js';

// Not an Appendix A route (the spec doesn't enumerate a concrete path for
// SupportRealtimePublisher, only the responsibility in section 16.1) - /support/realtime is
// this gateway's own choice, kept under the same /support prefix as the rest of the
// product-facing surface.
export function realtimeRouter(
  publisher: SupportRealtimePublisher,
  authz: SupportAuthorizationService,
  tenants: TenantService = new TenantService(),
): Router {
  const router = Router();

  router.get('/support/realtime', (req, res, next) => {
    let unsubscribe: (() => void) | undefined;
    try {
      const context = authz.verifySession(bearerToken(req));
      const accountId = tenants.getAccountId(context.tenantId);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ event: 'realtime.connected', accountId })}\n\n`);

      unsubscribe = publisher.subscribe(accountId, res);
      req.on('close', () => unsubscribe?.());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
