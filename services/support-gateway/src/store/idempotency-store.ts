import { createHash } from 'node:crypto';
import { db } from './database.js';

// Spec 18.2: "A timed-out write does not create a duplicate message when retried." Chatwoot's
// message-create endpoint has no idempotency concept of its own - a caller retrying a reply
// after a timeout (never knowing if the first attempt actually landed) would otherwise create
// two messages. This stores the *response* of the first attempt for a given key and replays it
// on retry, rather than re-executing the write. Same pattern as WebhookDeliveryStore: SQLite so
// it survives a gateway restart, not just an in-memory Map.
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

const getStmt = db.prepare(
  'SELECT request_hash as requestHash, response_status as responseStatus, response_body as responseBody FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?',
);
const insertStmt = db.prepare(`
  INSERT INTO idempotency_keys (scope, idempotency_key, request_hash, response_status, response_body, created_at)
  VALUES (@scope, @idempotencyKey, @requestHash, @responseStatus, @responseBody, @createdAt)
`);
const pruneStmt = db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?');

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export type IdempotencyResult =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' };

export class IdempotencyStore {
  // scope should include enough context (tenant, route) that two different tenants or routes
  // reusing the same client-generated key can never collide with each other.
  check(scope: string, key: string, requestBody: unknown): IdempotencyResult {
    pruneStmt.run(Date.now() - REQUEST_WINDOW_MS);

    const row = getStmt.get(scope, key) as { requestHash: string; responseStatus: number; responseBody: string } | undefined;
    if (!row) return { kind: 'new' };

    if (row.requestHash !== hashBody(requestBody)) return { kind: 'conflict' };
    return { kind: 'replay', status: row.responseStatus, body: JSON.parse(row.responseBody) };
  }

  store(scope: string, key: string, requestBody: unknown, responseStatus: number, responseBody: unknown): void {
    insertStmt.run({
      scope,
      idempotencyKey: key,
      requestHash: hashBody(requestBody),
      responseStatus,
      responseBody: JSON.stringify(responseBody),
      createdAt: Date.now(),
    });
  }
}
