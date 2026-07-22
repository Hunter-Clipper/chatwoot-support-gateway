import { config } from '../../config.js';
import { SupportProviderError } from '../../domain/types.js';
import { CircuitBreaker } from './circuit-breaker.js';

const DEFAULT_TIMEOUT_MS = 5000;

// Low-level HTTP transport only: auth header, timeout, and Appendix A.2 error
// translation. No knowledge of conversations/messages shapes - that's ChatwootMapper's job.
// accountId and accessToken are required per-call arguments, not something this class owns
// or defaults - callers resolve them via TenantService and ProviderIdentityService first.
// Those are the two seams that change when the POC's flat-file mappings (spec 7.3, 8.1) are
// replaced with real per-tenant/per-agent stores; the client and everything above it stays
// the same. Getting accountId wrong is not cosmetic: Chatwoot's conversation/contact ids are
// per-account display_ids, not globally unique, so the wrong account returns a different
// tenant's data under the same id rather than a 404.
//
// One CircuitBreaker is shared across every ChatwootClient instance by default (spec 5.3) -
// all tenants ultimately depend on the same Chatwoot instance, so an outage affects everyone
// at once; there's no per-tenant breaker state to keep separate.
const sharedBreaker = new CircuitBreaker();

export class ChatwootClient {
  constructor(
    private readonly baseUrl: string = config.chatwootBaseUrl,
    private readonly breaker: CircuitBreaker = sharedBreaker,
  ) {}

  async get<T>(path: string, accountId: number, accessToken: string): Promise<T> {
    return this.request<T>('GET', path, accountId, accessToken);
  }

  async post<T>(path: string, body: unknown, accountId: number, accessToken: string): Promise<T> {
    return this.request<T>('POST', path, accountId, accessToken, body);
  }

  private async request<T>(method: string, path: string, accountId: number, accessToken: string, body?: unknown): Promise<T> {
    // Only a thrown network error/timeout or a 5xx counts as a circuit-breaker failure - a
    // 404/401/403/409 means Chatwoot is up and answering correctly, just this particular
    // request was invalid; those must not trip the breaker.
    try {
      await this.breaker.throwIfOpen();
    } catch (error) {
      throw new SupportProviderError('SUPPORT_PROVIDER_UNAVAILABLE', 'Chatwoot circuit breaker is open - failing fast without calling it', error);
    }

    const url = `${this.baseUrl}/api/v1/accounts/${accountId}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          api_access_token: accessToken,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          // The gateway calls Chatwoot directly over the internal network, bypassing the
          // public reverse proxy that normally terminates TLS and sets this header.
          // FORCE_SSL is on (spec section 15.1, network controls), so without this Chatwoot
          // 301s to https and the internal call fails. Asserting it here is only valid
          // because this call never crosses an untrusted network - it must not be set by
          // anything reachable from the browser or a customer network.
          'X-Forwarded-Proto': 'https',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      this.breaker.recordFailure();
      throw new SupportProviderError('SUPPORT_PROVIDER_UNAVAILABLE', `Chatwoot request failed: ${(error as Error).message}`, error);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 500) {
      this.breaker.recordFailure();
      throw this.translateError(response.status, await response.text());
    }
    this.breaker.recordSuccess();

    if (!response.ok) {
      throw this.translateError(response.status, await response.text());
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new SupportProviderError('SUPPORT_PROVIDER_CONTRACT_ERROR', 'Chatwoot returned a non-JSON response', error);
    }
  }

  private translateError(status: number, body: string): SupportProviderError {
    if (status === 401) return new SupportProviderError('SUPPORT_PROVIDER_IDENTITY_INVALID', 'Chatwoot rejected the API token', body);
    if (status === 403) return new SupportProviderError('SUPPORT_PROVIDER_ACCESS_DENIED', 'Chatwoot denied access to this resource', body);
    if (status === 404) return new SupportProviderError('SUPPORT_CONVERSATION_NOT_FOUND', 'Chatwoot resource not found', body);
    if (status === 409) return new SupportProviderError('SUPPORT_STATE_CONFLICT', 'Chatwoot reported a state conflict', body);
    if (status === 429) return new SupportProviderError('SUPPORT_PROVIDER_RATE_LIMITED', 'Chatwoot rate limit exceeded', body);
    if (status >= 500) return new SupportProviderError('SUPPORT_PROVIDER_UNAVAILABLE', `Chatwoot server error (${status})`, body);
    return new SupportProviderError('SUPPORT_PROVIDER_CONTRACT_ERROR', `Unexpected Chatwoot response (${status})`, body);
  }
}
