import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { mirrorPoolConfigToEnvFileAsync, mirrorPoolConfigToEnvFileSyncBestEffort } from "./config.js";
import {
  parseRoutedModelThinkingMode,
  parseSanitizeClientSystemPromptMode,
  type AutoDisabledState,
  type LbStrategy,
  type RoutedModelThinkingMode,
  type SanitizeClientSystemPromptMode,
} from "./types.js";

export const POOL_STATE_FILENAME = "pool-state.json";
export const POOL_STATE_VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_ENV_MIRROR_DEBOUNCE_MS = 1_500;

export interface PoolStateWriterOptions {
  debounceMs?: number;
  /** Optional `.env` path for non-blocking, long-debounced best-effort mirror on structural mutations. */
  envFilePath?: string;
  envMirrorDebounceMs?: number;
}

export interface PersistedPoolState {
  version: number;
  updatedAt: string;
  migratedFromEnvAt?: string;
  /** SHA-256 hashes of every `.env` key ever seeded/migrated (zero plaintext secrets). */
  seenEnvKeyHashes: string[];
  activeKeys: string[];
  disabledKeys: string[];
  keyLabels: Record<string, string>;
  keyProxies: Record<string, string>;
  accountGroups?: string[];
  keyGroups?: Record<string, string>;
  chatAgentId: string;
  keyChatAgentIds: Record<string, string>;
  keyAddedAt: Record<string, number>;
  keyAutoDisabled: Record<string, AutoDisabledState>;
  lbStrategy: LbStrategy;
  sessionAffinityEnabled: boolean;
  sessionAffinityTtlMs: number;
  autoDisableExhaustedKeys: boolean;
  incognitoMode: boolean;
  autoEnsureCodingAgent: boolean;
  customAgentPrompt: string;
  sanitizeClientSystemPrompt?: SanitizeClientSystemPromptMode;
  showRoutedModelInThinking?: RoutedModelThinkingMode;
  autoRephraseOnContentFilter: boolean;
  contentFilterRephrasePrompt: string;
  contentFilterRephraseModel: string;
}

export function hashEnvKeyForSeedTracking(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey.trim()).digest("hex");
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeStringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!isPlainRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

function sanitizeNumberRecord(raw: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (!isPlainRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
  }
  return out;
}

function sanitizeAutoDisabledRecord(raw: unknown): Record<string, AutoDisabledState> {
  const out: Record<string, AutoDisabledState> = Object.create(null);
  if (!isPlainRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (!isPlainRecord(v)) continue;
    const kind = v.kind === "quota" || v.kind === "auth" ? v.kind : null;
    if (!kind) continue;
    const resetAtMs = typeof v.resetAtMs === "number" && Number.isFinite(v.resetAtMs) && v.resetAtMs > 0
      ? Math.floor(v.resetAtMs)
      : undefined;
    out[k] = {
      kind,
      reason: typeof v.reason === "string" ? v.reason : "",
      ...(resetAtMs ? { resetAtMs } : {}),
    };
  }
  return out;
}

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Reads and validates `${dataDir}/pool-state.json`. Returns `null` if the file does not exist
 * (first boot / fresh upgrade from `.env`), or logs a warning and returns `null` if unreadable/corrupt.
 */
