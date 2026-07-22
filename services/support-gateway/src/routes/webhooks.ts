import { Router } from 'express';
import { WebhookVerifier, WebhookSignatureError } from '../webhooks/webhook-verifier.js';
import { WebhookProcessor } from '../webhooks/webhook-processor.js';

// Appendix A.1: POST /internal/support/chatwoot/webhooks/:tenantId.
// Mounted with express.raw() so the body arrives as an untouched Buffer - verification
// needs the exact bytes Chatwoot signed, not a re-serialized JSON.parse/stringify copy.
// :tenantId picks which tenant's webhook secret to verify against (see WebhookVerifier) -
// this comes from the URL Chatwoot was configured with, never trusted from the request body.
export function webhooksRouter(verifier: WebhookVerifier, processor: WebhookProcessor): Router {
  const router = Router();

  router.post(
    '/internal/support/chatwoot/webhooks/:tenantId',
    (req, res) => {
      const rawBody = req.body as Buffer;

      try {
        verifier.verify(rawBody, req.header('X-Chatwoot-Timestamp'), req.header('X-Chatwoot-Signature'), req.params.tenantId);
      } catch (error) {
        if (error instanceof WebhookSignatureError) {
          res.status(401).json({ code: 'SUPPORT_WEBHOOK_SIGNATURE_INVALID', message: error.message });
          return;
        }
        throw error;
      }

      // Spec section 10.2 step 6-7: persist receipt, return promptly, process from a queue.
      // No durable queue yet - processed synchronously in this skeleton (see README).
      const result = processor.process(rawBody, req.header('X-Chatwoot-Delivery'));
      res.status(200).json({ received: true, duplicate: result.duplicate, event: result.event });
    },
  );

  return router;
}
