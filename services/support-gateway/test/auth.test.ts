import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';
import { gatewayFetch, mintSession } from './helpers.js';

// Codifies what was previously only manually curl-tested for SupportAuthorizationService
// (spec 15.1, 16.1). Every /support/* route is expected to behave identically here - one
// representative route (GET /support/conversations) stands in for all of them.

describe('session authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const { status, body } = await gatewayFetch<{ code: string }>('/support/conversations');
    expect(status).toBe(401);
    expect(body.code).toBe('SUPPORT_PROVIDER_IDENTITY_INVALID');
  });

  it('rejects a tampered token', async () => {
    const token = mintSession('tenant-a', 'stub-user');
    const tampered = `${token.slice(0, -1)}${token.at(-1) === 'a' ? 'b' : 'a'}`;
    const { status } = await gatewayFetch('/support/conversations', {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = jwt.sign({ tenantId: 'tenant-a', actingUserId: 'stub-user' }, config.sessionSigningSecret, {
      algorithm: 'HS256',
      expiresIn: '1s',
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const { status } = await gatewayFetch('/support/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(401);
  });

  it('rejects a well-formed session for an unregistered acting user', async () => {
    const token = mintSession('tenant-a', 'nobody-registered');
    const { status, body } = await gatewayFetch<{ code: string }>('/support/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('SUPPORT_PROVIDER_IDENTITY_INVALID');
  });

  it('rejects a session for an unmapped tenant', async () => {
    const token = mintSession('tenant-nonexistent', 'stub-user');
    const { status, body } = await gatewayFetch<{ code: string }>('/support/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('SUPPORT_PROVIDER_ACCESS_DENIED');
  });

  it('accepts a valid session', async () => {
    const token = mintSession('tenant-a', 'stub-user');
    const { status } = await gatewayFetch('/support/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
  });
});
