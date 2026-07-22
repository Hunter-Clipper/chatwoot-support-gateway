import { z } from 'zod';

// Mirrors src/domain/types.ts. Validating real gateway responses against these on every test
// run is the "contract test" spec section 19 asks for against "undocumented API behavior" -
// a Chatwoot upgrade that silently changes a field the mapper depends on should fail a test
// here, not surface as a confusing runtime bug later.

const personSchema = z.object({
  providerId: z.number(),
  name: z.string(),
  email: z.string().nullable(),
});

export const conversationSchema = z.object({
  providerConversationId: z.number(),
  providerInboxId: z.number(),
  status: z.enum(['open', 'resolved', 'pending', 'snoozed']),
  priority: z.string().nullable(),
  subject: z.string().nullable(),
  labels: z.array(z.string()),
  contact: personSchema.nullable(),
  assignee: personSchema.nullable(),
  unreadCount: z.number(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
});

export const conversationPageSchema = z.object({
  items: z.array(conversationSchema),
  meta: z.object({
    mineCount: z.number(),
    assignedCount: z.number(),
    unassignedCount: z.number(),
    allCount: z.number(),
  }),
});

export const messageSchema = z.object({
  providerMessageId: z.number(),
  providerConversationId: z.number(),
  type: z.enum(['incoming', 'outgoing', 'activity', 'template']),
  private: z.boolean(),
  content: z.string(),
  contentType: z.string(),
  sender: z.object({ type: z.string(), providerId: z.number(), name: z.string() }).nullable(),
  createdAt: z.string(),
});

export const messagePageSchema = z.object({
  items: z.array(messageSchema),
});

export const errorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
});
