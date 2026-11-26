import crypto from "node:crypto";
import type { TurnTokenMetrics } from "./types.js";

/**
 * Generates a W3C `traceparent` header/field matching official AWS Quick desktop frames:
 * `00-<32-hex traceId>-<16-hex spanId>-01`
 */
export function buildTraceparent(traceId: string): string {
  const cleanTrace = traceId.replace(/-/g, "").toLowerCase();
  const tracePart = /^[0-9a-f]{32}$/.test(cleanTrace)
    ? cleanTrace
    : crypto.randomBytes(16).toString("hex");
  const spanPart = crypto.randomBytes(8).toString("hex");
  return `00-${tracePart}-${spanPart}-01`;
}

export interface RawTurnUsagePayload {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextWindow: number;
  contextPercent: number;
  resolvedModel?: string;
}

/**
 * Pure, I/O-free per-turn protocol tracker for AWS Quick S2C WebSocket streams.
 *
 * Solves three capture-verified failure modes:
 * 1. Multi-step cloud tool turns emit multiple `turn_usage` frames per user turn
 *    (e.g. `file_read_image`, `load_skill`, Python sandbox). Aggregating across steps
 *    prevents 2x-3x token over-counting and avoids flushing premature intermediate usage.
 * 2. Tracking active cloud tools (`tool_start` .. `tool_result`) prevents the post-usage
 *    completion watchdog from killing slow cloud tool executions mid-flight.
 * 3. Tracking `_transport.sequence`, `message_start.message_id`, and `tree_sync` branch IDs
 *    enables native `ping.ack`, native `stop_generation` cancellation, and exact branch sync.
 */
export class TurnProtocolTracker {
  private lastAckSequence: string | undefined;
  private assistantMessageId: string | undefined;
  private readonly activeCloudTools = new Set<string>();
  private sawCloudTool = false;
  private thinkingOpen = false;

  private usageCount = 0;
  private cumulativeOutputTokens = 0;
  private latestInputTokens = 0;
  private latestCacheReadTokens = 0;
  private latestCacheWriteTokens = 0;
  private maxTotalTokens = 0;
  private maxContextWindow = 0;
  private maxContextPercent = 0;
  private resolvedModel: string | undefined;

  observeTransport(ev: Record<string, unknown>): void {
    const tr = ev._transport;
    if (tr && typeof tr === "object" && !Array.isArray(tr)) {
      const seq = (tr as Record<string, unknown>).sequence;
      if (typeof seq === "string" && seq.trim()) {
        this.lastAckSequence = seq.trim();
      } else if (typeof seq === "number" && Number.isFinite(seq)) {
        this.lastAckSequence = String(seq);
      }
    }
    const turnMsgId = typeof ev.turn_message_id === "string" ? ev.turn_message_id.trim() : "";
    const msgId = typeof ev.message_id === "string" ? ev.message_id.trim() : "";
    if (!this.assistantMessageId && (turnMsgId || (ev.type === "message_start" && msgId))) {
      this.assistantMessageId = turnMsgId || msgId;
    } else if (ev.type === "message_start" && msgId) {
      this.assistantMessageId = msgId;
    }
  }

  getLastAckSequence(): string | undefined {
    return this.lastAckSequence;
  }

  getAssistantMessageId(): string | undefined {
    return this.assistantMessageId;
  }

  onThinkingStart(): void {
    this.thinkingOpen = true;
  }

  onThinkingComplete(): void {
    this.thinkingOpen = false;
  }

  isThinkingOpen(): boolean {
    return this.thinkingOpen;
  }

  onCloudToolStart(toolId: string | undefined, toolName: string | undefined): void {
    this.sawCloudTool = true;
    const key = (toolId && toolId.trim()) || (toolName && toolName.trim()) || `tool_${this.activeCloudTools.size + 1}`;
    this.activeCloudTools.add(key);
  }

