import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { GatewayError, type GatewayConfig } from "../core/types.js";
import { openDatabaseFor, parseJsonColumn, transaction } from "../storage/db.js";
import { safeStringEquals } from "../utils/hash.js";
import { normalizeBaseModelId } from "./model-access.js";

/**
 * Where a gateway key came from:
 * - `env`: seeded from `GATEWAY_TOKEN` in `.env` (declarative bootstrap; removing the token from `.env` removes the key).
 * - `dashboard`: created in the Web Console (fully managed by the console, never touched by `.env`).
 */
export type ClientKeySource = "env" | "dashboard";

export interface ClientKeyStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  lastUsedAt?: string;
}

export interface ClientGatewayKeyView {
  id: string;
  name: string;
  maskedToken: string;
  enabled: boolean;
  allowAllModels: boolean;
  allowedModels: string[];
  /** Maximum total requests allowed; `null` = unlimited. */
  maxRequests: number | null;
  /** Max simultaneous in-flight requests for this key; `null` = use the gateway default (unlimited unless configured). */
  maxConcurrent: number | null;
  /** ISO-8601 expiration timestamp; `null` = never expires. */
  expiresAt: string | null;
  isExpired: boolean;
  isQuotaExhausted: boolean;
  createdAt: string;
  source: ClientKeySource;
  stats: ClientKeyStats;
}

interface InternalClientKey {
  id: string;
  name: string;
  token: string;
  enabled: boolean;
  allowAllModels: boolean;
  allowedModels: Set<string>;
  maxRequests: number | null;
  maxConcurrent: number | null;
  expiresAt: string | null;
  createdAt: string;
  source: ClientKeySource;
  stats: ClientKeyStats;
}

export type AuthenticatedClientIdentity =
  | {
      kind: "gateway_key";
      keyId: string;
      keyName: string;
      allowAllModels: boolean;
      allowedModels: ReadonlySet<string>;
    };

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function maskGatewayToken(tok: string): string {
  if (tok.length < 24) return `${tok.slice(0, 2)}***`;
  return `${tok.slice(0, 8)}...${tok.slice(-4)}`;
}

