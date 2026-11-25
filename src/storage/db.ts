import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Single-file SQLite state store for every piece of runtime state the gateway keeps:
 * gateway sub-keys, upstream accounts, pool settings, the usage ledger, per-account
 * thinking-effort capabilities and the admin session secret.
 *
 * The connection is shared per database path so several stores (each owning its own
 * tables) can be constructed independently without opening competing write handles.
 */

const shared = new Map<string, DatabaseSync>();

/** Schema migrations, applied in order; index = target `PRAGMA user_version`. */
const MIGRATIONS: readonly string[] = [
  // v1 — initial schema replacing the legacy JSON files and `.env` state rewrites.
  `
  CREATE TABLE IF NOT EXISTS gateway_keys (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    token             TEXT NOT NULL UNIQUE,
    enabled           INTEGER NOT NULL DEFAULT 1,
    allow_all_models  INTEGER NOT NULL DEFAULT 1,
    allowed_models    TEXT NOT NULL DEFAULT '[]',
    max_requests      INTEGER,
    max_concurrent    INTEGER,
    expires_at        TEXT,
    created_at        TEXT NOT NULL,
    source            TEXT NOT NULL DEFAULT 'dashboard',
    requests          INTEGER NOT NULL DEFAULT 0,
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    last_used_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS gateway_key_tombstones (
    digest      TEXT PRIMARY KEY,
    revoked_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upstream_accounts (
    slot_id              TEXT PRIMARY KEY,
    token                TEXT NOT NULL UNIQUE,
    auth_type            TEXT NOT NULL DEFAULT 'token',
    enabled              INTEGER NOT NULL DEFAULT 1,
    label                TEXT,
    proxy_url            TEXT,
    chat_agent_id        TEXT,
    added_at             INTEGER NOT NULL DEFAULT 0,
    auto_disabled_kind   TEXT,
    auto_disabled_reason TEXT,
    auto_reset_at        INTEGER,
    user_email           TEXT,
    display_name         TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upstream_identities (
    slot_id      TEXT PRIMARY KEY,
    user_email   TEXT,
    display_name TEXT,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pool_settings (
    id                          INTEGER PRIMARY KEY CHECK (id = 1),
    lb_strategy                 TEXT NOT NULL DEFAULT 'round-robin',
    session_affinity_enabled    INTEGER NOT NULL DEFAULT 1,
    session_affinity_ttl_ms     INTEGER NOT NULL DEFAULT 3600000,
    auto_disable_exhausted_keys INTEGER NOT NULL DEFAULT 1,
    incognito_mode              INTEGER NOT NULL DEFAULT 1,
    auto_ensure_coding_agent    INTEGER NOT NULL DEFAULT 1,
    custom_agent_prompt         TEXT,
    chat_agent_id               TEXT
  );

  CREATE TABLE IF NOT EXISTS usage_buckets (
    hour              INTEGER NOT NULL,
    model             TEXT NOT NULL,
    routed_model      TEXT NOT NULL DEFAULT '',
    key               TEXT NOT NULL,
    ip                TEXT NOT NULL,
    account           TEXT NOT NULL,
    requests          INTEGER NOT NULL DEFAULT 0,
    errors            INTEGER NOT NULL DEFAULT 0,
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, model, routed_model, key, ip, account)
  );

  CREATE TABLE IF NOT EXISTS usage_recent (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS usage_recent_at ON usage_recent (at DESC);

  CREATE TABLE IF NOT EXISTS effort_capabilities (
    account    TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    evidence   TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_secrets (
    name       TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS import_log (
    source      TEXT PRIMARY KEY,
    imported_at TEXT NOT NULL,
    rows        INTEGER NOT NULL DEFAULT 0
  );
  `,

  // v2 — thinking-effort capabilities are keyed by tier, so more tiers above `high` can be probed
  // later without another migration (today only `max` is). Legacy rows are backfilled as `max`.
  `
  CREATE TABLE IF NOT EXISTS effort_capabilities_v2 (
    account    TEXT NOT NULL,
    tier       TEXT NOT NULL,
    state      TEXT NOT NULL,
    evidence   TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account, tier)
  );
  INSERT OR IGNORE INTO effort_capabilities_v2 (account, tier, state, evidence, updated_at)
    SELECT account, 'max', state, evidence, updated_at FROM effort_capabilities;
  DROP TABLE IF EXISTS effort_capabilities;
  ALTER TABLE effort_capabilities_v2 RENAME TO effort_capabilities;
  `,
];

function applyMigrations(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version]!;
    transaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

export function openDatabase(filePath: string): DatabaseSync {
  // Ephemeral databases are never shared: two `:memory:` stores must not see each other's rows.
  if (filePath === ":memory:") {
    const memory = new DatabaseSync(":memory:");
    memory.exec("PRAGMA foreign_keys = ON");
    applyMigrations(memory);
    return memory;
  }
  const resolved = path.resolve(filePath);
  const existing = shared.get(resolved);
  if (existing) return existing;

  mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  shared.set(resolved, db);
  return db;
}

/** Resolve the database handle for a configured data directory (memory-only when unset). */
export function openDatabaseFor(dbFile: string | undefined): DatabaseSync {
  return openDatabase(dbFile && dbFile.trim() ? dbFile : ":memory:");
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore: the transaction may already be rolled back by SQLite.
    }
    throw err;
  }
}

export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function hasImport(db: DatabaseSync, source: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM import_log WHERE source = ?").get(source) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}

export function recordImport(db: DatabaseSync, source: string, rows: number): void {
  db.prepare("INSERT OR REPLACE INTO import_log (source, imported_at, rows) VALUES (?, ?, ?)").run(
    source,
    new Date().toISOString(),
    rows,
  );
}

/** Close every shared handle (tests / graceful shutdown). */
export function closeAllDatabases(): void {
  for (const db of shared.values()) {
    try {
      db.close();
    } catch {
      // Ignore close races.
    }
  }
  shared.clear();
}