  onCloudToolResult(toolId: string | undefined, toolName: string | undefined): void {
    if (toolId && this.activeCloudTools.delete(toolId.trim())) return;
    if (toolName && this.activeCloudTools.delete(toolName.trim())) return;
    // Fallback if upstream omitted tool_id on result
    if (!toolId && !toolName && this.activeCloudTools.size === 1) {
      this.activeCloudTools.clear();
    }
  }

  hasActiveCloudTools(): boolean {
    return this.activeCloudTools.size > 0;
  }

  hasSeenCloudTools(): boolean {
    return this.sawCloudTool;
  }

  setResolvedModel(model: string): void {
    if (model.trim()) this.resolvedModel = model.trim();
  }

  getResolvedModel(): string | undefined {
    return this.resolvedModel;
  }

  /**
   * Records a `turn_usage` frame, ignoring all-zero placeholder frames emitted on guardrail/empty turns.
   * Returns `true` when non-zero usage was recorded.
   */
  recordTurnUsage(u: RawTurnUsagePayload): boolean {
    if (u.resolvedModel) this.resolvedModel = u.resolvedModel;
    if (u.contextWindow > 0) {
      this.maxContextWindow = Math.max(this.maxContextWindow, u.contextWindow);
    }
    const computedTotal =
      u.totalTokens > 0
        ? u.totalTokens
        : u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    const isAllZero =
      computedTotal === 0 &&
      u.inputTokens === 0 &&
      u.outputTokens === 0 &&
      u.cacheReadTokens === 0 &&
      u.cacheWriteTokens === 0;
    if (isAllZero) return false;

    const effectiveWin = this.maxContextWindow > 0 ? this.maxContextWindow : 1_000_000;
    const computedPercent =
      u.contextPercent > 0
        ? Math.round(u.contextPercent * 10) / 10
        : Math.round((computedTotal / effectiveWin) * 1000) / 10;

    this.usageCount += 1;
    this.latestInputTokens = u.inputTokens;
    this.latestCacheReadTokens = u.cacheReadTokens;
    this.latestCacheWriteTokens = u.cacheWriteTokens;
    // Sum output tokens across multi-step internal cloud tool invocations within a single turn.
    this.cumulativeOutputTokens += u.outputTokens;
    this.maxTotalTokens = Math.max(this.maxTotalTokens, computedTotal);
    this.maxContextPercent = Math.max(this.maxContextPercent, computedPercent);
    return true;
  }

  hasUsage(): boolean {
    return this.usageCount > 0;
  }

  getMaxTotalTokens(): number {
    return this.maxTotalTokens;
  }

  getMaxContextWindow(): number {
    return this.maxContextWindow;
  }

  getMaxContextPercent(): number {
    return this.maxContextPercent;
  }

  buildFinalMetrics(): TurnTokenMetrics | null {
    if (this.usageCount === 0) return null;
    return {
      inputTokens: this.latestInputTokens,
      outputTokens: this.cumulativeOutputTokens,
      cacheReadTokens: this.latestCacheReadTokens,
      cacheWriteTokens: this.latestCacheWriteTokens,
      totalTokens: this.maxTotalTokens,
      ...(this.maxContextWindow > 0 ? { contextWindow: this.maxContextWindow } : {}),
      contextPercent: this.maxContextPercent,
      ...(this.resolvedModel ? { resolvedModel: this.resolvedModel } : {}),
    };
  }

  /**
   * Extracts active branch / root session updates from an AWS Quick `tree_sync` payload.
   */
  static parseTreeSync(payload: Record<string, unknown>): {
    activeBranchId?: string;
    rootSessionId?: string;
  } {
    const activeBranchId =
      typeof payload.active_branch_id === "string" && payload.active_branch_id.trim()
        ? payload.active_branch_id.trim()
        : undefined;
    const rootSessionId =
      typeof payload.root_session_id === "string" && payload.root_session_id.trim()
        ? payload.root_session_id.trim()
        : undefined;
    return {
      ...(activeBranchId ? { activeBranchId } : {}),
      ...(rootSessionId ? { rootSessionId } : {}),
    };
  }
}
