import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { asTenant, createFixtureConversation } from './helpers.js';
import { errorBodySchema, messageSchema } from './contracts.js';

// Each test run creates its own fresh conversation (spec section 8's per-account inboxes) so
// these don't keep piling onto the long-lived, manually-tested conversation #1.
describe('conversations: write path', () => {
  let conversationId: number;

  beforeAll(async () => {
    const fixture = await createFixtureConversation({
      accountId: config.chatwootTenantAccounts['tenant-a'],
      // Channel::Api test inbox, not the real Channel::Email support inbox - see the same note
      // in idempotency.test.ts for why (real outbound SMTP + shared real mailbox = bounces
      // land right back in as new "undeliverable" tickets).
      inboxId: config.chatwootTenantDefaultInbox['tenant-a'],
      adminToken: config.chatwootAgentTokens['stub-user'],
      content: 'Contract suite fixture conversation',
    });
    conversationId = fixture.conversationId;
  });

  it('sends a public reply with private: false', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'contract suite public reply' }),
    });
    expect(status).toBe(201);
    const parsed = messageSchema.parse(body);
    expect(parsed.private).toBe(false);
    expect(parsed.content).toBe('contract suite public reply');
  });

  it('creates a private note with private: true', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'contract suite private note' }),
    });
    expect(status).toBe(201);
    const parsed = messageSchema.parse(body);
    expect(parsed.private).toBe(true);
  });

  it('rejects empty reply content before ever calling Chatwoot', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    expect(status).toBe(400);
    expect(errorBodySchema.parse(body).code).toBe('SUPPORT_REQUEST_INVALID');
  });

  it('updates status and it actually persists', async () => {
    const { status } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(status).toBe(204);

    const { body: conversation } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}`);
    expect((conversation as { status: string }).status).toBe('resolved');
  });

  it('rejects an invalid status value', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'not-a-real-status' }),
    });
    expect(status).toBe(400);
    expect(errorBodySchema.parse(body).code).toBe('SUPPORT_REQUEST_INVALID');
  });

  it('updates labels and they actually persist', async () => {
    const { status } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/labels`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['contract-suite-label'] }),
    });
    expect(status).toBe(204);

    const { body: conversation } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}`);
    expect((conversation as { labels: string[] }).labels).toContain('contract-suite-label');
  });

  it('rejects an assignment with neither agentId nor teamId', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/assignment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(errorBodySchema.parse(body).code).toBe('SUPPORT_REQUEST_INVALID');
  });

  it('assigns to a valid agent and it actually persists', async () => {
    const { status } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}/assignment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 1 }),
    });
    expect(status).toBe(204);

    const { body: conversation } = await asTenant('tenant-a', 'stub-user', `/support/conversations/${conversationId}`);
    expect((conversation as { assignee: { providerId: number } | null }).assignee?.providerId).toBe(1);
  });
});
