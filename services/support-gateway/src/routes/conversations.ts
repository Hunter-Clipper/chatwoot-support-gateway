import { Router, type Request } from 'express';
import { z } from 'zod';
import type { RequestContext, SupportProvider } from '../domain/support-provider.js';
import { SupportAuthorizationService } from '../auth/authorization-service.js';
import { bearerToken } from '../auth/bearer-token.js';
import { withIdempotency } from './with-idempotency.js';

const createMessageSchema = z.object({ content: z.string().trim().min(1) });
const createConversationSchema = z.object({
  content: z.string().trim().min(1),
  contact: z.object({ name: z.string().trim().min(1), email: z.string().trim().email() }),
});
const setStatusSchema = z.object({ status: z.enum(['open', 'resolved', 'pending', 'snoozed']) });
const assignSchema = z
  .object({ agentId: z.number().int().optional(), teamId: z.number().int().optional() })
  .refine((v) => v.agentId !== undefined || v.teamId !== undefined, { message: 'Either agentId or teamId is required' });
const updateLabelsSchema = z.object({ labels: z.array(z.string()) });

// Appendix A.1 routes. Every route derives its RequestContext from a verified product-session
// token (spec 15.1) via SupportAuthorizationService.verifySession() - never from a raw,
// client-asserted tenant/user id. See scripts/issue-test-session.ts for how to mint a token to
// test against, and SupportAuthorizationService for why issuance itself lives outside server code.
export function conversationsRouter(provider: SupportProvider, authz: SupportAuthorizationService): Router {
  const router = Router();

  function contextFor(req: Request): RequestContext {
    return authz.verifySession(bearerToken(req));
  }

  router.get('/support/conversations', async (req, res, next) => {
    try {
      const page = req.query.page ? Number(req.query.page) : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const result = await provider.listConversations(contextFor(req), { page, status });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/support/conversations', async (req, res, next) => {
    try {
      const input = createConversationSchema.parse(req.body);
      const context = contextFor(req);
      await withIdempotency(req, res, `${context.tenantId}:create-conversation`, input, async () => ({
        status: 201,
        body: await provider.createConversation(context, input),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/support/conversations/:id', async (req, res, next) => {
    try {
      const result = await provider.getConversation(contextFor(req), Number(req.params.id));
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/support/conversations/:id/messages', async (req, res, next) => {
    try {
      const result = await provider.listMessages(contextFor(req), Number(req.params.id));
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/support/conversations/:id/replies', async (req, res, next) => {
    try {
      const input = createMessageSchema.parse(req.body);
      const context = contextFor(req);
      await withIdempotency(req, res, `${context.tenantId}:replies:${req.params.id}`, input, async () => ({
        status: 201,
        body: await provider.sendReply(context, Number(req.params.id), input),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/support/conversations/:id/notes', async (req, res, next) => {
    try {
      const input = createMessageSchema.parse(req.body);
      const context = contextFor(req);
      await withIdempotency(req, res, `${context.tenantId}:notes:${req.params.id}`, input, async () => ({
        status: 201,
        body: await provider.createPrivateNote(context, Number(req.params.id), input),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/support/conversations/:id/status', async (req, res, next) => {
    try {
      const input = setStatusSchema.parse(req.body);
      await provider.setStatus(contextFor(req), Number(req.params.id), input.status);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.patch('/support/conversations/:id/assignment', async (req, res, next) => {
    try {
      const input = assignSchema.parse(req.body);
      await provider.assign(contextFor(req), Number(req.params.id), input);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.patch('/support/conversations/:id/labels', async (req, res, next) => {
    try {
      const input = updateLabelsSchema.parse(req.body);
      await provider.updateLabels(contextFor(req), Number(req.params.id), input.labels);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
