import { config } from '../config.js';
import { SupportProviderError } from '../domain/types.js';

// Spec section 16.1 (ProviderIdentityService) and section 7.3. This now resolves a real
// per-agent token per actingUserId (backed by CHATWOOT_AGENT_TOKENS, a flat-file stand-in -
// see config.ts) instead of one shared token, so replies/notes/assignments attribute to the
// correct Chatwoot agent (spec 7.2). Still missing vs. the real design: encryption at rest,
// rotation, and revocation (spec 7.4) - this is a lookup table, not a token vault.
export class ProviderIdentityService {
  async getAccessToken(actingUserId: string): Promise<string> {
    const token = config.chatwootAgentTokens[actingUserId];
    if (!token) {
      throw new SupportProviderError('SUPPORT_PROVIDER_IDENTITY_INVALID', `No Chatwoot token registered for user '${actingUserId}'`);
    }
    return token;
  }
}
