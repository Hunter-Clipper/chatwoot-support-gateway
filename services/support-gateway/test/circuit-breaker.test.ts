import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/providers/chatwoot/circuit-breaker.js';
import { ChatwootClient } from '../src/providers/chatwoot/chatwoot-client.js';
import { SupportProviderError } from '../src/domain/types.js';

// Pure unit tests - no network, no live stack required. Unlike almost everything else in this
// suite, circuit breaker logic is self-contained enough to test in isolation.
describe('CircuitBreaker (unit)', () => {
  it('stays closed and just rethrows below the failure threshold', async () => {
    const breaker = new CircuitBreaker(3, 50);
    const failing = () => Promise.reject(new Error('boom'));

    await expect(breaker.execute(failing)).rejects.toThrow('boom');
    await expect(breaker.execute(failing)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after the failure threshold and fails fast without calling the function', async () => {
    const breaker = new CircuitBreaker(3, 50);
    const failing = () => Promise.reject(new Error('boom'));

    await expect(breaker.execute(failing)).rejects.toThrow('boom');
    await expect(breaker.execute(failing)).rejects.toThrow('boom');
    await expect(breaker.execute(failing)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('open');

    let called = false;
    await expect(breaker.execute(async () => { called = true; })).rejects.toThrow(CircuitOpenError);
    expect(called).toBe(false); // the whole point - it never even tried
  });

  it('goes half-open after the cooldown and closes again on a successful trial', async () => {
    const breaker = new CircuitBreaker(1, 30);
    await expect(breaker.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow();
    expect(breaker.getState()).toBe('open');

    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await breaker.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(breaker.getState()).toBe('closed');
  });

  it('a failed half-open trial reopens immediately, not after re-accumulating the threshold', async () => {
    const breaker = new CircuitBreaker(3, 30);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(breaker.execute(() => Promise.reject(new Error('1')))).rejects.toThrow();
    expect(breaker.getState()).toBe('closed'); // below threshold of 3 still

    // Force it open via the threshold, then wait for the trial window.
    await expect(breaker.execute(() => Promise.reject(new Error('2')))).rejects.toThrow();
    await expect(breaker.execute(() => Promise.reject(new Error('3')))).rejects.toThrow();
    expect(breaker.getState()).toBe('open');

    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(breaker.execute(() => Promise.reject(new Error('trial failed')))).rejects.toThrow('trial failed');
    expect(breaker.getState()).toBe('open'); // reopened on the single failed trial, not closed
  });
});

// Demonstrates the actual practical value against ChatwootClient: once the breaker trips,
// subsequent calls fail in milliseconds instead of each waiting out its own request timeout.
describe('CircuitBreaker wired into ChatwootClient', () => {
  it('fails fast after repeated connection failures to an unreachable host', async () => {
    const breaker = new CircuitBreaker(2, 200);
    // Nothing listens here - a fast ECONNREFUSED, not a slow timeout, keeping this test quick.
    const client = new ChatwootClient('http://127.0.0.1:65533', breaker);

    await expect(client.get('/conversations', 1, 'irrelevant-token')).rejects.toThrow(SupportProviderError);
    await expect(client.get('/conversations', 1, 'irrelevant-token')).rejects.toThrow(SupportProviderError);
    expect(breaker.getState()).toBe('open');

    const start = Date.now();
    await expect(client.get('/conversations', 1, 'irrelevant-token')).rejects.toThrow(/circuit breaker is open/i);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(50); // failed fast - never touched the network this time
  });
});
