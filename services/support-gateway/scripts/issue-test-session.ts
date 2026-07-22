// Test-only. Signs a session token with the same secret SupportAuthorizationService verifies,
// so curl/tests can exercise the real verification path without a Next.js app issuing sessions.
// This script is never imported by server.ts or any route - session issuance belongs to the
// product's own auth flow in the real architecture (spec 16.1), not to this gateway.
//
// Usage: npx tsx scripts/issue-test-session.ts <tenantId> <actingUserId> [expiresIn]
import 'dotenv/config';
import jwt from 'jsonwebtoken';

const [tenantId, actingUserId, expiresIn = '15m'] = process.argv.slice(2);

if (!tenantId || !actingUserId) {
  console.error('Usage: npx tsx scripts/issue-test-session.ts <tenantId> <actingUserId> [expiresIn]');
  process.exit(1);
}

const secret = process.env.SESSION_SIGNING_SECRET;
if (!secret) {
  console.error('SESSION_SIGNING_SECRET is not set in .env');
  process.exit(1);
}

const token = jwt.sign({ tenantId, actingUserId }, secret, { algorithm: 'HS256', expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
console.log(token);
