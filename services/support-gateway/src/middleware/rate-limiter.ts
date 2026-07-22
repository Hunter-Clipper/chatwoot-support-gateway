import type { RequestHandler } from 'express';

// Fixed-window counter, keyed per client. In-memory and reset on restart is an accepted
// tradeoff here - unlike webhook dedup/idempotency keys, losing a rate-limit window on
// deploy has no correctness consequence, just a brief reset of the count.
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  hit(key: string): { limited: boolean; retryAfterMs: number } {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return { limited: false, retryAfterMs: 0 };
    }

    entry.count += 1;
    if (entry.count > this.maxRequests) {
      return { limited: true, retryAfterMs: this.windowMs - (now - entry.windowStart) };
    }
    return { limited: false, retryAfterMs: 0 };
  }
}

// Keyed by req.ip - since every call here is expected to come via the in-house app's own
// backend (not directly from end-user browsers), this protects the gateway process as a
// whole from a runaway/misbehaving caller rather than rate-limiting individual end users.
// That's a deliberate scope choice, not an oversight: per-tenant/per-session limiting would
// need this to run after SupportAuthorizationService.verifySession(), which happens inside
// each route handler, not in shared app-level middleware.
export function rateLimitMiddleware(limiter: RateLimiter): RequestHandler {
  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const result = limiter.hit(key);
    if (result.limited) {
      res.status(429).set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000))).json({
        code: 'GATEWAY_RATE_LIMITED',
        message: 'Too many requests to the support gateway from this client - retry after the window resets',
      });
      return;
    }
    next();
  };
}
