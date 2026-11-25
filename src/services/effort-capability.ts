import type { DatabaseSync } from "node:sqlite";
import type { QuickThinkingEffort } from "../aws-quick/types.js";
import { openDatabaseFor } from "../storage/db.js";

/**
 * Thinking tiers above `high` that are forwarded optimistically and probed per account.
 * Everything at or below `high` is a long-standing AWS Quick value, so it is never probed
 * and always travels verbatim.
 *
 * Probe lifecycle for each tier:
 *   - the turn completes         -> tier marked `supported`   (keep sending it)
 *   - upstream rejects the value -> tier marked `unsupported` (retry once with `high`,
 *                                   later turns go straight to `high`)
 *   - any other failure          -> capability stays `unknown` (nothing is remembered)
 *
 * Results live in the `effort_capabilities` table of the state database, one row per
 * (account, tier) pair.
 */
export const PROBED_TIERS: readonly QuickThinkingEffort[] = ["xhigh", "max"] as const;

/** Kept for callers/tests that refer to the top tier by name. */
export const MAX_EFFORT: QuickThinkingEffort = "max";

/** Tier used when a probed tier is disabled or the account was proven not to support it. */
export const EFFORT_FALLBACK: QuickThinkingEffort = "high";

export type EffortCapability = "unknown" | "supported" | "unsupported";

interface CapabilityEntry {
  state: EffortCapability;
  evidence?: string;
  updatedAt?: string;
}

const EVIDENCE_LIMIT = 200;
const MAX_TRACKED_ENTRIES = 200;
const KEY_SEPARATOR = "\u0000";

const EFFORT_HINT = /thinking[_\s-]?effort|thinking-?budget|\beffort\b|reasoning|thinking/i;
const INVALID_HINT =
  /invalid|unsupported|not\s+supported|not\s+recogni[sz]ed|unrecogni[sz]ed|unknown|illegal|out\s+of\s+range|must\s+be\s+one\s+of|allowed\s+values?|not\s+allowed|validation/i;

/** True for tiers that are forwarded optimistically and therefore worth probing. */
export function isProbedTier(effort: QuickThinkingEffort): boolean {
  return PROBED_TIERS.includes(effort);
}

/**
 * Heuristic: does this upstream error look like a rejected `thinking_effort` value
 * (as opposed to quota / rate-limit / auth / transient transport failures)?
 */
export function looksLikeUnsupportedEffortError(message: string | undefined): boolean {
  if (!message || !message.trim()) return false;
  return EFFORT_HINT.test(message) && INVALID_HINT.test(message);
}

/** `THINKING_EFFORT_MAX_PASSTHROUGH=false` pins every probed tier to `high` (kill switch). */
export function maxEffortPassthroughEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.THINKING_EFFORT_MAX_PASSTHROUGH?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no" || raw === "disabled");
}

/**
 * Per-account memory of which thinking tiers AWS Quick accepts, persisted in the
 * `effort_capabilities` table (only masked account labels are stored, never credentials).
 */
export class EffortCapabilityRegistry {
  private readonly db: DatabaseSync;
  private readonly entries = new Map<string, CapabilityEntry>();
  private readonly passthroughEnabled: boolean;

  constructor(dbFile?: string, opts: { passthrough?: boolean } = {}) {
    this.db = openDatabaseFor(dbFile);
    this.passthroughEnabled = opts.passthrough ?? maxEffortPassthroughEnabled();
    this.load();
  }

  get maxEffortEnabled(): boolean {
    return this.passthroughEnabled;
  }

  stateFor(accountKey: string, tier: QuickThinkingEffort = MAX_EFFORT): EffortCapability {
    return this.entries.get(this.keyOf(accountKey, tier))?.state ?? "unknown";
  }

  /** Decide the tier actually sent upstream for this account, and whether it was degraded. */
  resolveEffort(
    accountKey: string,
    requested: QuickThinkingEffort,
  ): { effort: QuickThinkingEffort; downgraded: boolean } {
    if (!isProbedTier(requested)) return { effort: requested, downgraded: false };
    if (!this.passthroughEnabled || this.stateFor(accountKey, requested) === "unsupported") {
      return { effort: EFFORT_FALLBACK, downgraded: true };
    }
    return { effort: requested, downgraded: false };
  }

