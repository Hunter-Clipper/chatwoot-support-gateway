import { db } from './database.js';

export interface LocalConversationRow {
  accountId: number;
  providerConversationId: number;
  status: string;
  subject: string | null;
  lastActivityAt: number | null;
  syncedAt: number;
  syncedVia: 'webhook' | 'reconciliation';
}

const upsertStmt = db.prepare(`
  INSERT INTO local_conversations (account_id, provider_conversation_id, status, subject, last_activity_at, synced_at, synced_via)
  VALUES (@accountId, @providerConversationId, @status, @subject, @lastActivityAt, @syncedAt, @syncedVia)
  ON CONFLICT (account_id, provider_conversation_id) DO UPDATE SET
    status = excluded.status,
    subject = excluded.subject,
    last_activity_at = excluded.last_activity_at,
    synced_at = excluded.synced_at,
    synced_via = excluded.synced_via
`);

const getStmt = db.prepare(
  'SELECT account_id as accountId, provider_conversation_id as providerConversationId, status, subject, last_activity_at as lastActivityAt, synced_at as syncedAt, synced_via as syncedVia FROM local_conversations WHERE account_id = ? AND provider_conversation_id = ?',
);

const listByAccountStmt = db.prepare(
  'SELECT account_id as accountId, provider_conversation_id as providerConversationId, status, subject, last_activity_at as lastActivityAt, synced_at as syncedAt, synced_via as syncedVia FROM local_conversations WHERE account_id = ?',
);

const deleteStmt = db.prepare('DELETE FROM local_conversations WHERE account_id = ? AND provider_conversation_id = ?');

// Spec 8.2/10.3's "local read model" - a mirror of Chatwoot conversation state, kept current
// by webhook events and repaired by ReconciliationService when webhooks are missed. This is
// intentionally minimal (status/subject/last_activity_at) - a real implementation would carry
// the full support_conversation mapping table (provider_inbox_id, linked_object_type, etc.).
export class LocalConversationStore {
  upsert(row: LocalConversationRow): void {
    upsertStmt.run(row);
  }

  get(accountId: number, providerConversationId: number): LocalConversationRow | undefined {
    return getStmt.get(accountId, providerConversationId) as LocalConversationRow | undefined;
  }

  listByAccount(accountId: number): LocalConversationRow[] {
    return listByAccountStmt.all(accountId) as LocalConversationRow[];
  }

  delete(accountId: number, providerConversationId: number): void {
    deleteStmt.run(accountId, providerConversationId);
  }
}
