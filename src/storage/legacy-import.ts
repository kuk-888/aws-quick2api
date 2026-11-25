import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { hasImport, parseJsonColumn, recordImport, transaction } from "./db.js";

/**
 * One-time import of the pre-SQLite state files into the database, so upgrading an existing
 * deployment keeps its sub-keys, upstream accounts, ledger history and probe results.
 *
 * Imported files are renamed to `<name>.imported` afterwards; nothing is deleted, and every
 * source is recorded in `import_log` so a restart never re-imports (and never resurrects
 * rows an operator deleted in the console).
 */

export interface LegacyImportResult {
  imported: string[];
  skipped: string[];
}

interface LegacyFile {
  /** File name inside the state directory. */
  name: string;
  /** Import marker recorded in `import_log`. */
  source: string;
  apply: (db: DatabaseSync, data: unknown) => number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function importGatewayKeys(db: DatabaseSync, data: unknown): number {
  if (!Array.isArray(data)) return 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO gateway_keys
      (id, name, token, enabled, allow_all_models, allowed_models, max_requests, max_concurrent,
       expires_at, created_at, source, requests, input_tokens, output_tokens, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let rows = 0;
  for (const raw of data) {
    const rec = asRecord(raw);
    const token = asString(rec?.token);
    if (!rec || !token) continue;
    const stats = asRecord(rec.stats) ?? {};
    const allowed = Array.isArray(rec.allowedModels)
      ? JSON.stringify(rec.allowedModels.filter((x): x is string => typeof x === "string"))
      : "[]";
    // Rows written before `source` existed stay `unknown` so the loader can infer env vs console.
    const source = rec.source === "env" || rec.source === "dashboard" ? rec.source : "unknown";
    insert.run(
      asString(rec.id) ?? `gk_${token.slice(0, 8)}`,
      asString(rec.name) ?? "Gateway Key",
      token,
      rec.enabled === false ? 0 : 1,
      rec.allowAllModels === false ? 0 : 1,
      allowed,
      asNumber(rec.maxRequests) ?? null,
      asNumber(rec.maxConcurrent) ?? null,
      asString(rec.expiresAt) ?? null,
      asString(rec.createdAt) ?? new Date().toISOString(),
      source,
      asNumber(stats.requests) ?? 0,
      asNumber(stats.inputTokens) ?? 0,
      asNumber(stats.outputTokens) ?? 0,
      asString(stats.lastUsedAt) ?? null,
    );
    rows += 1;
  }
  return rows;
}

function importTombstones(db: DatabaseSync, data: unknown): number {
  const hashes = (asRecord(data)?.hashes ?? []) as unknown;
  if (!Array.isArray(hashes)) return 0;
  const insert = db.prepare("INSERT OR IGNORE INTO gateway_key_tombstones (digest, revoked_at) VALUES (?, ?)");
  let rows = 0;
  for (const hash of hashes) {
    if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) {
      insert.run(hash, new Date().toISOString());
      rows += 1;
    }
  }
  return rows;
}

function importUsageLedger(db: DatabaseSync, data: unknown): number {
  const root = asRecord(data);
  if (!root) return 0;
  const bucketInsert = db.prepare(`
    INSERT OR REPLACE INTO usage_buckets
      (hour, model, routed_model, key, ip, account, requests, errors, input_tokens, cache_read_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let rows = 0;
  for (const raw of Array.isArray(root.buckets) ? root.buckets : []) {
    const b = asRecord(raw);
    const hour = asNumber(b?.hour);
    if (!b || hour === undefined) continue;
    bucketInsert.run(
      hour,
      asString(b.model) ?? "-",
      asString(b.routedModel) ?? "",
      asString(b.key) ?? "-",
      asString(b.ip) ?? "-",
      asString(b.account) ?? "-",
      asNumber(b.requests) ?? 0,
      asNumber(b.errors) ?? 0,
      asNumber(b.inputTokens) ?? 0,
      asNumber(b.cacheReadTokens) ?? 0,
      asNumber(b.outputTokens) ?? 0,
    );
    rows += 1;
  }
  const recentInsert = db.prepare("INSERT INTO usage_recent (at, payload) VALUES (?, ?)");
  const recent = Array.isArray(root.recent) ? root.recent : [];
  for (const rec of [...recent].reverse()) {
    const at = asNumber(asRecord(rec)?.at);
    if (at === undefined) continue;
    recentInsert.run(at, JSON.stringify(rec));
    rows += 1;
  }
  return rows;
}

function importEffortCapabilities(db: DatabaseSync, data: unknown): number {
  const accounts = asRecord(asRecord(data)?.accounts);
  if (!accounts) return 0;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO effort_capabilities (account, tier, state, evidence, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  let rows = 0;
  for (const [account, raw] of Object.entries(accounts)) {
    const rec = asRecord(raw);
    const state = asString(rec?.state);
    if (state !== "supported" && state !== "unsupported") continue;
    // Pre-SQLite builds only ever probed the top tier, so legacy rows belong to `max`.
    const tier = asString(rec?.tier) ?? "max";
    insert.run(
      account,
      tier,
      state,
      asString(rec?.evidence) ?? null,
      asString(rec?.updatedAt) ?? new Date().toISOString(),
    );
    rows += 1;
  }
  return rows;
}

function importAccountIdentities(db: DatabaseSync, data: unknown): number {
  const identities = asRecord(data);
  if (!identities) return 0;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO upstream_identities (slot_id, user_email, display_name, updated_at) VALUES (?, ?, ?, ?)",
  );
  let rows = 0;
  for (const [slotId, raw] of Object.entries(identities)) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const email = asString(rec.userEmail);
    const display = asString(rec.displayName);
    if (!email && !display) continue;
    insert.run(slotId, email ?? null, display ?? null, new Date().toISOString());
    rows += 1;
  }
  return rows;
}

function importAdminSecret(db: DatabaseSync, data: unknown): number {
  const hex = typeof data === "string" ? data.trim() : "";
  if (!/^[a-f0-9]{64,}$/i.test(hex)) return 0;
  db.prepare("INSERT OR REPLACE INTO app_secrets (name, value, updated_at) VALUES (?, ?, ?)").run(
    "admin-session-secret",
    hex,
    new Date().toISOString(),
  );
  return 1;
}

const LEGACY_FILES: LegacyFile[] = [
  { name: "gateway-keys.json", source: "gateway-keys.json", apply: importGatewayKeys },
  { name: "env-key-tombstones.json", source: "env-key-tombstones.json", apply: importTombstones },
  { name: "usage-ledger.json", source: "usage-ledger.json", apply: importUsageLedger },
  { name: "effort-capabilities.json", source: "effort-capabilities.json", apply: importEffortCapabilities },
  { name: "account-identities.json", source: "account-identities.json", apply: importAccountIdentities },
];

function readLegacyFile(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function importLegacyState(
  db: DatabaseSync,
  opts: { dataDir?: string; stateDir?: string },
): LegacyImportResult {
  const dirs = [...new Set([opts.stateDir, opts.dataDir].filter((d): d is string => Boolean(d && d.trim())))];
  const result: LegacyImportResult = { imported: [], skipped: [] };
  if (dirs.length === 0) return result;

  for (const dir of dirs) {
    for (const legacy of LEGACY_FILES) {
      const filePath = path.join(dir, legacy.name);
      if (!existsSync(filePath)) continue;
      if (hasImport(db, `${legacy.source}:${dir}`)) {
        result.skipped.push(legacy.name);
        continue;
      }
      try {
        const data = readLegacyFile(filePath);
        const rows = transaction(db, () => {
          const applied = legacy.apply(db, data);
          recordImport(db, `${legacy.source}:${dir}`, applied);
          return applied;
        });
        renameSync(filePath, `${filePath}.imported`);
        result.imported.push(`${legacy.name} (${rows} rows)`);
      } catch {
        // Unreadable legacy file: leave it in place and start with an empty table.
        result.skipped.push(legacy.name);
      }
    }

    // Admin session secret lives next to the state files as hex text.
    const secretPath = path.join(dir, "admin-session.key");
    if (existsSync(secretPath) && !hasImport(db, `admin-session.key:${dir}`)) {
      try {
        const raw = readFileSync(secretPath, "utf8");
        const rows = transaction(db, () => {
          const applied = importAdminSecret(db, raw);
          recordImport(db, `admin-session.key:${dir}`, applied);
          return applied;
        });
        if (rows > 0) {
          renameSync(secretPath, `${secretPath}.imported`);
          result.imported.push("admin-session.key");
        }
      } catch {
        result.skipped.push("admin-session.key");
      }
    }
  }

  return result;
}

export { parseJsonColumn };