export function loadPoolStateFromDisk(stateFilePath: string): PersistedPoolState | null {
  if (!existsSync(stateFilePath)) return null;
  try {
    const raw = readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return null;
    const lbRaw = typeof parsed.lbStrategy === "string" ? parsed.lbStrategy.trim().toLowerCase() : "";
    const lbStrategy: LbStrategy =
      lbRaw === "round-robin" || lbRaw === "least-busy" || lbRaw === "quota-aware"
        ? lbRaw
        : "quota-aware";
    return {
      version: typeof parsed.version === "number" ? parsed.version : POOL_STATE_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      ...(typeof parsed.migratedFromEnvAt === "string" ? { migratedFromEnvAt: parsed.migratedFromEnvAt } : {}),
      seenEnvKeyHashes: sanitizeStringArray(parsed.seenEnvKeyHashes),
      activeKeys: sanitizeStringArray(parsed.activeKeys),
      disabledKeys: sanitizeStringArray(parsed.disabledKeys),
      keyLabels: sanitizeStringRecord(parsed.keyLabels),
      keyProxies: sanitizeStringRecord(parsed.keyProxies),
      accountGroups: sanitizeStringArray(parsed.accountGroups),
      keyGroups: sanitizeStringRecord(parsed.keyGroups),
      chatAgentId: typeof parsed.chatAgentId === "string" ? parsed.chatAgentId : "",
      keyChatAgentIds: sanitizeStringRecord(parsed.keyChatAgentIds),
      keyAddedAt: sanitizeNumberRecord(parsed.keyAddedAt),
      keyAutoDisabled: sanitizeAutoDisabledRecord(parsed.keyAutoDisabled),
      lbStrategy,
      sessionAffinityEnabled: typeof parsed.sessionAffinityEnabled === "boolean" ? parsed.sessionAffinityEnabled : true,
      sessionAffinityTtlMs:
        typeof parsed.sessionAffinityTtlMs === "number" && Number.isFinite(parsed.sessionAffinityTtlMs) && parsed.sessionAffinityTtlMs > 0
          ? Math.floor(parsed.sessionAffinityTtlMs)
          : 60 * 60 * 1000,
      autoDisableExhaustedKeys:
        typeof parsed.autoDisableExhaustedKeys === "boolean" ? parsed.autoDisableExhaustedKeys : true,
      incognitoMode: typeof parsed.incognitoMode === "boolean" ? parsed.incognitoMode : true,
      autoEnsureCodingAgent: typeof parsed.autoEnsureCodingAgent === "boolean" ? parsed.autoEnsureCodingAgent : true,
      customAgentPrompt: typeof parsed.customAgentPrompt === "string" ? parsed.customAgentPrompt : "",
      sanitizeClientSystemPrompt: parseSanitizeClientSystemPromptMode(parsed.sanitizeClientSystemPrompt),
      ...(parsed.showRoutedModelInThinking !== undefined
        ? { showRoutedModelInThinking: parseRoutedModelThinkingMode(parsed.showRoutedModelInThinking) }
        : {}),
      autoRephraseOnContentFilter:
        typeof parsed.autoRephraseOnContentFilter === "boolean" ? parsed.autoRephraseOnContentFilter : false,
      contentFilterRephrasePrompt:
        typeof parsed.contentFilterRephrasePrompt === "string" ? parsed.contentFilterRephrasePrompt : "",
      contentFilterRephraseModel:
        parsed.contentFilterRephraseModel === "quick-balanced" ? "quick-balanced" : "quick-fast",
    };
  } catch (err) {
    console.warn(
      `[pool-state] Failed to parse ${stateFilePath}; falling back to .env bootstrap:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Debounced, serialized, same-directory POSIX-atomic writer for `${dataDir}/pool-state.json`.
 * Eliminates Docker single-file bind-mount `EBUSY -> O_TRUNC` corruption risk and coalesces
 * 100-account batch/quota-sync write storms into a single non-blocking async rename.
 */
export class PoolStateWriter {
  readonly filePath: string;
  private readonly debounceMs: number;
  private readonly envFilePath?: string;
  private readonly envMirrorDebounceMs: number;
  private pendingState: PersistedPoolState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private pendingEnvMirrorState: PersistedPoolState | null = null;
  private envMirrorTimer: NodeJS.Timeout | null = null;
  private envMirrorChain: Promise<void> = Promise.resolve();
  private tmpSeq = 0;
  private writeEpoch = 0;
  private envMirrorEpoch = 0;
  private writeCount = 0;
  private envMirrorWriteCount = 0;
  private lastError: string | null = null;

  constructor(filePath: string, debounceOrOpts: number | PoolStateWriterOptions = DEFAULT_DEBOUNCE_MS) {
    this.filePath = filePath;
    if (typeof debounceOrOpts === "number") {
      this.debounceMs = Math.max(0, debounceOrOpts);
      this.envMirrorDebounceMs = DEFAULT_ENV_MIRROR_DEBOUNCE_MS;
    } else {
      this.debounceMs = Math.max(0, debounceOrOpts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
      this.envFilePath = debounceOrOpts.envFilePath;
      this.envMirrorDebounceMs = Math.max(0, debounceOrOpts.envMirrorDebounceMs ?? DEFAULT_ENV_MIRROR_DEBOUNCE_MS);
    }
  }

  getWriteCount(): number {
    return this.writeCount;
  }

  getEnvMirrorWriteCount(): number {
    return this.envMirrorWriteCount;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  schedule(state: PersistedPoolState, opts?: { mirrorToEnv?: boolean }): void {
    this.pendingState = state;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const toWrite = this.pendingState;
        this.pendingState = null;
        if (!toWrite) return;
        this.enqueueAsyncWrite(toWrite);
      }, this.debounceMs);
      this.timer.unref?.();
    }

    if (opts?.mirrorToEnv && this.envFilePath) {
      this.pendingEnvMirrorState = state;
      if (!this.envMirrorTimer) {
        this.envMirrorTimer = setTimeout(() => {
          this.envMirrorTimer = null;
          const toMirror = this.pendingEnvMirrorState;
          this.pendingEnvMirrorState = null;
          if (!toMirror) return;
          this.enqueueAsyncEnvMirror(toMirror);
        }, this.envMirrorDebounceMs);
        this.envMirrorTimer.unref?.();
      }
    }
  }

  private enqueueAsyncWrite(state: PersistedPoolState): void {
    const json = `${JSON.stringify(state, null, 2)}\n`;
    const seq = ++this.tmpSeq;
    const epoch = ++this.writeEpoch;
    const dir = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.${process.pid}.${seq}.tmp`;
    this.writeChain = this.writeChain
      .then(async () => {
        if (epoch !== this.writeEpoch) return;
        await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
        await fsPromises.writeFile(tmpPath, json, { encoding: "utf8", mode: 0o600 });
        try {
          await fsPromises.chmod(tmpPath, 0o600);
        } catch {
          // Non-POSIX filesystems
        }
        if (epoch !== this.writeEpoch) {
          try {
            await fsPromises.unlink(tmpPath);
          } catch {
            // Ignore cleanup errors
          }
          return;
        }
        await fsPromises.rename(tmpPath, this.filePath);
        this.writeCount += 1;
        this.lastError = null;
      })
      .catch(async (err) => {
        try {
          await fsPromises.unlink(tmpPath);
        } catch {
          // Ignore cleanup errors
        }
        const code = (err as NodeJS.ErrnoException)?.code;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = code === "EACCES"
          ? `Permission denied writing ${this.filePath} (run: chown -R 1000:1000 data)`
          : msg;
        console.warn(
          `[pool-state] Failed to persist ${this.filePath}${code === "EACCES" ? " (check chown -R 1000:1000 data)" : ""}:`,
          msg,
        );
      });
  }

  private enqueueAsyncEnvMirror(state: PersistedPoolState): void {
    if (!this.envFilePath) return;
    const envPath = this.envFilePath;
    const epoch = ++this.envMirrorEpoch;
    this.envMirrorChain = this.envMirrorChain
      .then(async () => {
        if (epoch !== this.envMirrorEpoch) return;
        const ok = await mirrorPoolConfigToEnvFileAsync(envPath, state);
        if (ok) this.envMirrorWriteCount += 1;
      })
      .catch(() => {
        // Best-effort mirror only; never fail or crash when `.env` is read-only.
      });
  }

  /** Waits for any scheduled + in-flight async `.env` mirror writes to settle. */
  async flushEnvMirrorAsync(): Promise<void> {
    if (this.envMirrorTimer) {
      clearTimeout(this.envMirrorTimer);
      this.envMirrorTimer = null;
    }
    if (this.pendingEnvMirrorState) {
      const toMirror = this.pendingEnvMirrorState;
      this.pendingEnvMirrorState = null;
      this.enqueueAsyncEnvMirror(toMirror);
    }
    await this.envMirrorChain;
  }

  /** Waits for any scheduled + in-flight async writes to settle (useful for tests/diagnostics). */
  async flushAsync(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingState) {
      const toWrite = this.pendingState;
      this.pendingState = null;
      this.enqueueAsyncWrite(toWrite);
    }
    await this.writeChain;
    await this.flushEnvMirrorAsync();
  }

  /**
   * Synchronous atomic flush used during graceful process shutdown (`SIGINT`/`SIGTERM`/`dispose`).
   * Guarantees zero state loss even if a debounced write or `.env` mirror has not fired yet.
   */
  flushSync(explicitState?: PersistedPoolState): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const hadPendingEnvMirror = Boolean(this.envMirrorTimer || this.pendingEnvMirrorState);
    if (this.envMirrorTimer) {
      clearTimeout(this.envMirrorTimer);
      this.envMirrorTimer = null;
    }
    const pendingMirror = this.pendingEnvMirrorState;
    this.pendingEnvMirrorState = null;

    const state = explicitState ?? this.pendingState;
    this.pendingState = null;
    if (state) {
      this.writeEpoch += 1;
      const dir = path.dirname(this.filePath);
      const tmpPath = `${this.filePath}.${process.pid}.${++this.tmpSeq}.sync.tmp`;
      const json = `${JSON.stringify(state, null, 2)}\n`;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(tmpPath, json, { encoding: "utf8", mode: 0o600 });
        try {
          chmodSync(tmpPath, 0o600);
        } catch {
          // Non-POSIX
        }
        renameSync(tmpPath, this.filePath);
        this.writeCount += 1;
        this.lastError = null;
      } catch (err) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup errors
        }
        const code = (err as NodeJS.ErrnoException)?.code;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = code === "EACCES"
          ? `Permission denied writing ${this.filePath} (run: chown -R 1000:1000 data)`
          : msg;
        console.warn(
          `[pool-state] Sync flush failed for ${this.filePath}${code === "EACCES" ? " (check chown -R 1000:1000 data)" : ""}:`,
          msg,
        );
      }
    }

    if (hadPendingEnvMirror && this.envFilePath) {
      const mirrorState = explicitState ?? pendingMirror;
      if (mirrorState) {
        this.envMirrorEpoch += 1;
        if (mirrorPoolConfigToEnvFileSyncBestEffort(this.envFilePath, mirrorState)) {
          this.envMirrorWriteCount += 1;
        }
      }
    }
  }
}
