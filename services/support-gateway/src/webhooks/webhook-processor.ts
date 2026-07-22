import { WebhookDeliveryStore } from '../store/webhook-delivery-store.js';
import { LocalConversationStore } from '../store/local-conversation-store.js';
import type { SupportRealtimePublisher } from '../realtime/realtime-publisher.js';

export interface WebhookProcessResult {
  duplicate: boolean;
  event: string | undefined;
}

interface ConversationSnapshot {
  accountId: number;
  providerConversationId: number;
  status: string;
  subject: string | null;
  lastActivityAt: number | null;
}

// Extracts a conversation snapshot from the two payload shapes Chatwoot actually sends,
// confirmed against this instance's real webhook deliveries (not assumed from docs):
// conversation_created/updated/status_changed payloads have id/status/account/etc. at the
// top level; message_created/updated payloads nest the same shape under `conversation`.
function extractConversationSnapshot(payload: Record<string, unknown>): ConversationSnapshot | null {
  const source = (payload.conversation ?? payload) as Record<string, unknown>;
  const account = source.account as Record<string, unknown> | undefined;
  if (typeof source.id !== 'number' || typeof account?.id !== 'number' || typeof source.status !== 'string') {
    return null;
  }
  const additionalAttributes = source.additional_attributes as Record<string, unknown> | undefined;
  return {
    accountId: account.id,
    providerConversationId: source.id,
    status: source.status,
    subject: typeof additionalAttributes?.mail_subject === 'string' ? additionalAttributes.mail_subject : null,
    lastActivityAt: typeof source.last_activity_at === 'number' ? source.last_activity_at : null,
  };
}

// Spec section 10.1 (event handling) and 10.2 step 5 (dedup), now durable (spec 10.3, 12.2)
// via SQLite instead of the earlier in-memory Map - dedup state and the local read model both
// survive a gateway restart. True async queueing (spec 12.2's "Event queue", at-least-once
// with idempotent consumers) is still not implemented - events are processed synchronously,
// inline in the HTTP request. See README.
export class WebhookProcessor {
  constructor(
    private readonly deliveries: WebhookDeliveryStore = new WebhookDeliveryStore(),
    private readonly conversations: LocalConversationStore = new LocalConversationStore(),
    private readonly realtime?: SupportRealtimePublisher,
  ) {}

  process(rawBody: Buffer, deliveryIdHeader: string | undefined): WebhookProcessResult {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      payload = {};
    }
    const event = typeof payload.event === 'string' ? payload.event : undefined;

    const duplicate = this.deliveries.recordAndCheckDuplicate(rawBody, deliveryIdHeader, event);
    if (duplicate) {
      console.log(`[webhook] duplicate delivery ignored (deliveryId=${deliveryIdHeader}, event=${event})`);
      return { duplicate: true, event };
    }

    const snapshot = extractConversationSnapshot(payload);
    if (snapshot) {
      this.conversations.upsert({ ...snapshot, syncedAt: Date.now(), syncedVia: 'webhook' });
      const subscriberCount = this.realtime?.publish(snapshot.accountId, { event, ...snapshot }) ?? 0;
      console.log(
        `[webhook] event=${event} deliveryId=${deliveryIdHeader ?? '(none, used body fingerprint)'} ` +
          `updated local_conversations account=${snapshot.accountId} conversation=${snapshot.providerConversationId} status=${snapshot.status} ` +
          `published to ${subscriberCount} realtime subscriber(s)`,
      );
    } else {
      console.log(`[webhook] event=${event} deliveryId=${deliveryIdHeader ?? '(none, used body fingerprint)'} - no conversation data to sync`);
    }

    return { duplicate: false, event };
  }
}
