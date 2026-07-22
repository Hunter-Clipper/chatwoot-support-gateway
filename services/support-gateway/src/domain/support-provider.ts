import type { Conversation, ConversationPage, Message, MessagePage } from './types.js';

// Minimal placeholder for the tenant/agent context the real SupportAuthorizationService
// (spec section 16.1) will derive from the product session. Not enforced yet - every
// route currently trusts a single configured Chatwoot token (spec section 7.3, POC-only).
export interface RequestContext {
  tenantId: string;
  actingUserId: string;
}

export interface ConversationFilter {
  status?: string;
  page?: number;
}

// Not in the spec's Appendix A.1 route table - ticket creation was originally out of scope
// because every conversation was assumed to originate from inbound email/widget. Confirmed as
// a real (if not yet urgent) requirement: the in-house app will eventually need to originate a
// ticket itself, not just act on ones email/chat already created.
export interface NewConversationInput {
  content: string;
  contact: { name: string; email: string };
}

// Spec section 11.1. The custom UI and the gateway's routes must depend only on this
// interface, never on ChatwootSupportProvider or raw Chatwoot shapes directly.
export interface SupportProvider {
  listConversations(context: RequestContext, filter: ConversationFilter): Promise<ConversationPage>;
  getConversation(context: RequestContext, id: number): Promise<Conversation>;
  listMessages(context: RequestContext, id: number): Promise<MessagePage>;
  createConversation(context: RequestContext, input: NewConversationInput): Promise<Conversation>;

  // Not implemented in this skeleton - Phase 3 in the spec's implementation plan.
  sendReply(context: RequestContext, id: number, input: { content: string }): Promise<Message>;
  createPrivateNote(context: RequestContext, id: number, input: { content: string }): Promise<Message>;
  setStatus(context: RequestContext, id: number, status: string): Promise<void>;
  assign(context: RequestContext, id: number, assignment: { agentId?: number; teamId?: number }): Promise<void>;
  updateLabels(context: RequestContext, id: number, labels: string[]): Promise<void>;
}
