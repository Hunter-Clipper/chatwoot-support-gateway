import { describe, expect, it, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { RateLimiter, rateLimitMiddleware } from '../src/middleware/rate-limiter.js';

// Pure unit tests, like circuit-breaker.test.ts - no network, no live stack.
describe('RateLimiter (unit)', () => {
  it('allows requests below the threshold within the window', () => {
    const limiter = new RateLimiter(1000, 3);
    expect(limiter.hit('a').limited).toBe(false);
    expect(limiter.hit('a').limited).toBe(false);
    expect(limiter.hit('a').limited).toBe(false);
  });

  it('limits once a key exceeds max requests within the window', () => {
    const limiter = new RateLimiter(1000, 2);
    expect(limiter.hit('a').limited).toBe(false);
    expect(limiter.hit('a').limited).toBe(false);
    const third = limiter.hit('a');
    expect(third.limited).toBe(true);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks separate keys independently', () => {
    const limiter = new RateLimiter(1000, 1);
    expect(limiter.hit('a').limited).toBe(false);
    expect(limiter.hit('b').limited).toBe(false); // different key, own budget
    expect(limiter.hit('a').limited).toBe(true);
  });

  it('resets once the window elapses', async () => {
    const limiter = new RateLimiter(30, 1);
    expect(limiter.hit('a').limited).toBe(false);
    expect(limiter.hit('a').limited).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(limiter.hit('a').limited).toBe(false);
  });
});

// Deliberately spins up its own throwaway Express app + RateLimiter instance rather than
// hitting the real gateway under test elsewhere in this suite - the real gateway's limiter is
// a single shared instance across every other test file (fileParallelism: false), so hammering
// it here to trip the limit would risk 429ing unrelated tests for the rest of the suite run.
describe('rateLimitMiddleware wired into Express', () => {
  let server: Server;

  afterEach(() => {
    server?.close();
  });

  it('rejects with 429 and GATEWAY_RATE_LIMITED once the limit is exceeded', async () => {
    const limiter = new RateLimiter(60_000, 2);
    const app = express();
    app.use(rateLimitMiddleware(limiter));
    app.get('/probe', (_req, res) => res.status(200).json({ ok: true }));

    const port = await new Promise<number>((resolve) => {
      server = app.listen(0, () => resolve((server.address() as { port: number }).port));
    });
    const url = `http://127.0.0.1:${port}/probe`;

    const first = await fetch(url);
    expect(first.status).toBe(200);
    const second = await fetch(url);
    expect(second.status).toBe(200);

    const third = await fetch(url);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
    const body = (await third.json()) as { code: string };
    expect(body.code).toBe('GATEWAY_RATE_LIMITED');
  });
});
