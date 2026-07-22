import { Router } from 'express';
import { ChatwootClient } from '../providers/chatwoot/chatwoot-client.js';
import { config } from '../config.js';

export function healthRouter(client: ChatwootClient): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (_req, res) => {
    // Operational check, not an agent-attributed action - using the configured token
    // directly here is fine even after per-agent tokens replace it elsewhere.
    try {
      await client.get(`/conversations?page=1`, config.chatwootAccountId, config.chatwootApiToken);
      res.json({ status: 'ok', chatwoot: 'reachable' });
    } catch (error) {
      res.status(503).json({ status: 'degraded', chatwoot: 'unreachable', error: (error as Error).message });
    }
  });

  return router;
}
