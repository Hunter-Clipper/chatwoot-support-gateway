import { createHash } from 'node:crypto';
import { db } from './database.js';

// Durable replacement for the earlier in-memory Map-based dedup (spec 10.2 step 5, 10.3).
// Surviving a gateway restart is the whole point - see README for the restart test.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

const insertStmt = db.prepare(
  'INSERT OR IGNORE INTO webhook_deliveries (dedup_key, event, received_at) VALUES (?, ?, ?)',
);
const pruneStmt = db.prepare('DELETE FROM webhook_deliveries WHERE received_at < ?');

function fingerprint(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export class WebhookDeliveryStore {
  // Returns true if this delivery was already recorded (i.e. this call is a duplicate).
  recordAndCheckDuplicate(rawBody: Buffer, deliveryIdHeader: string | undefined, event: string | undefined): boolean {
    pruneStmt.run(Date.now() - DEDUP_WINDOW_MS);

    const dedupKey = deliveryIdHeader || `fingerprint:${fingerprint(rawBody)}`;
    const result = insertStmt.run(dedupKey, event ?? null, Date.now());
    // changes === 0 means INSERT OR IGNORE hit the existing PRIMARY KEY - already seen.
    return result.changes === 0;
  }
}
