import { describe, test } from 'vitest';

// Spec section 18 (Test and Acceptance Plan) and section 20's production readiness gate list
// specific acceptance criteria. These are the ones NOT covered anywhere else in this suite -
// either because the underlying capability isn't built, or because it hasn't been exercised
// yet. Listed as test.todo() rather than left out of the suite entirely, so `npm test` output
// shows them as pending - a gap that only lives in a README can be missed; one that shows up
// in every test run is harder to forget about. See services/support-gateway/README.md's
// "Deliberately not implemented yet" section for the full narrative on each.
describe('known gaps against the spec acceptance plan (intentionally not implemented/tested)', () => {
  test.todo('18.1: inbound reply to an existing thread creates one message, not a duplicate conversation (email threading - never tested)');
  test.todo('18.1: attachments upload/retrieve/authorize/scan in both directions (not implemented - outside SupportProvider interface, spec 11.1 vs Appendix A mismatch)');
  test.todo('18.1: priority updates (not implemented - same interface mismatch as attachments)');
  test.todo('18.1: product-side audit records identify the acting agent (SupportAuditService not built)');
  test.todo('18.1: ticket linkage persists to a product-owned object through provider updates (support_conversation mapping table not built - needs the in-house app\'s ticket ID scheme)');
  test.todo('18.3: inbound HTML is sanitized before being handed to a UI (no sanitization exists anywhere in this gateway - whichever app renders message content is currently responsible for this)');
  test.todo('18.3: administrative Chatwoot UI is not publicly accessible to ordinary product users (currently gated by login only, not also by network-level restriction per spec 3.3)');
  test.todo('Appendix B: enterprise/ exclusion verified, SBOM generated, dependency license scanning run (needs legal/security review, not just engineering - spec 4.2 says "have counsel review")');
  test.todo('Appendix B: agent tokens encrypted at rest and rotated (currently a flat-file .env map, spec 7.4)');
  test.todo('Appendix A.1 / spec 6.2: POST /internal/support/provisioning/users never built - every account/agent/inbox in this project has been provisioned via ad-hoc rails runner scripts and direct Platform API calls, not one controlled gateway-owned workflow');
  test.todo('Spec 6.2 / Appendix B: no isolated Platform App token - provisioning has reused personal agent/admin tokens directly rather than one dedicated token scoped only to provisioning');
  test.todo('Spec 12.4: no observability layer - no correlation ID threaded from Next.js through the gateway into Chatwoot calls, no latency/error-rate/queue-depth/webhook-lag/reconciliation-drift metrics, only ad-hoc console.log');
  test.todo('Spec 15.1: rate limiting is IP-only, not the "per-user, per-tenant, and provider-aware limits" the spec literally asks for (a deliberate scope choice when built, but never logged as a gap against this wording)');
  test.todo('Appendix B: Redis and Sidekiq worker monitoring not configured');
  test.todo('Appendix B: object storage is local disk (ACTIVE_STORAGE_SERVICE=local), not private/encrypted object storage with lifecycle policies');
  test.todo('Spec 15.1: data retention/legal-hold/deletion policy for messages and attachments not addressed anywhere');
  test.todo('Appendix B: rollback runbook specifically (reverting a bad upgrade in place) not separately drilled - only forward upgrade and independent backup/restore have been tested');
  test.todo('Appendix B: incident response ownership not documented');
});
