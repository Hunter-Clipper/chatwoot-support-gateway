import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

// Durable local storage (spec 10.3/12.2's "event queue" and "local read model"). SQLite here
// is a stand-in for whatever real datastore this becomes - what matters is that state survives
// a process restart, which an in-memory Map (the earlier dedup implementation) cannot do.
mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    dedup_key TEXT PRIMARY KEY,
    event TEXT,
    received_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_conversations (
    account_id INTEGER NOT NULL,
    provider_conversation_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    subject TEXT,
    last_activity_at INTEGER,
    synced_at INTEGER NOT NULL,
    synced_via TEXT NOT NULL,
    PRIMARY KEY (account_id, provider_conversation_id)
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope, idempotency_key)
  );
`);
