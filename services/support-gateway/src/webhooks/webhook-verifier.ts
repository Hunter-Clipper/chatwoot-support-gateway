import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Spec section 10.2, steps 2-4. Chatwoot signs deliveries as documented in
// lib/webhooks/trigger.rb: X-Chatwoot-Signature = sha256=HMAC-SHA256(secret, "{ts}.{raw_body}").
// Each Chatwoot account's webhook has its own independently-generated secret (see config.ts) -
// the caller must say which tenant's secret to verify against; this class never guesses.
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export class WebhookSignatureError extends Error {}

export class WebhookVerifier {
  // rawBody must be the exact bytes Chatwoot sent, not a re-serialized JSON.parse/stringify
  // round trip - whitespace or key-order differences would break the HMAC comparison.
  verify(rawBody: Buffer, timestampHeader: string | undefined, signatureHeader: string | undefined, tenantId: string): void {
    const secret = config.chatwootWebhookSecrets[tenantId];
    if (!secret) throw new WebhookSignatureError(`No webhook secret registered for tenant '${tenantId}'`);

    if (!timestampHeader) throw new WebhookSignatureError('Missing X-Chatwoot-Timestamp header');
    if (!signatureHeader) throw new WebhookSignatureError('Missing X-Chatwoot-Signature header');

    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) throw new WebhookSignatureError('X-Chatwoot-Timestamp is not a valid number');

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
      throw new WebhookSignatureError('X-Chatwoot-Timestamp is outside the acceptable window');
    }

    const expected = `sha256=${createHmac('sha256', secret).update(`${timestampHeader}.${rawBody.toString('utf8')}`).digest('hex')}`;

    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(signatureHeader);
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new WebhookSignatureError('Signature mismatch');
    }
  }
}
