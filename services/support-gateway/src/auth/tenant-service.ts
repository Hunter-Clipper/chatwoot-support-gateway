import { config } from '../config.js';
import { SupportProviderError } from '../domain/types.js';

// Spec section 15.1: "Every gateway request must derive tenant context from the product
// session and verify that mapped Chatwoot account ... belong to that tenant." This is a
// flat-file stand-in for the real tenant/account mapping table (spec 8.2, support_conversation)
// - one lookup, easy to swap for a real store later. Chatwoot conversation/contact ids are
// per-account display_ids, not globally unique, so getting this wrong doesn't 404 - it returns
// a different tenant's data under the same id. See TenantService as the resolution point.
export class TenantService {
  getAccountId(tenantId: string): number {
    const accountId = config.chatwootTenantAccounts[tenantId];
    if (accountId === undefined) {
      throw new SupportProviderError('SUPPORT_PROVIDER_ACCESS_DENIED', `No Chatwoot account mapped for tenant '${tenantId}'`);
    }
    return accountId;
  }

  // Only needed for gateway-originated conversations (createConversation) - reads/replies
  // operate on a conversation that already has an inbox, this is for the case where one
  // doesn't exist yet.
  getDefaultInboxId(tenantId: string): number {
    const inboxId = config.chatwootTenantDefaultInbox[tenantId];
    if (inboxId === undefined) {
      throw new SupportProviderError('SUPPORT_PROVIDER_ACCESS_DENIED', `No default inbox configured for tenant '${tenantId}' (CHATWOOT_TENANT_DEFAULT_INBOX)`);
    }
    return inboxId;
  }
}
