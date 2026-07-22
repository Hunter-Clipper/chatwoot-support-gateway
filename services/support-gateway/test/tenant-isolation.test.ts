import { describe, expect, it } from 'vitest';
import { asTenant } from './helpers.js';

// Spec 8.1/15.1/15.2. Chatwoot's conversation `id` is a per-account display_id, not a global
// primary key - two different tenants' conversation "1" are different database rows. Getting
// tenant->account resolution wrong doesn't 404, it silently returns a different tenant's data
// under an id that looks valid. This is the single most important thing to keep passing.
describe('tenant isolation', () => {
  it('the same conversation id returns genuinely different data for different tenants', async () => {
    const { body: tenantA } = await asTenant('tenant-a', 'stub-user', '/support/conversations/1');
    const { body: tenantB } = await asTenant('tenant-b', 'tenantb-admin', '/support/conversations/1');

    expect(tenantA).not.toEqual(tenantB);
    expect((tenantA as { contact: { name: string } | null }).contact?.name).not.toBe(
      (tenantB as { contact: { name: string } | null }).contact?.name,
    );
  });

  it('rejects a session whose agent does not belong to the claimed tenant account', async () => {
    // stub-user only belongs to account 1 (tenant-a) - claiming tenant-b should be rejected,
    // not silently served against the wrong account.
    const { status } = await asTenant('tenant-b', 'stub-user', '/support/conversations/1');
    expect(status).toBe(401);
  });
});
