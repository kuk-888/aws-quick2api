import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeAccountGroup } from "../core/key-pool.js";
import { GatewayError, type GatewayConfig } from "../core/types.js";
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
  /** Optional bound account group for strict pool isolation (`null` = unrestricted global pool). */
  accountGroup: string | null;
  /** Maximum total requests allowed; `null` = unlimited. */
  maxRequests: number | null;
  /** Max simultaneous in-flight requests for this key; `null` = use the gateway default (unlimited unless configured). */
  maxConcurrent: number | null;
  /** Max simultaneous in-flight inference requests per client IP for this key; `null` = unlimited. */
  perIpMaxConcurrent: number | null;
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
  accountGroup: string | null;
  maxRequests: number | null;
  maxConcurrent: number | null;
  perIpMaxConcurrent: number | null;
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
    accountGroup: string | null;
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
  private readonly stateFilePath?: string;
  /** SHA-256 digests (never plaintext) of `.env` tokens the operator explicitly deleted in the console. */
  private readonly tombstoneFilePath?: string;
  private readonly tombstones = new Set<string>();
  private persistTimer: NodeJS.Timeout | null = null;
  private persistWriteChain: Promise<void> = Promise.resolve();
  private persistEpoch = 0;
  private persistTmpSeq = 0;
  /** Notable startup reconciliation events (pruned / suppressed env keys) for the caller to log. */
  readonly startupEvents: Array<{ event: string; id: string; name: string }> = [];

  constructor(config: Pick<GatewayConfig, "gatewayTokens" | "envFilePath" | "dataDir">) {
    const dir = config.dataDir ?? (config.envFilePath ? path.dirname(config.envFilePath) : undefined);
    if (dir) {
      this.stateFilePath = path.join(dir, "gateway-keys.json");
      this.tombstoneFilePath = path.join(dir, "env-key-tombstones.json");
    }
    this.loadAndSeed(config.gatewayTokens);
  }

  private loadTombstones(): void {
    if (!this.tombstoneFilePath || !existsSync(this.tombstoneFilePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.tombstoneFilePath, "utf8")) as unknown;
      const hashes = raw && typeof raw === "object" ? (raw as { hashes?: unknown }).hashes : undefined;
      if (Array.isArray(hashes)) {
        for (const h of hashes) if (typeof h === "string" && /^[a-f0-9]{64}$/.test(h)) this.tombstones.add(h);
      }
    } catch {
      // Corrupt tombstone file: ignore (worst case an env key is re-seeded once and can be deleted again).
    }
  }

  private persistTombstones(): void {
    if (!this.tombstoneFilePath) return;
    const dir = path.dirname(this.tombstoneFilePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.tombstoneFilePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ v: 1, hashes: [...this.tombstones].sort() }, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Ignore on platforms/filesystems without POSIX chmod
    }
    renameSync(tmpPath, this.tombstoneFilePath);
  }

  private loadAndSeed(envTokens: ReadonlySet<string>): void {
    let loadedFromFile = false;
    let changed = false;
    let tombstonesChanged = false;
    this.loadTombstones();
    if (this.stateFilePath && existsSync(this.stateFilePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.stateFilePath, "utf8")) as unknown;
        if (Array.isArray(raw)) {
          loadedFromFile = true;
          for (const item of raw) {
            if (!item || typeof item !== "object") continue;
            const rec = item as Record<string, unknown>;
            const token = typeof rec.token === "string" ? rec.token.trim() : "";
            if (!token) continue;
            const allowedList = Array.isArray(rec.allowedModels)
              ? rec.allowedModels.filter((x): x is string => typeof x === "string").map((m) => normalizeBaseModelId(m))
              : [];
            const st = rec.stats && typeof rec.stats === "object" ? (rec.stats as Record<string, unknown>) : {};
            // Files written before `source` existed: a key whose token is currently in `.env` is env-managed, the rest are console keys.
            let source: ClientKeySource;
            if (rec.source === "env" || rec.source === "dashboard") {
              source = rec.source;
            } else {
              source = envTokens.has(token) ? "env" : "dashboard";
              changed = true;
            }
            let expiresAt: string | null = null;
            try {
              expiresAt = normalizeExpiresAt(rec.expiresAt);
            } catch {
              expiresAt = null;
            }
            let loadedGroup: string | null = null;
            if (typeof rec.accountGroup === "string" && rec.accountGroup.trim()) {
              try {
                loadedGroup = normalizeAccountGroup(rec.accountGroup) ?? null;
              } catch {
                loadedGroup = null;
              }
            }
            this.keys.push({
              id: typeof rec.id === "string" && rec.id ? rec.id : `gk_${crypto.randomBytes(4).toString("hex")}`,
              name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : "Gateway Key",
              token,
              enabled: rec.enabled !== false,
              allowAllModels: rec.allowAllModels !== false,
              allowedModels: new Set(allowedList),
              accountGroup: loadedGroup,
              maxRequests: normalizeMaxRequests(rec.maxRequests),
              maxConcurrent: normalizeMaxRequests(rec.maxConcurrent),
              perIpMaxConcurrent: normalizeMaxRequests(rec.perIpMaxConcurrent),
              expiresAt,
              createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date().toISOString(),
              source,
              stats: {
                requests: typeof st.requests === "number" ? st.requests : 0,
                inputTokens: typeof st.inputTokens === "number" ? st.inputTokens : 0,
                outputTokens: typeof st.outputTokens === "number" ? st.outputTokens : 0,
                ...(typeof st.lastUsedAt === "string" ? { lastUsedAt: st.lastUsedAt } : {})
              }
            });
          }
        }
      } catch {
        // Fall through to env seeding
      }
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
        name: idx === 1 && !loadedFromFile ? "Default Gateway Key" : `Env Key #${idx}`,
        token: tok,
        enabled: true,
        allowAllModels: true,
        allowedModels: new Set(),
        accountGroup: null,
        maxRequests: null,
        maxConcurrent: null,
        perIpMaxConcurrent: null,
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

  private serializeKeysPayload(): string {
    const payload = this.keys.map((k) => ({
      id: k.id,
      name: k.name,
      token: k.token,
      enabled: k.enabled,
      allowAllModels: k.allowAllModels,
      allowedModels: [...k.allowedModels].sort(),
      accountGroup: k.accountGroup,
      maxRequests: k.maxRequests,
      maxConcurrent: k.maxConcurrent,
      perIpMaxConcurrent: k.perIpMaxConcurrent,
      expiresAt: k.expiresAt,
      createdAt: k.createdAt,
      source: k.source,
      stats: k.stats
    }));
    return JSON.stringify(payload, null, 2) + "\n";
  }

  private persist(): void {
    if (!this.stateFilePath) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistEpoch += 1;
    const dir = path.dirname(this.stateFilePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.stateFilePath}.${process.pid}.${++this.persistTmpSeq}.tmp`;
    writeFileSync(tmpPath, this.serializeKeysPayload(), { mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Ignore
    }
    renameSync(tmpPath, this.stateFilePath);
  }

  private enqueueAsyncPersist(): void {
    if (!this.stateFilePath) return;
    const targetPath = this.stateFilePath;
    const epoch = ++this.persistEpoch;
    const serialized = this.serializeKeysPayload();
    this.persistWriteChain = this.persistWriteChain
      .then(async () => {
        if (epoch !== this.persistEpoch) return;
        const tmpPath = `${targetPath}.${process.pid}.${++this.persistTmpSeq}.tmp`;
        try {
          await mkdir(path.dirname(targetPath), { recursive: true });
          await writeFile(tmpPath, serialized, { mode: 0o600 });
          await chmod(tmpPath, 0o600).catch(() => { });
          if (epoch !== this.persistEpoch) {
            await unlink(tmpPath).catch(() => { });
            return;
          }
          await rename(tmpPath, targetPath);
        } catch {
          await unlink(tmpPath).catch(() => { });
        }
      })
      .catch(() => { });
  }

  private schedulePersist(): void {
    if (!this.stateFilePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.enqueueAsyncPersist();
    }, 2000);
    this.persistTimer.unref?.();
  }

  /** Effective concurrency cap for a key: its own setting, else the gateway default (0 = unlimited). */
  concurrencyLimitFor(keyId: string, defaultLimit: number): number {
    const k = this.keys.find((x) => x.id === keyId);
    return k?.maxConcurrent ?? defaultLimit;
  }

  /** Effective per-IP concurrency cap for a key (`0` = unlimited). */
  perIpConcurrencyLimitFor(keyId: string): number {
    const k = this.keys.find((x) => x.id === keyId);
    return k?.perIpMaxConcurrent ?? 0;
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
        allowedModels: matchedManaged.allowedModels,
        accountGroup: matchedManaged.accountGroup,
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
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.enqueueAsyncPersist();
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
    accountGroup?: string | null;
    maxRequests?: unknown;
    maxConcurrent?: unknown;
    perIpMaxConcurrent?: unknown;
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
    const accountGroup = normalizeAccountGroup(params.accountGroup) ?? null;

    const entry: InternalClientKey = {
      id: `gk_${crypto.randomBytes(8).toString("hex")}`,
      name,
      token,
      enabled: params.enabled !== false,
      allowAllModels,
      allowedModels: allowedSet,
      accountGroup,
      maxRequests: normalizeMaxRequests(params.maxRequests),
      maxConcurrent: normalizeMaxRequests(params.maxConcurrent),
      perIpMaxConcurrent: normalizeMaxRequests(params.perIpMaxConcurrent),
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
      accountGroup?: string | null;
      maxRequests?: unknown;
      maxConcurrent?: unknown;
      perIpMaxConcurrent?: unknown;
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

    const nextName = typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : entry.name;
    const nextEnabled = typeof patch.enabled === "boolean" ? patch.enabled : entry.enabled;
    const nextAccountGroup =
      patch.accountGroup !== undefined ? (normalizeAccountGroup(patch.accountGroup) ?? null) : entry.accountGroup;
    const nextMaxRequests =
      patch.maxRequests !== undefined ? normalizeMaxRequests(patch.maxRequests) : entry.maxRequests;
    const nextMaxConcurrent =
      patch.maxConcurrent !== undefined ? normalizeMaxRequests(patch.maxConcurrent) : entry.maxConcurrent;
    const nextPerIpMaxConcurrent =
      patch.perIpMaxConcurrent !== undefined ? normalizeMaxRequests(patch.perIpMaxConcurrent) : entry.perIpMaxConcurrent;
    const nextExpiresAt =
      patch.expiresAt !== undefined ? normalizeExpiresAt(patch.expiresAt) : entry.expiresAt;

    entry.name = nextName;
    entry.enabled = nextEnabled;
    entry.allowAllModels = nextAllowAll;
    entry.allowedModels = nextAllowed;
    entry.accountGroup = nextAccountGroup;
    entry.maxRequests = nextMaxRequests;
    entry.maxConcurrent = nextMaxConcurrent;
    entry.perIpMaxConcurrent = nextPerIpMaxConcurrent;
    entry.expiresAt = nextExpiresAt;
    if (patch.resetRequests === true) {
      entry.stats.requests = 0;
    }

    this.persist();
    return this.toView(entry);
  }

  countByAccountGroup(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const k of this.keys) {
      if (k.accountGroup) {
        counts.set(k.accountGroup, (counts.get(k.accountGroup) ?? 0) + 1);
      }
    }
    return counts;
  }

  renameAccountGroup(oldName: string, newName: string): number {
    const normOld = normalizeAccountGroup(oldName);
    const normNew = normalizeAccountGroup(newName);
    if (!normOld || !normNew || normOld === normNew) return 0;
    const touched: Array<(typeof this.keys)[number]> = [];
    for (const k of this.keys) {
      if (k.accountGroup === normOld) {
        k.accountGroup = normNew;
        touched.push(k);
      }
    }
    if (touched.length > 0) {
      try {
        this.persist();
      } catch (err) {
        for (const k of touched) k.accountGroup = normOld;
        throw err;
      }
    }
    return touched.length;
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
      accountGroup: k.accountGroup,
      maxRequests: k.maxRequests,
      maxConcurrent: k.maxConcurrent,
      perIpMaxConcurrent: k.perIpMaxConcurrent,
      expiresAt: k.expiresAt,
      isExpired,
      isQuotaExhausted,
      createdAt: k.createdAt,
      source: k.source,
      stats: { ...k.stats }
    };
  }
}
