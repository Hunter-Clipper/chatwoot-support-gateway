import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import { config } from '../src/config.js';

// Shared test infrastructure. Reuses the gateway's own config (tenant/agent maps, secrets,
// Chatwoot base URL) rather than duplicating values - these tests assume the real stack
// (Chatwoot + gateway) is already running, per test/README.md.

export const GATEWAY_URL = process.env.GATEWAY_URL ?? `http://localhost:${config.port}`;

export function mintSession(tenantId: string, actingUserId: string, expiresIn: jwt.SignOptions['expiresIn'] = '5m'): string {
  return jwt.sign({ tenantId, actingUserId }, config.sessionSigningSecret, { algorithm: 'HS256', expiresIn });
}

export interface GatewayResponse<T = unknown> {
  status: number;
  body: T;
}

export async function gatewayFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<GatewayResponse<T>> {
  const response = await fetch(`${GATEWAY_URL}${path}`, init);
  const status = response.status;
  const body = status === 204 ? (undefined as T) : ((await response.json()) as T);
  return { status, body };
}

export async function asTenant(tenantId: string, actingUserId: string, path: string, init: RequestInit = {}) {
  const token = mintSession(tenantId, actingUserId);
  return gatewayFetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
}

// Creates a fresh contact + conversation directly against Chatwoot's admin API (not through
// the gateway - this is test *fixture setup*, not the thing under test). Keeps write-heavy
// tests from piling onto the same long-lived manually-tested conversation #1 in each account.
export async function createFixtureConversation(options: {
  accountId: number;
  inboxId: number;
  adminToken: string;
  content: string;
}): Promise<{ conversationId: number; contactId: number }> {
  const { accountId, inboxId, adminToken, content } = options;
  const headers = {
    api_access_token: adminToken,
    'Content-Type': 'application/json',
    'X-Forwarded-Proto': 'https',
    Host: 'chatwoot.hunterclipper.com',
  };

  const contactRes = await fetch(`${config.chatwootBaseUrl}/api/v1/accounts/${accountId}/contacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Contract Test Contact', email: `contract-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` }),
  });
  const contact = (await contactRes.json()) as { payload: { contact: { id: number } } };
  const contactId = contact.payload.contact.id;

  const convoRes = await fetch(`${config.chatwootBaseUrl}/api/v1/accounts/${accountId}/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      inbox_id: inboxId,
      contact_id: contactId,
      source_id: `contract-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      message: { content },
    }),
  });
  const conversation = (await convoRes.json()) as { id: number };
  return { conversationId: conversation.id, contactId };
}

export function signWebhookPayload(secret: string, payload: Record<string, unknown>, timestamp: number = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  const ts = String(timestamp);
  const signature = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  return { body, timestamp: ts, signature };
}
