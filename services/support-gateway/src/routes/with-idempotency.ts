import type { Request, Response } from 'express';
import { IdempotencyStore } from '../store/idempotency-store.js';

const idempotency = new IdempotencyStore();

// Wraps a write handler with optional Idempotency-Key support (spec 18.2). No header present
// -> behaves exactly as before, every call executes. Header present -> same key + same body
// replays the first response instead of re-calling Chatwoot; same key + different body is a
// 409, since that's a client bug (reusing a key for a genuinely different request), not
// something to silently paper over.
export async function withIdempotency<T>(
  req: Request,
  res: Response,
  scope: string,
  requestBody: unknown,
  produce: () => Promise<{ status: number; body: T }>,
): Promise<void> {
  const key = req.header('Idempotency-Key');
  if (!key) {
    const { status, body } = await produce();
    res.status(status).json(body);
    return;
  }

  const check = idempotency.check(scope, key, requestBody);
  if (check.kind === 'conflict') {
    res.status(409).json({ code: 'SUPPORT_STATE_CONFLICT', message: 'Idempotency-Key was reused with a different request body' });
    return;
  }
  if (check.kind === 'replay') {
    res.status(check.status).json(check.body);
    return;
  }

  const { status, body } = await produce();
  idempotency.store(scope, key, requestBody, status, body);
  res.status(status).json(body);
}
