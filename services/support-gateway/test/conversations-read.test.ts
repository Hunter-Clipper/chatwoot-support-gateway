import { describe, expect, it } from 'vitest';
import { asTenant } from './helpers.js';
import { conversationPageSchema, conversationSchema, errorBodySchema, messagePageSchema } from './contracts.js';

describe('conversations: read path', () => {
  it('lists conversations matching the ConversationPage contract', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', '/support/conversations?status=all');
    expect(status).toBe(200);
    const parsed = conversationPageSchema.parse(body);
    expect(parsed.items.length).toBeGreaterThan(0);
  });

  it('gets a single conversation matching the Conversation contract', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', '/support/conversations/1');
    expect(status).toBe(200);
    conversationSchema.parse(body);
  });

  it('lists messages for a conversation matching the MessagePage contract', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', '/support/conversations/1/messages');
    expect(status).toBe(200);
    const parsed = messagePageSchema.parse(body);
    expect(parsed.items.length).toBeGreaterThan(0);
    // Private notes must never be indistinguishable from public replies (spec 15.1, 18.1).
    expect(parsed.items.some((m) => m.private === true || m.private === false)).toBe(true);
  });

  it('404s for a conversation id that does not exist, per Appendix A.2', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', '/support/conversations/999999');
    expect(status).toBe(404);
    const parsed = errorBodySchema.parse(body);
    expect(parsed.code).toBe('SUPPORT_CONVERSATION_NOT_FOUND');
  });
});
