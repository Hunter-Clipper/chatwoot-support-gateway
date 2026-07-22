import type { Response } from 'express';

// Spec section 16.1 (SupportRealtimePublisher): "SSE or WebSocket events for the Next.js UI."
// SSE chosen over WebSocket for simplicity - plain HTTP, no upgrade handshake, testable with
// curl. Subscriptions are keyed by Chatwoot account_id (not tenantId) because that's what
// webhook payloads actually carry - the route layer is responsible for resolving a session's
// tenantId to an account_id before subscribing, so a client only ever receives events for the
// Chatwoot account their own tenant maps to. This is in-memory only: a gateway restart drops
// all open connections, same as any bare SSE/WebSocket server without a backing broker.
export class SupportRealtimePublisher {
  private subscribers = new Map<number, Set<Response>>();

  subscribe(accountId: number, res: Response): () => void {
    let set = this.subscribers.get(accountId);
    if (!set) {
      set = new Set();
      this.subscribers.set(accountId, set);
    }
    set.add(res);

    return () => {
      set?.delete(res);
      if (set && set.size === 0) this.subscribers.delete(accountId);
    };
  }

  publish(accountId: number, event: Record<string, unknown>): number {
    const set = this.subscribers.get(accountId);
    if (!set || set.size === 0) return 0;

    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) res.write(frame);
    return set.size;
  }

  subscriberCount(accountId: number): number {
    return this.subscribers.get(accountId)?.size ?? 0;
  }
}
