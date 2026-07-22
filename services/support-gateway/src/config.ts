import 'dotenv/config';
import { z } from 'zod';

// CHATWOOT_AGENT_TOKENS is a JSON object mapping actingUserId -> that agent's personal
// Chatwoot access token, e.g. {"stub-user": "...", "jordan-tech": "..."}. This is a flat-file
// stand-in for the real per-agent token store (spec 7.1: application_user / token_version /
// rotated_at, encrypted at rest) - see ProviderIdentityService for where this gets replaced.
const agentTokensSchema = z.record(z.string(), z.string().min(1));

// CHATWOOT_TENANT_ACCOUNTS is a JSON object mapping tenantId -> Chatwoot account_id, e.g.
// {"tenant-a": 1, "tenant-b": 2}. Spec section 8.1: "map one product tenant to one Chatwoot
// account." Chatwoot's own conversation/contact ids are display_ids, sequential *per account*
// - two different tenants' conversation "1" are different database rows - so resolving the
// wrong account for a tenant doesn't 404, it silently returns a different tenant's data. This
// map is what TenantService uses instead of the single global CHATWOOT_ACCOUNT_ID.
const tenantAccountsSchema = z.record(z.string(), z.coerce.number());

// CHATWOOT_WEBHOOK_SECRETS is a JSON object mapping tenantId -> that tenant's own webhook
// signing secret. Discovered the hard way: each Chatwoot account's Webhook record gets its own
// independently-generated secret (has_secure_token, not something you can pin to a shared
// value) - a single global secret verifies account 1's deliveries fine and silently rejects
// every other account's as a signature mismatch. The webhook route is parametrized by tenantId
// (/internal/support/chatwoot/webhooks/:tenantId) so the verifier knows which secret to use
// before it ever trusts anything in the (unverified-until-checked) request body.
const webhookSecretsSchema = z.record(z.string(), z.string().min(1));

// CHATWOOT_TENANT_DEFAULT_INBOX is a JSON object mapping tenantId -> the Chatwoot inbox_id new,
// gateway-originated conversations get created against, e.g. {"tenant-a": 1, "tenant-b": 3}.
// Ticket creation has no natural inbox of its own (it isn't an inbound email/widget message) -
// every tenant needs one nominated inbox to create against. Not in Appendix A.1 - this is new
// scope, confirmed as a real (if not yet urgent) requirement.
const tenantDefaultInboxSchema = z.record(z.string(), z.coerce.number());

// CHATWOOT_RECONCILIATION_ACTORS is a JSON object mapping tenantId -> the actingUserId
// (an existing key in CHATWOOT_AGENT_TOKENS) that scheduled reconciliation runs "as" for that
// tenant. Reuses the same acknowledged shortcut as agent tokens generally (spec 7.4 - a real
// service credential belongs here eventually, not a borrowed personal agent token). A tenant
// missing an entry here just doesn't get reconciled on a schedule (still reachable on-demand
// via the route).
const reconciliationActorsSchema = z.record(z.string(), z.string().min(1));

const configSchema = z.object({
  port: z.coerce.number().default(4000),
  chatwootBaseUrl: z.string().url(),
  chatwootAccountId: z.coerce.number(),
  chatwootApiToken: z.string().min(1),
  chatwootWebhookSecrets: webhookSecretsSchema,
  chatwootAgentTokens: agentTokensSchema,
  chatwootTenantAccounts: tenantAccountsSchema,
  chatwootTenantDefaultInbox: tenantDefaultInboxSchema.default({}),
  chatwootReconciliationActors: reconciliationActorsSchema.default({}),
  // Signs/verifies the product-session tokens SupportAuthorizationService checks. In the real
  // architecture this would be the product's own session/JWT signing key, shared with (or
  // rotated via a JWKS endpoint for) the gateway - not something the gateway itself issues
  // tokens with. See scripts/issue-test-session.ts for why this is only used for verification
  // in server code, plus a clearly-separate test-only issuance path.
  sessionSigningSecret: z.string().min(1),
  // Local read model + durable webhook-delivery dedup (spec 10.3, 12.2). SQLite is a stand-in
  // for whatever real datastore this becomes - the point being demonstrated is durability
  // across process restarts and reconciliation, not the specific engine.
  databasePath: z.string().min(1).default('./data/gateway.sqlite'),
  // Appendix B: "rate limits configured on the gateway itself" - Chatwoot has its own
  // Rack::Attack, but nothing previously protected the gateway process itself from a caller
  // (buggy or malicious) hammering it. Fixed-window, per-client-IP, in-memory - resetting on
  // restart is fine for this purpose, unlike the durability-sensitive stores above.
  rateLimitWindowMs: z.coerce.number().default(60_000),
  rateLimitMaxRequests: z.coerce.number().default(600),
  // Appendix B: "reconciliation scheduled periodically" - was on-demand only via the route.
  // 0 disables the scheduler entirely (on-demand still works); default is 5 minutes.
  reconciliationIntervalMs: z.coerce.number().default(300_000),
});

export type Config = z.infer<typeof configSchema>;

function parseJsonRecord<T>(raw: string | undefined, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(raw ?? '{}'));
}

export const config: Config = configSchema.parse({
  port: process.env.PORT,
  chatwootBaseUrl: process.env.CHATWOOT_BASE_URL,
  chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID,
  chatwootApiToken: process.env.CHATWOOT_API_TOKEN,
  chatwootWebhookSecrets: parseJsonRecord(process.env.CHATWOOT_WEBHOOK_SECRETS, webhookSecretsSchema),
  chatwootAgentTokens: parseJsonRecord(process.env.CHATWOOT_AGENT_TOKENS, agentTokensSchema),
  chatwootTenantAccounts: parseJsonRecord(process.env.CHATWOOT_TENANT_ACCOUNTS, tenantAccountsSchema),
  chatwootTenantDefaultInbox: parseJsonRecord(process.env.CHATWOOT_TENANT_DEFAULT_INBOX, tenantDefaultInboxSchema),
  chatwootReconciliationActors: parseJsonRecord(process.env.CHATWOOT_RECONCILIATION_ACTORS, reconciliationActorsSchema),
  sessionSigningSecret: process.env.SESSION_SIGNING_SECRET,
  databasePath: process.env.DATABASE_PATH,
  rateLimitWindowMs: process.env.RATE_LIMIT_WINDOW_MS,
  rateLimitMaxRequests: process.env.RATE_LIMIT_MAX_REQUESTS,
  reconciliationIntervalMs: process.env.RECONCILIATION_INTERVAL_MS,
});
