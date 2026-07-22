import { describe, expect, it } from 'vitest';
import { gatewayFetch } from './helpers.js';

describe('health', () => {
  it('GET /healthz returns ok', async () => {
    const { status, body } = await gatewayFetch<{ status: string }>('/healthz');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('GET /readyz confirms Chatwoot is reachable', async () => {
    const { status, body } = await gatewayFetch<{ status: string; chatwoot: string }>('/readyz');
    expect(status).toBe(200);
    expect(body.chatwoot).toBe('reachable');
  });
});