function normalizeMaxRequests(val: unknown): number | null {
  if (val === null || val === undefined || val === "" || val === 0) return null;
  const n = typeof val === "number" ? Math.floor(val) : Number.parseInt(String(val), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeExpiresAt(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val !== "string" || !val.trim()) return null;
  const ms = Date.parse(val.trim());
  if (!Number.isFinite(ms)) {
    throw new GatewayError("Invalid expiration timestamp; provide a valid date-time.", 400, "invalid_expires_at");
  }
  return new Date(ms).toISOString();
}

export class ClientGatewayKeyManager {
  private readonly keys: InternalClientKey[] = [];
  private readonly db: DatabaseSync;
  /** SHA-256 digests (never plaintext) of `.env` tokens the operator explicitly deleted in the console. */
  private readonly tombstones = new Set<string>();
  private persistTimer: NodeJS.Timeout | null = null;
  /** Notable startup reconciliation events (pruned / suppressed env keys) for the caller to log. */
  readonly startupEvents: Array<{ event: string; id: string; name: string }> = [];

  constructor(config: Pick<GatewayConfig, "gatewayTokens" | "dbFile">) {
    this.db = openDatabaseFor(config.dbFile);
    this.loadAndSeed(config.gatewayTokens);
  }

  private loadTombstones(): void {
    try {
      const rows = this.db.prepare("SELECT digest FROM gateway_key_tombstones").all() as Array<{ digest: string }>;
      for (const row of rows) {
        if (/^[a-f0-9]{64}$/.test(row.digest)) this.tombstones.add(row.digest);
      }
    } catch {
      // Unreadable tombstone table: worst case an env key is re-seeded once and can be deleted again.
    }
  }

  private persistTombstones(): void {
    transaction(this.db, () => {
      this.db.exec("DELETE FROM gateway_key_tombstones");
      const insert = this.db.prepare("INSERT OR REPLACE INTO gateway_key_tombstones (digest, revoked_at) VALUES (?, ?)");
      const now = new Date().toISOString();
      for (const digest of this.tombstones) insert.run(digest, now);
    });
  }


  private loadAndSeed(envTokens: ReadonlySet<string>): void {
    let loadedFromDatabase = false;
    let changed = false;
    let tombstonesChanged = false;
    this.loadTombstones();
    try {
      const rows = this.db
        .prepare(
          "SELECT id, name, token, enabled, allow_all_models, allowed_models, max_requests, max_concurrent, " +
            "expires_at, created_at, source, requests, input_tokens, output_tokens, last_used_at FROM gateway_keys",
        )
        .all() as Array<Record<string, unknown>>;
      if (rows.length > 0) loadedFromDatabase = true;
      for (const row of rows) {
        const token = typeof row.token === "string" ? row.token.trim() : "";
        if (!token) continue;
        const allowedList = parseJsonColumn<string[]>(row.allowed_models, [])
          .filter((m): m is string => typeof m === "string")
          .map((m) => normalizeBaseModelId(m));
        let source: ClientKeySource;
        if (row.source === "env" || row.source === "dashboard") {
          source = row.source;
        } else {
          // Rows written before `source` existed: a token currently in `.env` is env-managed.
          source = envTokens.has(token) ? "env" : "dashboard";
          changed = true;
        }
        let expiresAt: string | null = null;
        try {
          expiresAt = normalizeExpiresAt(row.expires_at);
        } catch {
          expiresAt = null;
        }
        const lastUsedAt = typeof row.last_used_at === "string" ? row.last_used_at : undefined;
        this.keys.push({
          id: typeof row.id === "string" && row.id ? row.id : `gk_${crypto.randomBytes(4).toString("hex")}`,
          name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : "Gateway Key",
          token,
          enabled: Number(row.enabled) !== 0,
          allowAllModels: Number(row.allow_all_models) !== 0,
          allowedModels: new Set(allowedList),
          maxRequests: normalizeMaxRequests(row.max_requests),
          maxConcurrent: normalizeMaxRequests(row.max_concurrent),
          expiresAt,
          createdAt: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
          source,
          stats: {
            requests: Number(row.requests) || 0,
            inputTokens: Number(row.input_tokens) || 0,
            outputTokens: Number(row.output_tokens) || 0,
            ...(lastUsedAt ? { lastUsedAt } : {}),
          },
        });
      }
    } catch {
      // Fall through to env seeding
    }

    // `.env` GATEWAY_TOKEN is a declarative bootstrap, not a permanent override of the console:
    //  1) env-sourced keys whose token was removed from `.env` (rotation) or was deleted in the console are dropped;
    //  2) tombstones for tokens no longer in `.env` are forgotten, so deliberately re-adding a token later re-seeds it;
    //  3) env tokens that are not tombstoned and not yet known are seeded once.
    const envHashes = new Map<string, string>();
    for (const tok of envTokens) envHashes.set(tok, sha256Hex(tok));
    for (let i = this.keys.length - 1; i >= 0; i -= 1) {
      const k = this.keys[i]!;
      if (k.source !== "env") continue;
      const removedFromEnv = !envTokens.has(k.token);
      const deletedInConsole = this.tombstones.has(sha256Hex(k.token));
      if (removedFromEnv || deletedInConsole) {
        this.keys.splice(i, 1);
        this.startupEvents.push({ event: removedFromEnv ? "gateway_env_key_pruned" : "gateway_env_key_tombstoned", id: k.id, name: k.name });
        changed = true;
      }
    }
    const liveHashes = new Set(envHashes.values());
    for (const h of [...this.tombstones]) {
      if (!liveHashes.has(h)) {
        this.tombstones.delete(h);
        tombstonesChanged = true;
      }
    }

    let idx = this.keys.filter((k) => k.source === "env").length;
    for (const tok of envTokens) {
      const digest = envHashes.get(tok)!;
      if (this.tombstones.has(digest)) continue;
      if (this.keys.some((k) => k.token === tok)) continue;
      idx += 1;
      this.keys.push({
        id: `gk_${digest.slice(0, 8)}`,
        name: idx === 1 && !loadedFromDatabase ? "Default Gateway Key" : `Env Key #${idx}`,
        token: tok,
        enabled: true,
        allowAllModels: true,
        allowedModels: new Set(),
        maxRequests: null,
        maxConcurrent: null,
        expiresAt: null,
        createdAt: new Date().toISOString(),
        source: "env",
        stats: { requests: 0, inputTokens: 0, outputTokens: 0 }
      });
      changed = true;
    }

    if (tombstonesChanged) this.persistTombstones();
    if (changed) this.persist();
  }

  /** Sync the in-memory key list into SQLite (insert/update present rows, delete removed ones). */
  private persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const upsert = this.db.prepare(`
      INSERT INTO gateway_keys
        (id, name, token, enabled, allow_all_models, allowed_models, max_requests, max_concurrent,
         expires_at, created_at, source, requests, input_tokens, output_tokens, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, token = excluded.token, enabled = excluded.enabled,
        allow_all_models = excluded.allow_all_models, allowed_models = excluded.allowed_models,
        max_requests = excluded.max_requests, max_concurrent = excluded.max_concurrent,
        expires_at = excluded.expires_at, source = excluded.source,
        requests = excluded.requests, input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens, last_used_at = excluded.last_used_at
    `);
    transaction(this.db, () => {
      const ids = this.keys.map((k) => k.id);
      const placeholders = ids.map(() => "?").join(",") || "''";
      this.db.prepare(`DELETE FROM gateway_keys WHERE id NOT IN (${placeholders})`).run(...ids);
      for (const k of this.keys) {
        upsert.run(
          k.id,
          k.name,
          k.token,
          k.enabled ? 1 : 0,
          k.allowAllModels ? 1 : 0,
          JSON.stringify([...k.allowedModels].sort()),
          k.maxRequests,
          k.maxConcurrent,
          k.expiresAt,
          k.createdAt,
          k.source,
          k.stats.requests,
          k.stats.inputTokens,
          k.stats.outputTokens,
          k.stats.lastUsedAt ?? null,
        );
      }
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.persist();
      } catch {
        // Best-effort periodic flush
      }
    }, 2000);
    this.persistTimer.unref?.();
  }

  /** Effective concurrency cap for a key: its own setting, else the gateway default (0 = unlimited). */
  concurrencyLimitFor(keyId: string, defaultLimit: number): number {
    const k = this.keys.find((x) => x.id === keyId);
    return k?.maxConcurrent ?? defaultLimit;
  }

  authenticateClient(clientToken: string, opts: { checkQuotaCap?: boolean } = {}): AuthenticatedClientIdentity {
    const trimmed = clientToken.trim();
    let matchedManaged: InternalClientKey | undefined;
    for (const k of this.keys) {
      if (safeStringEquals(k.token, trimmed)) {
        matchedManaged = k;
      }
    }

    if (matchedManaged) {
      if (!matchedManaged.enabled) {
        throw new GatewayError(`Gateway API key '${matchedManaged.name}' is disabled.`, 403, "api_key_disabled");
      }
      if (matchedManaged.expiresAt && Date.now() >= Date.parse(matchedManaged.expiresAt)) {
        throw new GatewayError(
          `Gateway API key '${matchedManaged.name}' expired at ${matchedManaged.expiresAt}.`,
          403,
          "api_key_expired"
        );
      }
      if (
        opts.checkQuotaCap !== false &&
        matchedManaged.maxRequests !== null &&
        matchedManaged.stats.requests >= matchedManaged.maxRequests
      ) {
        throw new GatewayError(
          `Gateway API key '${matchedManaged.name}' has reached its maximum request limit (${matchedManaged.stats.requests}/${matchedManaged.maxRequests}).`,
          429,
          "api_key_quota_exceeded"
        );
      }
      return {
        kind: "gateway_key",
        keyId: matchedManaged.id,
        keyName: matchedManaged.name,
        allowAllModels: matchedManaged.allowAllModels,
        allowedModels: matchedManaged.allowedModels
      };
    }

    // Upstream AWS Quick credentials (local-outpost or raw JWT) must never be accepted as client gateway keys.
    if (trimmed === "local-outpost" || trimmed.startsWith("eyJ")) {
      throw new GatewayError("Invalid or missing gateway API key.", 401, "authentication_error");
    }

    // Reject requests when no client key matches (open mode is intentionally unsupported).
    throw new GatewayError("Invalid or missing gateway API key.", 401, "authentication_error");
  }

  filterModelsForClient<T extends { id: string }>(
    auth: AuthenticatedClientIdentity,
    models: readonly T[]
  ): T[] {
    if (auth.kind !== "gateway_key" || auth.allowAllModels) {
      return [...models];
    }
    return models.filter((m) => auth.allowedModels.has(normalizeBaseModelId(m.id)));
  }

  assertModelPermitted(auth: AuthenticatedClientIdentity, requestedModel: string): void {
    if (auth.kind !== "gateway_key" || auth.allowAllModels) return;
    const norm = normalizeBaseModelId(requestedModel);
    if (!auth.allowedModels.has(norm)) {
      throw new GatewayError(
        `Gateway key '${auth.keyName}' is not authorized to access model '${norm}'.`,
        403,
        "model_not_allowed_for_key",
        "model"
      );
    }
  }

  tryReserveRequest(keyId: string | undefined): void {
    if (!keyId) return;
    const found = this.keys.find((k) => k.id === keyId);
    if (!found) return;
    if (found.maxRequests !== null && found.stats.requests >= found.maxRequests) {
      throw new GatewayError(
        `Gateway API key '${found.name}' has reached its maximum request limit (${found.stats.requests}/${found.maxRequests}).`,
        429,
        "api_key_quota_exceeded"
      );
    }
    found.stats.requests += 1;
    found.stats.lastUsedAt = new Date().toISOString();
    if (found.maxRequests !== null && found.stats.requests >= found.maxRequests) {
      this.persist();
    } else {
      this.schedulePersist();
    }
  }

  recordUsage(keyId: string | undefined, inputTokens: number, outputTokens: number): void {
    if (!keyId) return;
    const found = this.keys.find((k) => k.id === keyId);
    if (!found) return;
    found.stats.inputTokens += inputTokens;
    found.stats.outputTokens += outputTokens;
    found.stats.lastUsedAt = new Date().toISOString();
    this.schedulePersist();
  }

  flushStatsToDisk(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  listKeys(): ClientGatewayKeyView[] {
    return this.keys.map((k) => this.toView(k));
  }

  revealKeyToken(id: string): string {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry) throw new GatewayError(`Gateway key '${id}' not found.`, 404, "not_found");
    return entry.token;
  }

  createKey(params: {
    name: string;
    customToken?: string;
    enabled?: boolean;
    allowAllModels?: boolean;
    allowedModels?: readonly string[];
    maxRequests?: unknown;
    maxConcurrent?: unknown;
    expiresAt?: unknown;
  }): { view: ClientGatewayKeyView; rawToken: string } {
    const name = params.name.trim() || "New Sub-Key";
    const token = params.customToken?.trim() || `sk-aq-${crypto.randomBytes(18).toString("hex")}`;
    if (token.length < 6) {
      throw new GatewayError("Custom gateway token must be at least 6 characters.", 400, "invalid_request_error");
    }
    if (this.keys.some((k) => k.token === token)) {
      throw new GatewayError("A gateway key with this token already exists.", 400, "duplicate_token");
    }

    const allowAllModels = params.allowAllModels !== false;
    const allowedSet = new Set(
      (params.allowedModels ?? []).map((m) => normalizeBaseModelId(m)).filter(Boolean)
    );
    if (!allowAllModels && allowedSet.size === 0) {
      throw new GatewayError("Select at least one allowed model under custom allowlist mode.", 400, "empty_model_allowlist");
    }

    const entry: InternalClientKey = {
      id: `gk_${crypto.randomBytes(8).toString("hex")}`,
      name,
      token,
      enabled: params.enabled !== false,
      allowAllModels,
      allowedModels: allowedSet,
      maxRequests: normalizeMaxRequests(params.maxRequests),
      maxConcurrent: normalizeMaxRequests(params.maxConcurrent),
      expiresAt: normalizeExpiresAt(params.expiresAt),
      createdAt: new Date().toISOString(),
      source: "dashboard",
      stats: { requests: 0, inputTokens: 0, outputTokens: 0 }
    };

    // Explicitly re-creating a previously deleted `.env` token in the console is an intentional re-add.
    const digest = sha256Hex(token);
    if (this.tombstones.delete(digest)) this.persistTombstones();

    this.keys.push(entry);
    this.persist();
    return { view: this.toView(entry), rawToken: entry.token };
  }

  updateKey(
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      allowAllModels?: boolean;
      allowedModels?: readonly string[];
      maxRequests?: unknown;
      maxConcurrent?: unknown;
      expiresAt?: unknown;
      resetRequests?: boolean;
    }
  ): ClientGatewayKeyView {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry) throw new GatewayError(`Gateway key '${id}' not found.`, 404, "not_found");

    const nextAllowAll = typeof patch.allowAllModels === "boolean" ? patch.allowAllModels : entry.allowAllModels;
    const nextAllowed = Array.isArray(patch.allowedModels)
      ? new Set(patch.allowedModels.map((m) => normalizeBaseModelId(m)).filter(Boolean))
      : entry.allowedModels;
    if (!nextAllowAll && nextAllowed.size === 0) {
      throw new GatewayError("Select at least one allowed model under custom allowlist mode.", 400, "empty_model_allowlist");
    }

    if (typeof patch.name === "string" && patch.name.trim()) {
      entry.name = patch.name.trim();
    }
    if (typeof patch.enabled === "boolean") {
      entry.enabled = patch.enabled;
    }
    entry.allowAllModels = nextAllowAll;
    entry.allowedModels = nextAllowed;
    if (patch.maxRequests !== undefined) {
      entry.maxRequests = normalizeMaxRequests(patch.maxRequests);
    }
    if (patch.maxConcurrent !== undefined) {
      entry.maxConcurrent = normalizeMaxRequests(patch.maxConcurrent);
    }
    if (patch.expiresAt !== undefined) {
      entry.expiresAt = normalizeExpiresAt(patch.expiresAt);
    }
    if (patch.resetRequests === true) {
      entry.stats.requests = 0;
    }

    this.persist();
    return this.toView(entry);
  }

  /**
   * Delete a key. Deleting a key that came from `.env` records a tombstone (token digest) so the next restart
   * does not silently re-create it; delete therefore always means revoke.
   */
  deleteKey(id: string): { source: ClientKeySource } {
    const idx = this.keys.findIndex((k) => k.id === id);
    if (idx < 0) throw new GatewayError(`Gateway key '${id}' not found.`, 404, "not_found");
    const entry = this.keys[idx]!;
    if (entry.source === "env") {
      const digest = sha256Hex(entry.token);
      if (!this.tombstones.has(digest)) {
        this.tombstones.add(digest);
        try {
          this.persistTombstones();
        } catch (err) {
          this.tombstones.delete(digest);
          throw err;
        }
      }
    }
    this.keys.splice(idx, 1);
    this.persist();
    return { source: entry.source };
  }

  private toView(k: InternalClientKey): ClientGatewayKeyView {
    const now = Date.now();
    const isExpired = k.expiresAt !== null && now >= Date.parse(k.expiresAt);
    const isQuotaExhausted = k.maxRequests !== null && k.stats.requests >= k.maxRequests;
    return {
      id: k.id,
      name: k.name,
      maskedToken: maskGatewayToken(k.token),
      enabled: k.enabled,
      allowAllModels: k.allowAllModels,
      allowedModels: [...k.allowedModels].sort(),
      maxRequests: k.maxRequests,
      maxConcurrent: k.maxConcurrent,
      expiresAt: k.expiresAt,
      isExpired,
      isQuotaExhausted,
      createdAt: k.createdAt,
      source: k.source,
      stats: { ...k.stats }
    };
  }
}
