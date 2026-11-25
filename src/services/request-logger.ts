import crypto from "node:crypto";
import type { ParsedProtocolTurn, TurnTokenMetrics } from "../core/types.js";
import type { ExecutionModeTag } from "./usage-tracker.js";
import { classifyClient } from "../utils/user-agent.js";

/**
 * Metadata-only request log (in-memory ring buffer, never persisted).
 *
 * PRIVACY CONTRACT: this module must never hold prompt, system prompt, tool arguments, tool results,
 * model output, thinking text or any other conversation content. Only counts, sizes, timings,
 * identifiers and short one-way hashes are kept. `test/request-log-privacy.test.ts` enforces this.
 */

export type RequestProtocolTag =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "playground";

export interface RequestTraceSummary extends RequestTraceEffort {
  id: string;
  startedAt: string;
  status: "running" | "success" | "error";
  httpStatus: number;
  protocol: RequestProtocolTag;
  stream: boolean;
  requestedModel: string;
  clientKeyId?: string;
  clientKeyName?: string;
  clientIp?: string;
  userAgent?: string;
  client?: string;
  slotId?: string;
  accountLabel?: string;
  maskedKey?: string;
  execMode?: ExecutionModeTag;
  usedProxy?: boolean;
  ttftMs: number | null;
  durationMs: number | null;
  toolCount: number;
  emittedToolCallsCount: number;
  hasThinking: boolean;
  upstreamSentChars: number;
  transcriptTotalChars: number;
  outputChars: number;
  metrics?: TurnTokenMetrics;
}

/** Content-free record of the thinking tier that actually reached AWS Quick for this request. */
export interface RequestTraceEffort {
  agentMode?: string;
  /** Tier the client asked for (after request parsing, before per-account capability). */
  effortRequested?: string;
  /** Tier actually sent upstream; null when fast mode omits `thinking_effort`. */
  effortSent?: string | null;
  effortDowngraded?: boolean;
  /** Which client input decided the tier (`model-default`, `thinking.budget_tokens=31999`, ...). */
  effortSource?: string;
  /** Characters of real upstream reasoning deltas. */
  thinkingChars?: number;
  /** Characters of the gateway's own `[AWS Quick] mode=… effort=… routed=…` line. */
  routedHeaderChars?: number;
}

/** Content-free diagnostics: lets an operator reason about session reuse without seeing any text. */
export interface RequestTraceDetail extends RequestTraceSummary {
  messageCount: number;
  imageCount: number;
  toolNames: string[];
  stopReason?: string;
  /** Gateway/upstream error code and message (never request content). */
  errorMessage?: string;
  /** Short one-way fingerprints (8 hex chars); equal values mean "same conversation prefix". */
  fingerprint: {
    conversation?: string;
    priorPrefix?: string;
    currentPrefix?: string;
  };
}

interface MutableTraceRecord extends RequestTraceDetail {
  startedAtMs: number;
  incrementalDeltaChars: number;
  toolResumeDeltaChars: number;
}

const short = (v: string | undefined): string | undefined =>
  v ? crypto.createHash("sha256").update(v).digest("hex").slice(0, 8) : undefined;

function countMessages(rawBody: Record<string, unknown>): number {
  if (Array.isArray(rawBody.messages)) return rawBody.messages.length;
  if (Array.isArray(rawBody.input)) return rawBody.input.length;
  return typeof rawBody.input === "string" ? 1 : 0;
}

export class RequestTraceLogger {
  private readonly maxEntries: number;
  private readonly records = new Map<string, MutableTraceRecord>();

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  clear(): void {
    this.records.clear();
  }

  startTrace(
    protocol: RequestProtocolTag,
    turn: ParsedProtocolTurn,
    clientKeyMeta?: { keyId?: string; keyName?: string; clientIp?: string; userAgent?: string }
  ): string {
    while (this.records.size >= this.maxEntries) {
      const oldestId = this.records.keys().next().value;
      if (!oldestId) break;
      this.records.delete(oldestId);
    }

    const id = `req_${crypto.randomBytes(5).toString("hex")}`;
    const now = Date.now();
    const toolResumeDeltaChars = turn.trailingToolResults.reduce((acc, r) => acc + r.content.length, 0)
      + (turn.trailingUserText?.length ?? 0);
    const incrementalDeltaChars = turn.incrementalUserText?.length ?? turn.fullTranscriptText.length;
    const conversation = short(turn.conversationKey);
    const priorPrefix = short(turn.priorPrefixHash);
    const currentPrefix = short(turn.currentInputPrefixHash);

    this.records.set(id, {
      id,
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      status: "running",
      httpStatus: 200,
      protocol,
      stream: turn.stream,
      requestedModel: turn.requestedModel,
      ...(clientKeyMeta?.keyId ? { clientKeyId: clientKeyMeta.keyId } : {}),
      ...(clientKeyMeta?.keyName ? { clientKeyName: clientKeyMeta.keyName } : {}),
      ...(clientKeyMeta?.clientIp ? { clientIp: clientKeyMeta.clientIp } : {}),
      ...(clientKeyMeta?.userAgent ? { userAgent: clientKeyMeta.userAgent, client: classifyClient(clientKeyMeta.userAgent) } : {}),
      ttftMs: null,
      durationMs: null,
      toolCount: turn.tools.length,
      emittedToolCallsCount: 0,
      hasThinking: false,
      upstreamSentChars: turn.fullTranscriptText.length + (turn.systemPrompt?.length ?? 0),
      transcriptTotalChars: turn.fullTranscriptText.length,
      outputChars: 0,
      messageCount: countMessages(turn.rawBody),
      imageCount: turn.images.length,
      toolNames: turn.tools.map((t) => t.name),
      fingerprint: {
        ...(conversation ? { conversation } : {}),
        ...(priorPrefix ? { priorPrefix } : {}),
        ...(currentPrefix ? { currentPrefix } : {})
      },
      incrementalDeltaChars,
      toolResumeDeltaChars
    });
    return id;
  }

