import type { RequestContext, SupportProvider } from '../domain/support-provider.js';
import { TenantService } from '../auth/tenant-service.js';
import { LocalConversationStore } from '../store/local-conversation-store.js';

export interface ReconciliationResult {
  checked: number;
  repaired: number;
  pruned: number;
}

// Spec section 10.3: "Run periodic reconciliation that retrieves recently changed
// conversations and messages, compares them with the local read model, repairs gaps." Built on
// SupportProvider rather than talking to Chatwoot directly - reconciliation is just another
// consumer of the same abstraction the UI uses, which is the point of having it.
//
// Simplification vs. the real design: this pulls one page of conversations and repairs
// anything that doesn't match, rather than only "recently changed" ones - fine at this data
// volume, would need proper pagination/date-filtering at scale. The pruning step below shares
// that same caveat: it only knows about conversations that fit on this one page, so at a data
// volume that spans multiple pages it could wrongly prune a local row for a real conversation
// that simply wasn't on this page, not one that's actually gone from the provider.
export class ReconciliationService {
  constructor(
    private readonly provider: SupportProvider,
    private readonly tenants: TenantService = new TenantService(),
    private readonly conversations: LocalConversationStore = new LocalConversationStore(),
  ) {}

  async reconcile(context: RequestContext): Promise<ReconciliationResult> {
    const accountId = this.tenants.getAccountId(context.tenantId);
    // Chatwoot's conversation list defaults to status=open when no status filter is given
    // (confirmed in conversation_finder.rb: DEFAULT_STATUS = 'open') - reconciliation must
    // request 'all' explicitly, or it will never catch a conversation that left the open
    // state via a missed webhook, which is exactly the failure mode this service exists for.
    const page = await this.provider.listConversations(context, { status: 'all' });

    let repaired = 0;
    const seenIds = new Set<number>();
    for (const conversation of page.items) {
      seenIds.add(conversation.providerConversationId);
      const local = this.conversations.get(accountId, conversation.providerConversationId);
      const drifted =
        !local ||
        local.status !== conversation.status ||
        local.subject !== conversation.subject ||
        local.lastActivityAt !== Date.parse(conversation.lastActivityAt) / 1000;

      if (drifted) {
        this.conversations.upsert({
          accountId,
          providerConversationId: conversation.providerConversationId,
          status: conversation.status,
          subject: conversation.subject,
          lastActivityAt: Math.floor(Date.parse(conversation.lastActivityAt) / 1000),
          syncedAt: Date.now(),
          syncedVia: 'reconciliation',
        });
        repaired += 1;
      }
    }

    // Spec 18.2: after a restore, the local read model can point at conversations that no
    // longer exist at all (not just ones with stale fields) - a restore rolls Chatwoot itself
    // back, not just the gateway's cache of it. Found via an actual backup/restore drill: a
    // conversation created after the restore point, and its local row, silently survived every
    // reconciliation pass because the upsert loop above only ever touches ids Chatwoot still
    // returns. Pruning anything local that wasn't in this page closes that gap - see the
    // pagination caveat above for the one case this doesn't cover.
    let pruned = 0;
    for (const local of this.conversations.listByAccount(accountId)) {
      if (!seenIds.has(local.providerConversationId)) {
        this.conversations.delete(accountId, local.providerConversationId);
        pruned += 1;
      }
    }

    return { checked: page.items.length, repaired, pruned };
  }
}
