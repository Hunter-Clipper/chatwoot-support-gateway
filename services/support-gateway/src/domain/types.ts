// Provider-neutral DTOs. Per the integration spec section 11.1, the UI must depend on
// these shapes, never on raw Chatwoot response objects - this is what keeps Chatwoot
// replaceable. Chatwoot's numeric IDs are surfaced here as providerConversationId /
// providerMessageId; a real product mapping table (spec section 8.2, support_conversation)
// is a later phase - not implemented in this skeleton.

export type ConversationStatus = 'open' | 'resolved' | 'pending' | 'snoozed';

export interface Person {
  providerId: number;
  name: string;
  email: string | null;
}

export interface Conversation {
  providerConversationId: number;
  providerInboxId: number;
  status: ConversationStatus;
  priority: string | null;
  subject: string | null;
  labels: string[];
  contact: Person | null;
  assignee: Person | null;
  unreadCount: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface ConversationPage {
  items: Conversation[];
  meta: {
    mineCount: number;
    assignedCount: number;
    unassignedCount: number;
    allCount: number;
  };
}

export type MessageType = 'incoming' | 'outgoing' | 'activity' | 'template';

export interface Message {
  providerMessageId: number;
  providerConversationId: number;
  type: MessageType;
  private: boolean;
  content: string;
  contentType: string;
  sender: { type: string; providerId: number; name: string } | null;
  createdAt: string;
}

export interface MessagePage {
  items: Message[];
}

export type SupportErrorCode =
  | 'SUPPORT_PROVIDER_IDENTITY_INVALID'
  | 'SUPPORT_PROVIDER_ACCESS_DENIED'
  | 'SUPPORT_CONVERSATION_NOT_FOUND'
  | 'SUPPORT_STATE_CONFLICT'
  | 'SUPPORT_PROVIDER_RATE_LIMITED'
  | 'SUPPORT_PROVIDER_UNAVAILABLE'
  | 'SUPPORT_PROVIDER_CONTRACT_ERROR';

// Appendix A.2 error translation table.
export class SupportProviderError extends Error {
  constructor(public readonly code: SupportErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SupportProviderError';
  }
}
