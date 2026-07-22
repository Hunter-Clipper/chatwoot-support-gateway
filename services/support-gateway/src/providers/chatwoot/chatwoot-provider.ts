import { randomUUID } from 'node:crypto';
import type { ConversationFilter, NewConversationInput, RequestContext, SupportProvider } from '../../domain/support-provider.js';
import type { Conversation, ConversationPage, Message, MessagePage } from '../../domain/types.js';
import { ProviderIdentityService } from '../../auth/identity-service.js';
import { TenantService } from '../../auth/tenant-service.js';
import { ChatwootClient } from './chatwoot-client.js';
import { ChatwootMapper } from './chatwoot-mapper.js';

// Implements SupportProvider against Chatwoot's Application API (spec section 6.1).
// Every method resolves both the Chatwoot account (via TenantService, from context.tenantId)
// and the access token (via ProviderIdentityService, from context.actingUserId) before calling
// out - see README for what's still a stand-in in each of those (SupportAuthorizationService
// isn't implemented, so nothing here re-derives context.tenantId/actingUserId itself; it trusts
// whatever RequestContext it's given).
export class ChatwootSupportProvider implements SupportProvider {
  constructor(
    private readonly client: ChatwootClient = new ChatwootClient(),
    private readonly identity: ProviderIdentityService = new ProviderIdentityService(),
    private readonly tenants: TenantService = new TenantService(),
  ) {}

  private async resolve(context: RequestContext): Promise<{ accountId: number; token: string }> {
    const accountId = this.tenants.getAccountId(context.tenantId);
    const token = await this.identity.getAccessToken(context.actingUserId);
    return { accountId, token };
  }

  async listConversations(context: RequestContext, filter: ConversationFilter): Promise<ConversationPage> {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.page) params.set('page', String(filter.page));
    const query = params.toString() ? `?${params.toString()}` : '';

    const { accountId, token } = await this.resolve(context);
    const raw = await this.client.get<Parameters<typeof ChatwootMapper.conversationPage>[0]>(`/conversations${query}`, accountId, token);
    return ChatwootMapper.conversationPage(raw);
  }

  async getConversation(context: RequestContext, id: number): Promise<Conversation> {
    const { accountId, token } = await this.resolve(context);
    const raw = await this.client.get<Parameters<typeof ChatwootMapper.conversation>[0]>(`/conversations/${id}`, accountId, token);
    return ChatwootMapper.conversation(raw);
  }

  async listMessages(context: RequestContext, id: number): Promise<MessagePage> {
    const { accountId, token } = await this.resolve(context);
    const raw = await this.client.get<Parameters<typeof ChatwootMapper.messagePage>[0]>(`/conversations/${id}/messages`, accountId, token);
    return ChatwootMapper.messagePage(raw);
  }

  async createConversation(context: RequestContext, input: NewConversationInput): Promise<Conversation> {
    const { accountId, token } = await this.resolve(context);
    const inboxId = this.tenants.getDefaultInboxId(context.tenantId);
    const contactId = await this.resolveContact(accountId, token, input.contact);

    const raw = await this.client.post<Parameters<typeof ChatwootMapper.conversation>[0]>(
      '/conversations',
      { inbox_id: inboxId, contact_id: contactId, source_id: `gateway-${randomUUID()}`, message: { content: input.content } },
      accountId,
      token,
    );
    return ChatwootMapper.conversation(raw);
  }

  // Search-then-create rather than always creating: Chatwoot's contacts API has no upsert,
  // and blindly creating on every ticket would spawn a new contact per ticket for the same
  // customer instead of threading them onto their existing one.
  private async resolveContact(accountId: number, token: string, contact: { name: string; email: string }): Promise<number> {
    const query = new URLSearchParams({ q: contact.email });
    const found = await this.client.get<{ payload: Array<{ id: number }> }>(`/contacts/search?${query}`, accountId, token);
    if (found.payload.length > 0) return found.payload[0].id;

    const created = await this.client.post<{ payload: { contact: { id: number } } }>(
      '/contacts',
      { name: contact.name, email: contact.email },
      accountId,
      token,
    );
    return created.payload.contact.id;
  }

  async sendReply(context: RequestContext, id: number, input: { content: string }): Promise<Message> {
    return this.createMessage(context, id, input.content, false);
  }

  async createPrivateNote(context: RequestContext, id: number, input: { content: string }): Promise<Message> {
    return this.createMessage(context, id, input.content, true);
  }

  private async createMessage(context: RequestContext, id: number, content: string, isPrivate: boolean): Promise<Message> {
    const { accountId, token } = await this.resolve(context);
    const raw = await this.client.post<Parameters<typeof ChatwootMapper.message>[0]>(
      `/conversations/${id}/messages`,
      { content, message_type: 'outgoing', private: isPrivate },
      accountId,
      token,
    );
    return ChatwootMapper.message(raw);
  }

  async setStatus(context: RequestContext, id: number, status: string): Promise<void> {
    const { accountId, token } = await this.resolve(context);
    // Chatwoot's own response ({payload: {success, current_status, ...}}) isn't surfaced -
    // setStatus returns void per the SupportProvider interface (spec 11.1). A failed
    // transition still comes back as a non-2xx, which client.post turns into a
    // SupportProviderError the caller sees via the normal error path.
    await this.client.post(`/conversations/${id}/toggle_status`, { status }, accountId, token);
  }

  async assign(context: RequestContext, id: number, assignment: { agentId?: number; teamId?: number }): Promise<void> {
    const { accountId, token } = await this.resolve(context);
    const body = assignment.agentId !== undefined ? { assignee_id: assignment.agentId } : { team_id: assignment.teamId };
    await this.client.post(`/conversations/${id}/assignments`, body, accountId, token);
  }

  async updateLabels(context: RequestContext, id: number, labels: string[]): Promise<void> {
    const { accountId, token } = await this.resolve(context);
    await this.client.post(`/conversations/${id}/labels`, { labels }, accountId, token);
  }
}
