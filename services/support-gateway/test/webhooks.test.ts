import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { GATEWAY_URL, signWebhookPayload } from './helpers.js';

const TENANT = 'tenant-a';
const secret = config.chatwootWebhookSecrets[TENANT];

async function postWebhook(headers: Record<string, string>, body: string) {
  const response = await fetch(`${GATEWAY_URL}/internal/support/chatwoot/webhooks/${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, body: (await response.json()) as { code?: string; duplicate?: boolean } };
}

describe('webhook signature verification (spec 10.2)', () => {
  it('accepts a validly signed payload', async () => {
    const deliveryId = `contract-test-${Date.now()}`;
    const { body, timestamp, signature } = signWebhookPayload(secret, { event: 'test_event', hello: 'world' });
    const { status, body: responseBody } = await postWebhook(
      { 'X-Chatwoot-Timestamp': timestamp, 'X-Chatwoot-Signature': signature, 'X-Chatwoot-Delivery': deliveryId },
      body,
    );
    expect(status).toBe(200);
    expect(responseBody.duplicate).toBe(false);
  });

  it('flags a replayed delivery id as a duplicate', async () => {
    const deliveryId = `contract-test-replay-${Date.now()}`;
    const { body, timestamp, signature } = signWebhookPayload(secret, { event: 'test_event' });
    const headers = { 'X-Chatwoot-Timestamp': timestamp, 'X-Chatwoot-Signature': signature, 'X-Chatwoot-Delivery': deliveryId };

    const first = await postWebhook(headers, body);
    expect(first.body.duplicate).toBe(false);

    const second = await postWebhook(headers, body);
    expect(second.body.duplicate).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const { timestamp, signature } = signWebhookPayload(secret, { event: 'test_event', hello: 'world' });
    const { status, body } = await postWebhook(
      { 'X-Chatwoot-Timestamp': timestamp, 'X-Chatwoot-Signature': signature },
      JSON.stringify({ event: 'test_event', hello: 'tampered' }),
    );
    expect(status).toBe(401);
    expect(body.code).toBe('SUPPORT_WEBHOOK_SIGNATURE_INVALID');
  });

  it('rejects a stale timestamp outside the acceptance window', async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600;
    const { body, timestamp, signature } = signWebhookPayload(secret, { event: 'test_event' }, staleTimestamp);
    const { status, body: responseBody } = await postWebhook({ 'X-Chatwoot-Timestamp': timestamp, 'X-Chatwoot-Signature': signature }, body);
    expect(status).toBe(401);
    expect(responseBody.code).toBe('SUPPORT_WEBHOOK_SIGNATURE_INVALID');
  });

  it('rejects a payload signed with the wrong tenant secret', async () => {
    const { body, timestamp, signature } = signWebhookPayload('wrong-secret-entirely', { event: 'test_event' });
    const { status } = await postWebhook({ 'X-Chatwoot-Timestamp': timestamp, 'X-Chatwoot-Signature': signature }, body);
    expect(status).toBe(401);
  });
});
