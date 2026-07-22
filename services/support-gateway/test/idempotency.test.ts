import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { asTenant, createFixtureConversation } from './helpers.js';
import { messageSchema } from './contracts.js';

// Spec 18.2: "A timed-out write does not create a duplicate message when retried." Simulates
// a client that sent a reply, timed out waiting for the response, and retried with the same
// Idempotency-Key - the real failure mode this exists for, not just "call it twice on purpose."
describe('idempotent writes (Idempotency-Key)', () => {
  let conversationId: number;

  beforeAll(async () => {
    const fixture = await createFixtureConversation({
      accountId: config.chatwootTenantAccounts['tenant-a'],
      // A Channel::Api test inbox, not the real Channel::Email support inbox - a reply on an
      // email-channel conversation triggers a real outbound SMTP send, and Chatwoot's own
      // MAILER_SENDER_EMAIL/IMAP polling share the same real mailbox in this environment, so a
      // bounce to a fake fixture email address comes right back in as a new "undeliverable"
      // ticket. Discovered when test runs were visibly cluttering the real inbox.
      inboxId: config.chatwootTenantDefaultInbox['tenant-a'],
      adminToken: config.chatwootAgentTokens['stub-user'],
      content: 'Idempotency test fixture conversation',
    });
    conversationId = fixture.conversationId;
  });

  it('retrying the same Idempotency-Key + body returns the same message, not a new one', async () => {
    const idempotencyKey = `contract-suite-${Date.now()}`;
    const body = JSON.stringify({ content: 'idempotent reply attempt' });

    const first = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(first.status).toBe(201);
    const firstMessage = messageSchema.parse(first.body);

    // Simulates the retry after a timeout - identical key, identical body.
    const second = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
    expect(second.status).toBe(201);
    const secondMessage = messageSchema.parse(second.body);

    // Same message, not two - this is the entire point.
    expect(secondMessage.providerMessageId).toBe(firstMessage.providerMessageId);

    const { body: messages } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/messages`);
    const matchingMessages = (messages as { items: { content: string }[] }).items.filter((m) => m.content === 'idempotent reply attempt');
    expect(matchingMessages).toHaveLength(1);
  });

  it('reusing the same key with a different body is a 409, not a silent overwrite', async () => {
    const idempotencyKey = `contract-suite-conflict-${Date.now()}`;

    const first = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ content: 'first body' }),
    });
    expect(first.status).toBe(201);

    const second = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ content: 'a completely different body' }),
    });
    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe('SUPPORT_STATE_CONFLICT');
  });

  it('without an Idempotency-Key header, behavior is unchanged - every call executes', async () => {
    const first = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'no idempotency key' }),
    });
    const second = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'no idempotency key' }),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((first.body as { providerMessageId: number }).providerMessageId).not.toBe(
      (second.body as { providerMessageId: number }).providerMessageId,
    );
  });
});
