import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asTenant } from './helpers.js';
import { conversationSchema } from './contracts.js';
import { config } from '../src/config.js';

// Not part of Appendix A.1 originally - confirmed as a real (if not yet urgent) requirement:
// the in-house app will eventually need to originate a ticket itself, not just act on ones
// email/widget already created. See test/known-gaps.test.ts's git history / README for the
// scope note.
describe('POST /support/conversations (ticket creation)', () => {
  it('creates a conversation against the tenant\'s configured default inbox', async () => {
    const email = `ticket-creation-${randomUUID()}@example.com`;
    const { status, body } = await asTenant('tenant-a', 'stub-user', '/support/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'I need help with my order', contact: { name: 'New Customer', email } }),
    });

    expect(status).toBe(201);
    const conversation = conversationSchema.parse(body);
    expect(conversation.providerInboxId).toBe(config.chatwootTenantDefaultInbox['tenant-a']);
    expect(conversation.contact?.email).toBe(email);
    expect(conversation.status).toBe('open');
  });

  it('reuses an existing contact by email instead of creating a duplicate', async () => {
    const email = `repeat-contact-${randomUUID()}@example.com`;

    const first = await asTenant('tenant-a', 'stub-user', '/support/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'first ticket', contact: { name: 'Repeat Customer', email } }),
    });
    const second = await asTenant('tenant-a', 'stub-user', '/support/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'second, separate ticket', contact: { name: 'Repeat Customer', email } }),
    });

    const firstConvo = conversationSchema.parse(first.body);
    const secondConvo = conversationSchema.parse(second.body);
    expect(secondConvo.providerConversationId).not.toBe(firstConvo.providerConversationId); // two real, separate tickets
    expect(firstConvo.contact?.providerId).toBe(secondConvo.contact?.providerId); // same underlying contact, not duplicated
  });

  it('rejects a request missing contact info with 400', async () => {
    const { status, body } = await asTenant('tenant-a', 'stub-user', '/support/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'no contact provided' }),
    });
    expect(status).toBe(400);
    expect((body as { code: string }).code).toBe('SUPPORT_REQUEST_INVALID');
  });

  it('is idempotent: retrying the same Idempotency-Key and body returns the same conversation, not a new one', async () => {
    const key = `ticket-idem-${randomUUID()}`;
    const email = `idempotent-ticket-${randomUUID()}@example.com`;
    const payload = { content: 'idempotent ticket body', contact: { name: 'Idempotent Customer', email } };

    const first = await asTenant('tenant-a', 'stub-user', '/support/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(payload),
    });
    const replay = await asTenant('tenant-a', 'stub-user', '/support/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(payload),
    });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const firstConvo = conversationSchema.parse(first.body);
    const replayConvo = conversationSchema.parse(replay.body);
    expect(replayConvo.providerConversationId).toBe(firstConvo.providerConversationId);
  });

  it('same Idempotency-Key with a different body is a 409 conflict, not a second ticket', async () => {
    const key = `ticket-idem-conflict-${randomUUID()}`;
    const email = `idem-conflict-${randomUUID()}@example.com`;

    const first = await asTenant('tenant-a', 'stub-user', '/support/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ content: 'original body', contact: { name: 'Conflict Customer', email } }),
    });
    const conflicting = await asTenant('tenant-a', 'stub-user', '/support/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ content: 'a different body entirely', contact: { name: 'Conflict Customer', email } }),
    });

    expect(first.status).toBe(201);
    expect(conflicting.status).toBe(409);
    expect((conflicting.body as { code: string }).code).toBe('SUPPORT_STATE_CONFLICT');
  });

  it('creates tenant-b tickets against tenant-b\'s own default inbox (account 2, not account 1)', async () => {
    // Not re-proving general cross-tenant isolation here - that's tenant-isolation.test.ts's
    // job, and createConversation resolves accountId via the same TenantService.resolve()
    // every other method already goes through. This just confirms the *new* per-tenant default
    // inbox config is actually threaded through correctly for a second tenant, not hardcoded
    // to tenant-a's inbox id.
    const email = `tenant-b-ticket-${randomUUID()}@example.com`;
    const { status, body } = await asTenant('tenant-b', 'tenantb-admin', '/support/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'tenant-b ticket', contact: { name: 'Tenant B Customer', email } }),
    });

    expect(status).toBe(201);
    const conversation = conversationSchema.parse(body);
    expect(conversation.providerInboxId).toBe(config.chatwootTenantDefaultInbox['tenant-b']);
  });
});
