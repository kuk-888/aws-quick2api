import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { QuickThinkingEffort } from "../aws-quick/types.js";

/**
 * Top thinking tier that is forwarded to AWS Quick optimistically.
 * The gateway does not know up-front whether an account accepts it, so the first
 * `max` turn doubles as a capability probe:
 *   - the turn completes         -> account marked `supported`   (keep sending `max`)
 *   - upstream rejects the value -> account marked `unsupported` (retry once with `high`,
 *                                   later turns go straight to `high`)
 *   - any other failure          -> capability stays `unknown`   (nothing is remembered)
 */
export const MAX_EFFORT = "max" as const;

/** Tier used when `max` is disabled or the account was proven not to support it. */
export const EFFORT_FALLBACK: QuickThinkingEffort = "high";

export type EffortCapability = "unknown" | "supported" | "unsupported";

/** Per-account probe result for the `max` thinking tier. */
interface CapabilityEntry {
  state: EffortCapability;
  evidence?: string;
  updatedAt?: string;
}

interface CapabilityFile {
  v: number;
  accounts: Record<string, { state?: string; evidence?: string; updatedAt?: string }>;
}

const FILE_VERSION = 1;
const EVIDENCE_LIMIT = 200;
const MAX_TRACKED_ACCOUNTS = 200;
const SAVE_DEBOUNCE_MS = 500;

const EFFORT_HINT = /thinking[_\s-]?effort|thinking-?budget|\beffort\b|reasoning|thinking/i;
const INVALID_HINT =
  /invalid|unsupported|not\s+supported|not\s+recogni[sz]ed|unrecogni[sz]ed|unknown|illegal|out\s+of\s+range|must\s+be\s+one\s+of|allowed\s+values?|not\s+allowed|validation/i;

/**
 * Heuristic: does this upstream error look like a rejected `thinking_effort` value
 * (as opposed to quota / rate-limit / auth / transient transport failures)?
 */
export function looksLikeUnsupportedEffortError(message: string | undefined): boolean {
  if (!message || !message.trim()) return false;
  return EFFORT_HINT.test(message) && INVALID_HINT.test(message);
}

/** `THINKING_EFFORT_MAX_PASSTHROUGH=false` pins every request to `high` (kill switch). */
export function maxEffortPassthroughEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.THINKING_EFFORT_MAX_PASSTHROUGH?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no" || raw === "disabled");
}

/**
 * Per-account memory of whether AWS Quick accepts `thinking_effort: "max"`.
 * Survives restarts through `<DATA_DIR>/effort-capabilities.json` (no secrets stored,
 * only masked account labels already used by the usage ledger).
 */
export class EffortCapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry>();
  private readonly filePath?: string;
  private readonly passthroughEnabled: boolean;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(filePath?: string, opts: { passthrough?: boolean } = {}) {
    this.filePath = filePath;
    this.passthroughEnabled = opts.passthrough ?? maxEffortPassthroughEnabled();
    this.load();
  }

  get maxEffortEnabled(): boolean {
    return this.passthroughEnabled;
  }

  stateFor(accountKey: string): EffortCapability {
    return this.entries.get(accountKey)?.state ?? "unknown";
  }

  /** Decide the tier actually sent upstream for this account, and whether it was degraded. */
  resolveEffort(
    accountKey: string,
    requested: QuickThinkingEffort,
  ): { effort: QuickThinkingEffort; downgraded: boolean } {
    if (requested !== MAX_EFFORT) return { effort: requested, downgraded: false };
    if (!this.passthroughEnabled || this.stateFor(accountKey) === "unsupported") {
      return { effort: EFFORT_FALLBACK, downgraded: true };
    }
    return { effort: MAX_EFFORT, downgraded: false };
  }

  /** Upstream completed a turn that asked for `max`: this account supports the tier. */
  markSupported(accountKey: string): void {
    if (!this.passthroughEnabled) return;
    const existing = this.entries.get(accountKey);
    if (existing?.state === "supported") return;
    this.record(accountKey, "supported");
  }

  /** Upstream explicitly rejected the tier: remember it so later turns skip the probe. */
  markUnsupported(accountKey: string, evidence?: string): void {
    this.record(accountKey, "unsupported", evidence);
  }

  snapshot(): {
    maxEffortPassthrough: boolean;
    fallbackEffort: QuickThinkingEffort;
    supported: number;
    unsupported: number;
    accounts: Array<{ account: string; state: EffortCapability; evidence?: string; updatedAt?: string }>;
  } {
    let supported = 0;
    let unsupported = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "supported") supported += 1;
      else if (entry.state === "unsupported") unsupported += 1;
    }
    return {
      maxEffortPassthrough: this.passthroughEnabled,
      fallbackEffort: EFFORT_FALLBACK,
      supported,
      unsupported,
      accounts: [...this.entries.entries()].map(([account, entry]) => ({
        account,
        state: entry.state,
        ...(entry.evidence ? { evidence: entry.evidence } : {}),
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
      })),
    };
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.filePath) {
      this.dirty = false;
      return;
    }
    this.dirty = false;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload: CapabilityFile = { v: FILE_VERSION, accounts: {} };
      for (const [account, entry] of this.entries) {
        payload.accounts[account] = {
          state: entry.state,
          ...(entry.evidence ? { evidence: entry.evidence } : {}),
          ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        };
      }
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch {
      this.dirty = true; // keep the in-memory view; retry on the next mutation
    }
  }

  private record(accountKey: string, state: EffortCapability, evidence?: string): void {
    const key = (accountKey || "unknown").trim() || "unknown";
    const entry: CapabilityEntry = {
      state,
      ...(evidence ? { evidence: evidence.replace(/\s+/g, " ").trim().slice(0, EVIDENCE_LIMIT) } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_TRACKED_ACCOUNTS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as CapabilityFile;
      for (const [account, raw] of Object.entries(parsed?.accounts ?? {})) {
        const state = raw?.state;
        if (state !== "supported" && state !== "unsupported") continue;
        this.entries.set(account, {
          state,
          ...(typeof raw.evidence === "string" && raw.evidence ? { evidence: raw.evidence.slice(0, EVIDENCE_LIMIT) } : {}),
          ...(typeof raw.updatedAt === "string" && raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
        });
      }
    } catch {
      // Corrupt/unreadable capability cache is not fatal: fall back to "probe again".
      this.entries.clear();
    }
  }
}
