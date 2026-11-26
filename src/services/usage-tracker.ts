import { maskSecretKey } from "../core/key-pool.js";
import type { TurnTokenMetrics } from "../core/types.js";

export type ExecutionModeTag = "incognito" | "cloud" | "fresh" | "warm_incremental" | "parked_tool_resume";

export interface BucketCounters {
  requests: number;
  freshRuns: number;
  warmIncrementalHits: number;
  parkedToolResumes: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function emptyCounters(): BucketCounters {
  return {
    requests: 0,
    freshRuns: 0,
    warmIncrementalHits: 0,
    parkedToolResumes: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0
  };
}

function addInto(target: BucketCounters, mode: ExecutionModeTag, metrics: TurnTokenMetrics): void {
  target.requests += 1;
  if (mode === "fresh" || mode === "incognito" || mode === "cloud") target.freshRuns += 1;
  else if (mode === "warm_incremental") target.warmIncrementalHits += 1;
  else if (mode === "parked_tool_resume") target.parkedToolResumes += 1;

  target.inputTokens += metrics.inputTokens;
  target.cacheReadTokens += metrics.cacheReadTokens;
  target.cacheWriteTokens += metrics.cacheWriteTokens;
  target.outputTokens += metrics.outputTokens;
  target.reasoningTokens += metrics.reasoningTokens ?? 0;
}

/**
 * Real-time gateway usage & Prompt Cache hit-rate ledger (`GET /v1/usage`).
 * Works out-of-the-box with zero extra cookies.
 */
export class UsageTracker {
  private readonly startedAt = new Date().toISOString();
  private readonly totals = emptyCounters();
  private readonly byModel = new Map<string, BucketCounters>();
  private readonly byAccountKey = new Map<string, BucketCounters>();

  recordTurn(params: {
    apiKey: string;
    modelId: string;
    mode: ExecutionModeTag;
    metrics: TurnTokenMetrics;
  }): void {
    addInto(this.totals, params.mode, params.metrics);

    const modelBucket = this.byModel.get(params.modelId) ?? emptyCounters();
    addInto(modelBucket, params.mode, params.metrics);
    this.byModel.set(params.modelId, modelBucket);

    const masked = maskSecretKey(params.apiKey);
    const keyBucket = this.byAccountKey.get(masked) ?? emptyCounters();
    addInto(keyBucket, params.mode, params.metrics);
    this.byAccountKey.set(masked, keyBucket);
  }

  snapshot() {
    const totalPrompt = this.totals.inputTokens + this.totals.cacheReadTokens + this.totals.cacheWriteTokens;
    const cacheHitRatePercent = totalPrompt > 0
      ? Number(((this.totals.cacheReadTokens / totalPrompt) * 100).toFixed(2))
      : 0;

    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      cacheHitRatePercent,
      totals: { ...this.totals },
      byModel: Object.fromEntries(this.byModel.entries()),
      byAccount: Object.fromEntries(this.byAccountKey.entries())
    };
  }
}
