import type { Conversation, ConversationPage, Message, MessagePage, MessageType } from '../../domain/types.js';

// Shapes below reflect the actual Chatwoot v4.16.0-ce JSON responses observed against a
// running instance (GET .../conversations and GET .../conversations/{id}/messages), not
// assumed from documentation - per spec section 11.2, provider responses get validated at
// runtime rather than trusted blindly. Only the fields this gateway currently uses are typed.

const MESSAGE_TYPE_BY_INDEX: MessageType[] = ['incoming', 'outgoing', 'activity', 'template'];

interface RawPerson {
  id: number;
  name: string;
  email?: string | null;
}

interface RawConversation {
  id: number;
  inbox_id: number;
  status: string;
  priority: string | null;
  labels: string[];
  unread_count: number;
  created_at: number;
  last_activity_at: number;
  additional_attributes?: { mail_subject?: string };
  meta: {
    sender?: RawPerson;
    assignee?: RawPerson;
  };
}

interface RawConversationListResponse {
  data: {
    meta: {
      mine_count: number;
      assigned_count: number;
      unassigned_count: number;
      all_count: number;
    };
    payload: RawConversation[];
  };
}

interface RawMessage {
  id: number;
  conversation_id: number;
  message_type: number;
  private: boolean;
  content: string | null;
  content_type: string;
  created_at: number;
  sender?: { type?: string; id: number; name: string } | null;
}

interface RawMessageListResponse {
  meta: unknown;
  payload: RawMessage[];
}

function toIsoString(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function mapPerson(raw?: RawPerson): Conversation['contact'] {
  if (!raw) return null;
  return { providerId: raw.id, name: raw.name, email: raw.email ?? null };
}

export const ChatwootMapper = {
  conversationPage(raw: RawConversationListResponse): ConversationPage {
    return {
      items: raw.data.payload.map(ChatwootMapper.conversation),
      meta: {
        mineCount: raw.data.meta.mine_count,
        assignedCount: raw.data.meta.assigned_count,
        unassignedCount: raw.data.meta.unassigned_count,
        allCount: raw.data.meta.all_count,
      },
    };
  },

  conversation(raw: RawConversation): Conversation {
    return {
      providerConversationId: raw.id,
      providerInboxId: raw.inbox_id,
      status: raw.status as Conversation['status'],
      priority: raw.priority,
      subject: raw.additional_attributes?.mail_subject ?? null,
      labels: raw.labels ?? [],
      contact: mapPerson(raw.meta.sender),
      assignee: mapPerson(raw.meta.assignee),
      unreadCount: raw.unread_count,
      createdAt: toIsoString(raw.created_at),
      lastActivityAt: toIsoString(raw.last_activity_at),
    };
  },

  messagePage(raw: RawMessageListResponse): MessagePage {
    return { items: raw.payload.map(ChatwootMapper.message) };
  },

  message(raw: RawMessage): Message {
    return {
      providerMessageId: raw.id,
      providerConversationId: raw.conversation_id,
      type: MESSAGE_TYPE_BY_INDEX[raw.message_type] ?? 'activity',
      private: raw.private,
      content: raw.content ?? '',
      contentType: raw.content_type,
      sender: raw.sender ? { type: raw.sender.type ?? 'unknown', providerId: raw.sender.id, name: raw.sender.name } : null,
      createdAt: toIsoString(raw.created_at),
    };
  },
};
