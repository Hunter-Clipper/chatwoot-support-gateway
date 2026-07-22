import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { SupportProviderError } from '../domain/types.js';
import type { RequestContext } from '../domain/support-provider.js';

interface SessionClaims {
  tenantId: string;
  actingUserId: string;
}

function isSessionClaims(payload: unknown): payload is SessionClaims {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>).tenantId === 'string' &&
    typeof (payload as Record<string, unknown>).actingUserId === 'string'
  );
}

// Spec section 16.1 (SupportAuthorizationService) and section 15.1: "Every gateway request
// must derive tenant context from the product session." This class only VERIFIES a session
// token and extracts context from it - it never issues one. In the real architecture, session
// issuance is the product's job (its own login/auth flow); the gateway's only role is trusting
// a signed token the product already vouches for. Issuance here exists solely as a test
// harness (scripts/issue-test-session.ts, run manually, never imported by server code) so this
// verification path can be exercised without a real Next.js app in front of it.
export class SupportAuthorizationService {
  verifySession(rawToken: string | undefined): RequestContext {
    if (!rawToken) {
      throw new SupportProviderError('SUPPORT_PROVIDER_IDENTITY_INVALID', 'Missing session token');
    }

    let payload: unknown;
    try {
      payload = jwt.verify(rawToken, config.sessionSigningSecret, { algorithms: ['HS256'] });
    } catch (error) {
      throw new SupportProviderError('SUPPORT_PROVIDER_IDENTITY_INVALID', `Invalid session token: ${(error as Error).message}`, error);
    }

    if (!isSessionClaims(payload)) {
      throw new SupportProviderError('SUPPORT_PROVIDER_IDENTITY_INVALID', 'Session token is missing required claims');
    }

    return { tenantId: payload.tenantId, actingUserId: payload.actingUserId };
  }
}