  /** Upstream completed a turn that asked for this tier: the account supports it. */
  markSupported(accountKey: string, tier: QuickThinkingEffort = MAX_EFFORT): void {
    if (!this.passthroughEnabled) return;
    if (!isProbedTier(tier)) return;
    const existing = this.entries.get(this.keyOf(accountKey, tier));
    if (existing?.state === "supported") return;
    this.record(accountKey, tier, "supported");
  }

  /** Upstream explicitly rejected the tier: remember it so later turns skip the probe. */
  markUnsupported(accountKey: string, tier: QuickThinkingEffort = MAX_EFFORT, evidence?: string): void {
    if (!isProbedTier(tier)) return;
    this.record(accountKey, tier, "unsupported", evidence);
  }

  snapshot(): {
    maxEffortPassthrough: boolean;
    probedTiers: QuickThinkingEffort[];
    fallbackEffort: QuickThinkingEffort;
    supported: number;
    unsupported: number;
    accounts: Array<{
      account: string;
      tier: QuickThinkingEffort;
      state: EffortCapability;
      evidence?: string;
      updatedAt?: string;
    }>;
  } {
    let supported = 0;
    let unsupported = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "supported") supported += 1;
      else if (entry.state === "unsupported") unsupported += 1;
    }
    return {
      maxEffortPassthrough: this.passthroughEnabled,
      probedTiers: [...PROBED_TIERS],
      fallbackEffort: EFFORT_FALLBACK,
      supported,
      unsupported,
      accounts: [...this.entries.entries()].map(([key, entry]) => {
        const [account = "", tier = MAX_EFFORT] = key.split(KEY_SEPARATOR);
        return {
          account,
          tier: tier as QuickThinkingEffort,
          state: entry.state,
          ...(entry.evidence ? { evidence: entry.evidence } : {}),
          ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        };
      }),
    };
  }

  /** No-op kept for callers that used to flush a JSON file; SQLite writes are immediate. */
  flush(): void {}

  private keyOf(accountKey: string, tier: QuickThinkingEffort): string {
    const account = (accountKey || "unknown").trim() || "unknown";
    return `${account}${KEY_SEPARATOR}${tier}`;
  }

  private record(
    accountKey: string,
    tier: QuickThinkingEffort,
    state: EffortCapability,
    evidence?: string,
  ): void {
    const account = (accountKey || "unknown").trim() || "unknown";
    const key = this.keyOf(account, tier);
    const entry: CapabilityEntry = {
      state,
      ...(evidence ? { evidence: evidence.replace(/\s+/g, " ").trim().slice(0, EVIDENCE_LIMIT) } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_TRACKED_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const [oldAccount = "", oldTier = MAX_EFFORT] = oldest.value.split(KEY_SEPARATOR);
      this.entries.delete(oldest.value);
      this.db
        .prepare("DELETE FROM effort_capabilities WHERE account = ? AND tier = ?")
        .run(oldAccount, oldTier);
    }
    this.db
      .prepare(
        "INSERT INTO effort_capabilities (account, tier, state, evidence, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(account, tier) DO UPDATE SET state = excluded.state, evidence = excluded.evidence, updated_at = excluded.updated_at",
      )
      .run(account, tier, entry.state, entry.evidence ?? null, entry.updatedAt ?? new Date().toISOString());
  }

  private load(): void {
    const rows = this.db
      .prepare("SELECT account, tier, state, evidence, updated_at FROM effort_capabilities ORDER BY updated_at ASC")
      .all() as Array<{
      account: string;
      tier: string;
      state: string;
      evidence: string | null;
      updated_at: string | null;
    }>;
    for (const row of rows) {
      if (row.state !== "supported" && row.state !== "unsupported") continue;
      const tier = row.tier as QuickThinkingEffort;
      if (!isProbedTier(tier)) continue;
      this.entries.set(this.keyOf(row.account, tier), {
        state: row.state,
        ...(row.evidence ? { evidence: row.evidence } : {}),
        ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
      });
    }
  }
}