  bindExecutionMeta(
    traceId: string | null,
    meta: { slotId?: string; maskedKey: string; accountLabel?: string; execMode: ExecutionModeTag; usedProxy?: boolean }
  ): void {
    if (!traceId) return;
    const rec = this.records.get(traceId);
    if (!rec) return;
    if (meta.slotId) rec.slotId = meta.slotId;
    rec.maskedKey = meta.maskedKey;
    if (meta.accountLabel) rec.accountLabel = meta.accountLabel;
    rec.execMode = meta.execMode;
    if (meta.usedProxy) rec.usedProxy = true;
    if (meta.execMode === "parked_tool_resume") {
      rec.upstreamSentChars = Math.max(4, rec.toolResumeDeltaChars);
    } else if (meta.execMode === "warm_incremental") {
      rec.upstreamSentChars = Math.max(1, rec.incrementalDeltaChars);
    }
  }

  /** Counts only; the text itself is discarded immediately. */
  recordThinkingDelta(traceId: string | null, text: string): void {
    if (!traceId || !text) return;
    const rec = this.records.get(traceId);
    if (!rec) return;
    if (rec.ttftMs === null) rec.ttftMs = Date.now() - rec.startedAtMs;
    rec.hasThinking = true;
    rec.thinkingChars = (rec.thinkingChars ?? 0) + text.length;
  }

  /** Stores the outbound effort decision; labels and counts only, never content. */
  recordEffort(
    traceId: string | null,
    effort: {
      agentMode?: string;
      effortRequested?: string;
      effortSent?: string | null;
      downgraded?: boolean;
      effortSource?: string;
      thinkingChars?: number;
      routedHeaderChars?: number;
    },
  ): void {
    if (!traceId) return;
    const rec = this.records.get(traceId);
    if (!rec) return;
    rec.agentMode = effort.agentMode;
    rec.effortRequested = effort.effortRequested;
    rec.effortSent = effort.effortSent;
    rec.effortDowngraded = effort.downgraded;
    rec.effortSource = effort.effortSource;
    if (effort.thinkingChars !== undefined) rec.thinkingChars = effort.thinkingChars;
    if (effort.routedHeaderChars !== undefined) rec.routedHeaderChars = effort.routedHeaderChars;
  }

  recordTextDelta(traceId: string | null, text: string): void {
    if (!traceId || !text) return;
    const rec = this.records.get(traceId);
    if (!rec) return;
    if (rec.ttftMs === null) rec.ttftMs = Date.now() - rec.startedAtMs;
    rec.outputChars += text.length;
  }

  /** Keeps only the number of emitted tool calls, never their names or arguments. */
  recordToolCalls(traceId: string | null, calls: ReadonlyArray<unknown>): void {
    if (!traceId || !calls.length) return;
    const rec = this.records.get(traceId);
    if (!rec) return;
    if (rec.ttftMs === null) rec.ttftMs = Date.now() - rec.startedAtMs;
    rec.emittedToolCallsCount = calls.length;
  }

  recordUsage(traceId: string | null, metrics: TurnTokenMetrics): void {
    if (!traceId) return;
    const rec = this.records.get(traceId);
    if (!rec) return;
    rec.metrics = metrics;
  }

  finishSuccess(traceId: string | null, stopReason?: string): void {
    if (!traceId) return;
    const rec = this.records.get(traceId);
    if (!rec) return;
    rec.status = "success";
    rec.httpStatus = 200;
    rec.durationMs = Date.now() - rec.startedAtMs;
    if (rec.ttftMs === null) rec.ttftMs = rec.durationMs;
    if (stopReason) rec.stopReason = stopReason;
  }

  finishError(traceId: string | null, httpStatus: number, errorMessage: string): void {
    if (!traceId) return;
    const rec = this.records.get(traceId);
    if (!rec) return;
    rec.status = "error";
    rec.httpStatus = httpStatus;
    rec.durationMs = Date.now() - rec.startedAtMs;
    rec.errorMessage = errorMessage.slice(0, 300);
  }

  listSummaries(limit = 100): RequestTraceSummary[] {
    const now = Date.now();
    return [...this.records.values()]
      .reverse()
      .slice(0, limit)
      .map((r) => this.toPublic(r, now));
  }

  getDetail(id: string): RequestTraceDetail | null {
    const rec = this.records.get(id);
    return rec ? this.toPublic(rec, Date.now()) : null;
  }

  private toPublic(r: MutableTraceRecord, now: number): RequestTraceDetail {
    const { startedAtMs: _s, incrementalDeltaChars: _i, toolResumeDeltaChars: _t, ...rest } = r;
    return {
      ...rest,
      durationMs: r.durationMs ?? (r.status === "running" ? now - r.startedAtMs : null)
    };
  }
}
