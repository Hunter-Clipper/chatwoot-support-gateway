import express from 'express';
import { config } from './config.js';
import { ChatwootClient } from './providers/chatwoot/chatwoot-client.js';
import { ChatwootSupportProvider } from './providers/chatwoot/chatwoot-provider.js';
import { healthRouter } from './routes/health.js';
import { conversationsRouter } from './routes/conversations.js';
import { webhooksRouter } from './routes/webhooks.js';
import { reconciliationRouter } from './routes/reconciliation.js';
import { realtimeRouter } from './routes/realtime.js';
import { supportErrorHandler } from './routes/error-handler.js';
import { WebhookVerifier } from './webhooks/webhook-verifier.js';
import { WebhookProcessor } from './webhooks/webhook-processor.js';
import { SupportAuthorizationService } from './auth/authorization-service.js';
import { ReconciliationService } from './reconciliation/reconciliation-service.js';
import { ReconciliationScheduler } from './reconciliation/reconciliation-scheduler.js';
import { SupportRealtimePublisher } from './realtime/realtime-publisher.js';
import { RateLimiter, rateLimitMiddleware } from './middleware/rate-limiter.js';

const app = express();

const chatwootClient = new ChatwootClient();
const supportProvider = new ChatwootSupportProvider(chatwootClient);
const webhookVerifier = new WebhookVerifier();
const realtimePublisher = new SupportRealtimePublisher();
const webhookProcessor = new WebhookProcessor(undefined, undefined, realtimePublisher);
const authorizationService = new SupportAuthorizationService();
const reconciliationService = new ReconciliationService(supportProvider);
const rateLimiter = new RateLimiter(config.rateLimitWindowMs, config.rateLimitMaxRequests);
const reconciliationScheduler = new ReconciliationScheduler(
  reconciliationService,
  config.chatwootReconciliationActors,
  config.reconciliationIntervalMs,
);

// healthRouter first and unmetered - /healthz and /readyz are polled frequently by
// orchestration/monitoring and shouldn't count against (or be blocked by) the same budget as
// real API callers. Every other route falls through past it into the limiter below.
app.use(healthRouter(chatwootClient));
app.use(rateLimitMiddleware(rateLimiter));

// express.raw() must run before express.json() and be scoped to only the webhook path -
// signature verification needs the untouched request bytes, not a JSON.parse/stringify copy.
app.use('/internal/support/chatwoot/webhooks', express.raw({ type: '*/*' }));
app.use(webhooksRouter(webhookVerifier, webhookProcessor));

app.use(express.json());
app.use(conversationsRouter(supportProvider, authorizationService));
app.use(reconciliationRouter(reconciliationService, authorizationService));
app.use(realtimeRouter(realtimePublisher, authorizationService));
app.use(supportErrorHandler);

app.listen(config.port, () => {
  console.log(`support-gateway listening on :${config.port}`);
  console.log(`chatwoot base url: ${config.chatwootBaseUrl}, account: ${config.chatwootAccountId}`);
});

if (config.reconciliationIntervalMs > 0) {
  reconciliationScheduler.start();
}
