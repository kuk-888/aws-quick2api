import crypto from "node:crypto";
import WebSocket from "ws";
import {
  ChunkedFrameAssembler,
  drainEventStream,
} from "../aws-quick/event-stream-cbor.js";
import { cacheOAuthUserIdentity } from "../aws-quick/oauth-client.js";
import {
  DESKTOP_CAPABILITIES,
  type QuickFrameDecoder,
  type QuickFrameEncoder,
} from "../aws-quick/ws-transport.js";
import type { ExecutionModeTag, UsageTracker } from "../services/usage-tracker.js";
import { extendHashWithAssistantTurn } from "../utils/hash.js";
import { appendWsRecvBuf, type QuickAttachment } from "./media-utils.js";
import type { StreamingToolCallFilter } from "./tool-bridge.js";
import { buildOutboundChatFrame, type OutboundEditBranch } from "./turn-frame-builder.js";
import type { StreamingToolCallEvent } from "./tool-bridge.js";
import { TurnProtocolTracker } from "./turn-protocol-state.js";
import {
  GatewayError,
  parseRoutedModelThinkingMode,
  type GatewayStreamEvent,
  type ParsedProtocolTurn,
  type RoutedModelThinkingMode,
} from "./types.js";
import type { StreamingUiTagSanitizer } from "./ui-tag-sanitizer.js";
import {
  isLikelySoftRefusal,
  isPseudo200UsageLimitPrefix,
  isPseudo200UsageLimitText,
  mapSdkError,
} from "./upstream-errors.js";
import type { WarmSessionPool } from "./warm-session-pool.js";

export interface ContentFilterCaptureContext {
  ws?: WebSocket;
  onIdleErr?: () => void;
  outpostId?: string;
  messageId?: string;
  threadId: string;
  rootSessionId: string;
  isWarmIncremental: boolean;
  sawRealThinking: boolean;
  hasEmittedText: boolean;
  activePromptText: string;
  preserveContextPrefix?: string;
}

export { parseRoutedModelThinkingMode, type RoutedModelThinkingMode };

export interface RunTurnStreamParams {
  ws: WebSocket;
  isReusedOpenWs: boolean;
  /** True when `ws` was adopted from the pre-warmed standby pool (enables fast 10s first-response liveness guard). */
  isStandbyWs?: boolean;
  /** True when the caller already invoked `warmPool.trackActiveWsStart(slotId)` before OOB uploads. */
  alreadyTrackedActive?: boolean;
  /** True when `session_connect` was already sent during speculative parallel dial (awaiting `session_established`). */
  preSessionConnectSent?: boolean;
  /** Any raw WS chunks received during speculative parallel dial before `runTurnStream` attached listeners. */
  preBufferedFrames?: Buffer[];
  encodeFrame: QuickFrameEncoder;
  decodeFrame: QuickFrameDecoder;
  isWeb: boolean;
  oauthClientId?: string;
  surfaceType: string;
  appVersion: string;
  surfaceName: "web" | "desktop";
  outpostId: string;
  actorArn?: string;
  turn: ParsedProtocolTurn;
  apiKey: string;
  slotId: string;
  proxyUrl?: string;
  execMode: ExecutionModeTag;
  selection: {
    model: string;
    agentMode: "smart" | "balanced" | "fast" | "advanced";
    thinkingEffort?: string;
  };
  chatAgentId?: string;
  warmGeneration?: number;
  isIncognito: boolean;
  isWarmIncremental: boolean;
  isInternalHelperCall: boolean;
  isRephraseRetry?: boolean;
  threadId: string;
  effectiveRootThreadId: string;
  chunks: string[];
  effectiveCustomPrompt: string | null;
  attachments: QuickAttachment[];
  rawPromptForRephrase: string;
  rephrasePreservePrefix?: string;
  toolFilter: StreamingToolCallFilter | null;
  uiTagSanitizer: StreamingUiTagSanitizer;
  editBranch?: OutboundEditBranch;
  onContentFilterCapture?: (ctx: ContentFilterCaptureContext) => void;
  runMaxTimeoutMs: number;
  runIdleTimeoutMs: number;
  showRoutedModelInThinking: boolean | RoutedModelThinkingMode;
  /** Most recently observed upstream resolved model for this slot/agentMode (real `turn_usage` telemetry). */
  observedModelHint?: string;
  onResolvedModel?: (modelId: string) => void;
  webSearchEnabled: boolean;
  usageTracker: UsageTracker;
  warmPool: WarmSessionPool;
}

/**
 * Runs a single upstream WebSocket turn stream from handshake / chunk dispatch
 * through protocol frame decoding, tool/UI filtering, usage aggregation,
 * abort cancellation (`stop_generation`), content-filter warm-WS handoff, and
 * warm connection parking on completion.
 */
export async function* runTurnStream(
  params: RunTurnStreamParams,
): AsyncGenerator<GatewayStreamEvent, void, unknown> {
  const {
    ws,
    isReusedOpenWs,
    isStandbyWs,
    alreadyTrackedActive,
    preSessionConnectSent,
    preBufferedFrames,
    encodeFrame,
    decodeFrame,
    isWeb,
    oauthClientId,
    surfaceType,
    appVersion,
    surfaceName,
    outpostId,
    actorArn,
    turn,
    apiKey,
    slotId,
    proxyUrl,
    execMode,
    selection,
    chatAgentId,
    warmGeneration,
    isIncognito,
    isWarmIncremental,
    isInternalHelperCall,
    isRephraseRetry,
    threadId,
    chunks,
    effectiveCustomPrompt,
    attachments,
    rawPromptForRephrase,
    rephrasePreservePrefix,
    toolFilter,
    uiTagSanitizer,
    editBranch,
    onContentFilterCapture,
    runMaxTimeoutMs,
    runIdleTimeoutMs,
    showRoutedModelInThinking,
    observedModelHint,
    onResolvedModel,
    webSearchEnabled,
    usageTracker,
    warmPool,
  } = params;

  const totalChunks = chunks.length;
  let effectiveRootThreadId = params.effectiveRootThreadId;
  let activeKernelThreadId = threadId;

  if (!alreadyTrackedActive) {
    warmPool.trackActiveWsStart(slotId);
  }

  const queue: Array<GatewayStreamEvent | { type: "__error"; error: Error }> = [];
  let qHead = 0;
  let notify: (() => void) | null = null;
  let ended = false;
  const push = (item: GatewayStreamEvent | { type: "__error"; error: Error }) => {
    queue.push(item);
    if (notify) {
      const fn = notify;
      notify = null;
      fn();
    }
  };
  const waitNext = () =>
    new Promise<void>((resolve) => {
      if (qHead < queue.length || ended) {
        resolve();
        return;
      }
      notify = resolve;
    });

  let activeChunkIndex = 0;
  let advancingChunk = false;
  let awaitingChunkAck = false;
  let initialChunkSent = false;
  const proto = new TurnProtocolTracker();
  const chunkedAssembler = new ChunkedFrameAssembler();

  const timer = setTimeout(() => {
    if (!ended) {
      clearAllStreamTimers();
      ended = true;
      push({ type: "__error", error: new GatewayError("AWS Quick stream timed out", 504, "timeout_error") });
      safeCloseWs();
    }
  }, (runMaxTimeoutMs || 120_000) + Math.max(0, totalChunks - 1) * 50_000);

  let pingTimer: NodeJS.Timeout | null = null;
  let postUsageTimer: NodeJS.Timeout | null = null;
  let handshakeTimer: NodeJS.Timeout | null = null;
  let chunkAdvanceTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let standbyLivenessTimer: NodeJS.Timeout | null = null;
  const idleTimeoutMs = runIdleTimeoutMs > 0 ? runIdleTimeoutMs : 0;

  const clearPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };
  const clearPostUsageTimer = () => {
    if (postUsageTimer) {
      clearTimeout(postUsageTimer);
      postUsageTimer = null;
    }
  };
  const clearAuxTimers = () => {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    if (chunkAdvanceTimer) {
      clearTimeout(chunkAdvanceTimer);
      chunkAdvanceTimer = null;
    }
  };
  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const clearStandbyLivenessTimer = () => {
    if (standbyLivenessTimer) {
      clearTimeout(standbyLivenessTimer);
      standbyLivenessTimer = null;
    }
  };
  const clearAllStreamTimers = () => {
    clearPing();
    clearPostUsageTimer();
    clearAuxTimers();
    clearIdleTimer();
    clearStandbyLivenessTimer();
  };
  const touchIdleTimer = () => {
    if (!idleTimeoutMs || ended) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      if (!ended) {
        ended = true;
        clearAllStreamTimers();
        push({ type: "__error", error: new GatewayError("AWS Quick stream idle timed out", 504, "timeout_error") });
        try {
          ws.close();
        } catch { }
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  let deferredGraceClose = false;
  const safeCloseWs = () => {
    ws.on("error", () => { });
    try {
      ws.close();
    } catch { }
  };

  const onAbort = () => {
    if (!ended) {
      ended = true;
      clearAllStreamTimers();
      const isPrimaryShared = warmPool.isPrimarySharedWs(slotId, ws);
      const assistantMsgId = proto.getAssistantMessageId();
      if (ws.readyState === WebSocket.OPEN && !initialChunkSent && isPrimaryShared) {
        // Request aborted before any chat frame was dispatched on the Primary Shared WS:
        // reclaim it immediately without closing so sibling warm sessions stay alive.
        ws.off("message", onWsMessage);
        ws.off("error", onWsError);
        ws.off("close", onWsClose);
        if (warmPool.releaseUntouchedWs(slotId, ws)) {
          wsParked = true;
        } else {
          safeCloseWs();
        }
      } else if (ws.readyState === WebSocket.OPEN && (assistantMsgId || (initialChunkSent && isPrimaryShared))) {
        try {
          ws.send(
            encodeFrame({
              type: "stop_generation",
              payload: {
                ...(assistantMsgId ? { message_id: assistantMsgId } : {}),
                thread_id: activeKernelThreadId || threadId,
              },
            }),
          );
        } catch { }
        deferredGraceClose = true;
        ws.off("message", onWsMessage);
        ws.off("error", onWsError);
        ws.off("close", onWsClose);
        if (isPrimaryShared) {
          // Graceful abort drain for Primary Shared WS: wait up to 2.5s for upstream to confirm
          // `turn_aborted` / `message_complete` / `stream_ended` so we can return the shared WS
          // to idle instead of closing it and wiping up to 15 unrelated warm sessions on this slot.
          let drainSettled = false;
          let drainBuf = Buffer.alloc(0);
          const drainAssembler = new ChunkedFrameAssembler();
          const finishDrain = (reclaim: boolean) => {
            if (drainSettled) return;
            drainSettled = true;
            clearTimeout(drainTimer);
            ws.off("message", onDrainMsg);
            ws.off("error", onDrainDead);
            ws.off("close", onDrainDead);
            drainAssembler.clear();
            if (reclaim && ws.readyState === WebSocket.OPEN && warmPool.releaseUntouchedWs(slotId, ws)) {
              return;
            }
            safeCloseWs();
          };
          const onDrainDead = () => finishDrain(false);
          const onDrainMsg = (data: Buffer) => {
            if (drainSettled) return;
            try {
              drainBuf = appendWsRecvBuf(drainBuf, data);
              const { messages, consumed } = drainEventStream(drainBuf, 0);
              if (consumed > 0) drainBuf = consumed >= drainBuf.length ? EMPTY_RECV_BUF : drainBuf.subarray(consumed);
              for (const esMsg of messages) {
                const decoded = decodeFrame(esMsg);
                if (!decoded || decoded.type === "error") continue;
                const ev = drainAssembler.push(decoded.data);
                if (!ev) continue;
                const et = String(ev.type || "");
                const evTid = typeof ev.thread_id === "string" ? ev.thread_id.trim() : "";
                if (
                  evTid &&
                  evTid !== threadId &&
                  evTid !== activeKernelThreadId &&
                  evTid !== effectiveRootThreadId
                ) {
                  continue;
                }
                if (et === "turn_aborted" || et === "message_complete" || et === "stream_ended") {
                  finishDrain(true);
                  return;
                }
              }
            } catch {
              finishDrain(false);
            }
          };
          ws.on("message", onDrainMsg);
          ws.once("error", onDrainDead);
          ws.once("close", onDrainDead);
          const drainTimer = setTimeout(() => finishDrain(false), 2_500);
          drainTimer.unref?.();
        } else {
          ws.on("error", () => { });
          const graceClose = setTimeout(() => {
            try {
              ws.close();
            } catch { }
          }, 350);
          graceClose.unref?.();
        }
      } else {
        safeCloseWs();
      }
      push({
        type: "__error",
        error: new GatewayError("Request aborted by client.", 499, "client_aborted"),
      });
    }
  };
  turn.signal?.addEventListener("abort", onAbort, { once: true });
  if (turn.signal?.aborted) onAbort();

  let recvBuf = Buffer.alloc(0);
  let emittedRoutedModel = false;
  let emittedRoutedThinkingToClient = false;
  let emittedRoutedModelName: string | undefined;
  let emittedRoutedExact = false;
  let hasEmittedText = false;
  let assistantOutputText = "";
  let usageLimitPrefixBuf = "";
  let usageLimitChecked = false;
  let resolvedModelId: string | undefined;
  let wsParked = false;
  let wsHandedOff = false;
  let lastSentMessageId: string | undefined;
  let pendingRoutedThinking: string | null = null;
  let pendingLateRoutingCorrection: string | null = null;
  let sawRealThinking = false;
  let usageRecordedForTurn = false;
  const routedThinkingMode: RoutedModelThinkingMode = parseRoutedModelThinkingMode(showRoutedModelInThinking);

  const abortPseudo200QuotaLimit = () => {
    clearAllStreamTimers();
    ended = true;
    push({
      type: "__error",
      error: new GatewayError("AWS Quick account reached its usage limit (quota_exhausted).", 402, "quota_exhausted"),
    });
    try {
      ws.close();
    } catch { }
  };

  const flushPendingRoutedThinking = () => {
    if (pendingRoutedThinking) {
      const text = pendingRoutedThinking;
      pendingRoutedThinking = null;
      emittedRoutedThinkingToClient = true;
      push({ type: "thinking", text });
    }
  };

  const flushAggregatedTurnUsage = () => {
    if (usageRecordedForTurn) return;
    const metrics = proto.buildFinalMetrics();
    if (!metrics) return;
    usageRecordedForTurn = true;
    usageTracker.recordTurn({
      apiKey,
      modelId: metrics.resolvedModel ? `${selection.model} (${metrics.resolvedModel})` : selection.model,
      mode: execMode,
      metrics: {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        cacheWriteTokens: metrics.cacheWriteTokens,
        ...(metrics.totalTokens !== undefined ? { totalTokens: metrics.totalTokens } : {}),
        ...(metrics.contextWindow !== undefined ? { contextWindow: metrics.contextWindow } : {}),
        ...(metrics.contextPercent !== undefined ? { contextPercent: metrics.contextPercent } : {}),
      },
    });
    push({ type: "usage", metrics });
  };

  const emitGuardedText = (chunk: string): void => {
    if (!chunk) return;
    if (!usageLimitChecked) {
      usageLimitPrefixBuf += chunk;
      const mightBePseudoLimit =
        usageLimitPrefixBuf.length <= 160 &&
        (isPseudo200UsageLimitPrefix(usageLimitPrefixBuf) || isPseudo200UsageLimitText(usageLimitPrefixBuf));
      if (mightBePseudoLimit) return;
      usageLimitChecked = true;
      flushPendingRoutedThinking();
      const flushed = usageLimitPrefixBuf;
      usageLimitPrefixBuf = "";
      hasEmittedText = true;
      assistantOutputText += flushed;
      push({ type: "text", text: flushed });
      return;
    }
    flushPendingRoutedThinking();
    hasEmittedText = true;
    assistantOutputText += chunk;
    push({ type: "text", text: chunk });
  };

  const rawToolChoiceObjForStream =
    turn.rawBody?.tool_choice && typeof turn.rawBody.tool_choice === "object"
      ? (turn.rawBody.tool_choice as { disable_parallel_tool_use?: unknown })
      : undefined;
  const singleToolOnly =
    turn.rawBody?.parallel_tool_calls === false ||
    rawToolChoiceObjForStream?.disable_parallel_tool_use === true;
  const allowedStreamToolIndices = new Set<number>();
  const completedStreamToolCalls: import("./types.js").NormalizedToolCall[] = [];
  let trimmedParallelToolCalls = false;
  let hasEmittedToolCall = false;

  const flushBufferedTextBeforeToolCall = () => {
    if (usageLimitPrefixBuf) {
      usageLimitChecked = true;
      flushPendingRoutedThinking();
      const flushed = usageLimitPrefixBuf;
      usageLimitPrefixBuf = "";
      if (flushed) {
        hasEmittedText = true;
        assistantOutputText += flushed;
        push({ type: "text", text: flushed });
      }
    } else {
      usageLimitChecked = true;
      flushPendingRoutedThinking();
    }
    const pendingUi = uiTagSanitizer.flush();
    if (pendingUi) {
      hasEmittedText = true;
      assistantOutputText += pendingUi;
      push({ type: "text", text: pendingUi });
    }
  };

  const emitStreamingToolEvents = (
    toolEvents: readonly StreamingToolCallEvent[],
    onBeforeToolStart?: () => void,
  ) => {
    for (const te of toolEvents) {
      if (te.kind === "tool_call_start") {
        if (singleToolOnly && allowedStreamToolIndices.size >= 1) {
          trimmedParallelToolCalls = true;
          continue;
        }
        allowedStreamToolIndices.add(te.index);
        onBeforeToolStart?.();
        flushBufferedTextBeforeToolCall();
        hasEmittedToolCall = true;
        push({ type: "tool_call_start", index: te.index, id: te.id, name: te.name });
      } else if (te.kind === "tool_call_delta") {
        if (!allowedStreamToolIndices.has(te.index)) continue;
        push({ type: "tool_call_delta", index: te.index, id: te.id, argumentsDelta: te.argumentsDelta });
      } else if (te.kind === "tool_call_end") {
        if (!allowedStreamToolIndices.has(te.index)) continue;
        completedStreamToolCalls.push(te.call);
        push({ type: "tool_call_end", index: te.index, call: te.call });
      }
    }
  };

  const finalizeTurn = (realThreadId: string, allowParkWs = true) => {
    if (ended) return;
    clearAllStreamTimers();
    if (usageLimitPrefixBuf) {
      if (!sawRealThinking && !hasEmittedToolCall && isPseudo200UsageLimitText(usageLimitPrefixBuf)) {
        usageLimitPrefixBuf = "";
        pendingRoutedThinking = null;
        abortPseudo200QuotaLimit();
        return;
      }
      usageLimitChecked = true;
      flushPendingRoutedThinking();
      const flushed = usageLimitPrefixBuf;
      usageLimitPrefixBuf = "";
      hasEmittedText = true;
      assistantOutputText += flushed;
      push({ type: "text", text: flushed });
    } else {
      usageLimitChecked = true;
      flushPendingRoutedThinking();
    }
    let stopReason: "stop" | "tool_calls" = "stop";
    let emittedToolCalls: Array<{ id: string; name: string }> = [];
    if (toolFilter) {
      const { remainingText, events: finalToolEvents } = toolFilter.flushIncremental();
      const cleanRem = remainingText ? uiTagSanitizer.feed(remainingText) : remainingText;
      if (cleanRem) {
        hasEmittedText = true;
        assistantOutputText += cleanRem;
        push({ type: "text", text: cleanRem });
      }
      if (finalToolEvents.length > 0) {
        emitStreamingToolEvents(finalToolEvents);
      }
    }
    const tailText = uiTagSanitizer.flush();
    if (tailText) {
      hasEmittedText = true;
      assistantOutputText += tailText;
      push({ type: "text", text: tailText });
    }
    if (pendingLateRoutingCorrection) {
      const corrected = pendingLateRoutingCorrection;
      pendingLateRoutingCorrection = null;
      push({
        type: "thinking",
        text: `\n[AWS Quick] actual_routed=${corrected}\n`,
        lateRoutingCorrection: true,
        actualRoutedModel: corrected,
      });
    }
    if (completedStreamToolCalls.length > 0) {
      emittedToolCalls = completedStreamToolCalls.map((tc) => {
        const matchedTool = turn.tools.find((t) => t.name === tc.name || t.wireName === tc.name);
        return { id: tc.id, name: matchedTool?.name || tc.name };
      });
      stopReason = "tool_calls";
    }
    flushAggregatedTurnUsage();
    let parkedForReuse = false;
    const effectiveFinishThreadId = activeKernelThreadId || realThreadId;
    const effectiveContextWindow = proto.getMaxContextWindow() > 0 ? proto.getMaxContextWindow() : 1_000_000;
    const nearUpstreamContextLimit =
      proto.getMaxContextPercent() >= 80 ||
      proto.getMaxTotalTokens() >= Math.floor(effectiveContextWindow * 0.8);
    // When `parallel_tool_calls: false` / `disable_parallel_tool_use: true` trimmed extra tool calls,
    // skip parking this thread so Turn 2 replays the exact single-tool history instead of diverging
    // from the upstream thread (which still remembers attempting the dropped parallel tool call).
    if (
      turn.currentInputPrefixHash &&
      !trimmedParallelToolCalls &&
      !isLikelySoftRefusal(assistantOutputText) &&
      !nearUpstreamContextLimit
    ) {
      const nextHashes: string[] = [];
      if (stopReason === "stop" && assistantOutputText.trim().length > 0) {
        nextHashes.push(extendHashWithAssistantTurn(turn.currentInputPrefixHash, assistantOutputText));
      } else if (stopReason === "tool_calls" && emittedToolCalls.length > 0) {
        nextHashes.push(
          extendHashWithAssistantTurn(turn.currentInputPrefixHash, assistantOutputText, emittedToolCalls),
        );
        if (assistantOutputText.trim().length > 0) {
          nextHashes.push(extendHashWithAssistantTurn(turn.currentInputPrefixHash, "", emittedToolCalls));
        }
      }
      if (nextHashes.length > 0) {
        ws.off("message", onWsMessage);
        ws.off("error", onWsError);
        ws.off("close", onWsClose);
        // Guard `editKey` registration against theoretical shared-API-key Turn-1 collisions:
        // only enable native `edit_message` Retry/Edit when the caller supplies an explicit session
        // identifier (`hdr_`/`pck_`/`meta_`/`usr_`, i.e. not implicit first-message `anc_`) OR the
        // conversation already spans >= 2 completed prior assistant turns.
        const hasExplicitSessionKey = Boolean(turn.conversationKey) && !/(?:^|:)anc_/.test(turn.conversationKey!);
        const allowEditKey = hasExplicitSessionKey || (turn.priorAssistantTurns ?? 0) >= 2;
        parkedForReuse = warmPool.park({
          scope: turn.scope,
          conversationKey: turn.conversationKey,
          slotId,
          isIncognito,
          ...(chatAgentId ? { chatAgentId } : {}),
          ...(warmGeneration !== undefined ? { expectedGeneration: warmGeneration } : {}),
          prefixHashes: nextHashes,
          ...(totalChunks === 1 && lastSentMessageId && turn.priorPrefixHash && !isInternalHelperCall && allowEditKey
            ? { editPrefixHash: turn.priorPrefixHash, lastUserMessageId: lastSentMessageId }
            : {}),
          threadId: effectiveFinishThreadId,
          rootThreadId: effectiveRootThreadId,
          priority: isWarmIncremental || turn.estimatedInputTokens >= 1_500 ? 2 : 1,
          ...(allowParkWs
            ? {
              ws,
              outpostId,
              encodeFrame,
              sharedHandleMeta: {
                decodeFrame,
                surfaceType,
                appVersion,
                surfaceName,
                ...(actorArn ? { actorArn } : {}),
              },
              apiKey,
              proxyUrl,
              lastAckSeq: proto.getLastAckSequence(),
            }
            : {}),
        });
      }
    }
    wsParked = parkedForReuse;
    ended = true;
    push({ type: "done", stopReason });
    if (!parkedForReuse) {
      safeCloseWs();
    }
  };

  const sendChunkMessage = (idx: number) => {
    if (ws.readyState !== WebSocket.OPEN || ended) return;
    const isFinal = idx >= totalChunks - 1;
    awaitingChunkAck = !isFinal;
    const chunkText =
      totalChunks === 1
        ? chunks[idx]!
        : isFinal
          ? `[Context segment ${idx + 1}/${totalChunks} — final segment. All context segments are now complete; please answer the request above.]\n\n${chunks[idx]!}`
          : `[Context segment ${idx + 1}/${totalChunks} uploaded; awaiting remaining segments.]\n\n${chunks[idx]!}`;
    const msgId = `msg-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    if (isFinal) lastSentMessageId = msgId;
    touchIdleTimer();
    const frame = buildOutboundChatFrame({
      chunkText,
      msgId,
      isFinal,
      isInternalRephraseCall: isInternalHelperCall,
      webSearchEnabled,
      turn,
      agentMode: selection.agentMode,
      thinkingEffort: selection.thinkingEffort,
      chatAgentId,
      effectiveCustomPrompt,
      attachments,
      surfaceType,
      outpostId,
      appVersion,
      surfaceName,
      threadId,
      isIncognito,
      ...(editBranch && totalChunks === 1 && isFinal ? { editBranch } : {}),
    });
    try {
      ws.send(encodeFrame(frame));
    } catch (sendErr) {
      onWsError(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
    }
  };

  const triggerInitialSend = () => {
    if (initialChunkSent || ended) return;
    initialChunkSent = true;
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    sendChunkMessage(0);
  };

  let missedPongs = 0;
  let thinkingOnlyStartedAt = 0;
  // Cap single-segment continuous thinking-only loops at `runIdleTimeoutMs` (default 10 min;
  // reset on every thinking_complete / tool_progress / tool_arguments / tool_result / text_delta),
  // giving `effort=max` deep reasoning full headroom while still bounding infinite thinking loops.
  const maxThinkingOnlyMs = runIdleTimeoutMs > 0 ? runIdleTimeoutMs : 600_000;
  const onWsPong = () => {
    missedPongs = 0;
    clearStandbyLivenessTimer();
  };
  ws.on("pong", onWsPong);

  const startTurnPing = () => {
    clearPing();
    missedPongs = 0;
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && !ended) {
        if (missedPongs >= 2) {
          clearAllStreamTimers();
          ended = true;
          push({ type: "__error", error: new GatewayError("AWS Quick WebSocket heartbeat timed out (no pong).", 504, "timeout_error") });
          try {
            ws.terminate();
          } catch { }
          return;
        }
        missedPongs += 1;
        try {
          ws.ping();
          const ack = proto.getLastAckSequence();
          ws.send(encodeFrame({ type: "ping", payload: { timestamp: Date.now(), ...(ack ? { ack } : {}) } }));
        } catch (pingErr) {
          clearAllStreamTimers();
          ended = true;
          push({
            type: "__error",
            error: new GatewayError(
              `AWS Quick WebSocket ping failed: ${pingErr instanceof Error ? pingErr.message : String(pingErr)}`,
              502,
              "upstream_error",
            ),
          });
          try {
            ws.terminate();
          } catch { }
        }
      }
    }, 25_000);
    pingTimer.unref?.();
  };

  const EMPTY_RECV_BUF = Buffer.alloc(0);
  const rawThinkingObj =
    turn.rawBody?.thinking && typeof turn.rawBody.thinking === "object"
      ? (turn.rawBody.thinking as { type?: unknown })
      : undefined;
  const rawReasoningObj =
    turn.rawBody?.reasoning && typeof turn.rawBody.reasoning === "object"
      ? (turn.rawBody.reasoning as { effort?: unknown })
      : undefined;
  const rawOutputCfgObj =
    turn.rawBody?.output_config && typeof turn.rawBody.output_config === "object"
      ? (turn.rawBody.output_config as { effort?: unknown })
      : undefined;
  const isOffToken = (v: unknown): boolean => {
    if (typeof v !== "string") return false;
    const k = v.trim().toLowerCase();
    return k === "none" || k === "off" || k === "disabled" || k === "false";
  };
  const explicitThinkingDisabled =
    isOffToken(rawThinkingObj?.type) ||
    turn.rawBody?.enable_thinking === false ||
    isOffToken(turn.rawBody?.reasoning_effort) ||
    isOffToken(turn.rawBody?.effort) ||
    isOffToken(rawReasoningObj?.effort) ||
    isOffToken(rawOutputCfgObj?.effort);
  const canEmitRoutedThinking = (hasRealThinkingDelta = false) =>
    !isInternalHelperCall &&
    routedThinkingMode !== "false" &&
    (routedThinkingMode === "always" ||
      (!explicitThinkingDisabled &&
        (selection.thinkingEffort !== "off" || hasRealThinkingDelta || isRephraseRetry))) &&
    !emittedRoutedModel &&
    !hasEmittedText;
  const formatRoutedHeaderLine = (modelName?: string, isExact = true) => {
    const rephraseTag = isRephraseRetry ? " · rephrased" : "";
    const routedPart = modelName
      ? (isExact ? ` · routed=${modelName}` : ` · routed≈${modelName}`)
      : "";
    return `[AWS Quick] mode=${selection.agentMode} · effort=${selection.thinkingEffort}${routedPart}${rephraseTag}\n`;
  };
  const emitOrDeferRoutedThinking = (modelName?: string, isExact = true) => {
    emittedRoutedModel = true;
    emittedRoutedModelName = modelName || undefined;
    emittedRoutedExact = Boolean(modelName && isExact);
    const line = formatRoutedHeaderLine(modelName, isExact);
    if (!usageLimitChecked) pendingRoutedThinking = line;
    else {
      emittedRoutedThinkingToClient = true;
      push({ type: "thinking", text: line });
    }
  };
  const advanceIntermediateChunk = (forChunkIdx: number) => {
    if (!awaitingChunkAck || advancingChunk || ended || activeChunkIndex !== forChunkIdx || activeChunkIndex >= totalChunks - 1) return;
    awaitingChunkAck = false;
    clearPostUsageTimer();
    advancingChunk = true;
    chunkAdvanceTimer = setTimeout(() => {
      chunkAdvanceTimer = null;
      if (ended || activeChunkIndex !== forChunkIdx) {
        advancingChunk = false;
        return;
      }
      activeChunkIndex += 1;
      advancingChunk = false;
      sendChunkMessage(activeChunkIndex);
    }, 50);
  };

  const onWsMessage = (data: Buffer) => {
    if (ended) return;
    missedPongs = 0;
    clearStandbyLivenessTimer();
    let drainedMessages;
    try {
      recvBuf = appendWsRecvBuf(recvBuf, data);
      const { messages, consumed } = drainEventStream(recvBuf, 0);
      if (consumed > 0) {
        recvBuf = consumed >= recvBuf.length ? EMPTY_RECV_BUF : recvBuf.subarray(consumed);
      }
      drainedMessages = messages;
    } catch (err) {
      clearAllStreamTimers();
      ended = true;
      push({ type: "__error", error: err instanceof Error ? err : new Error(String(err)) });
      try {
        ws.close();
      } catch { }
      return;
    }

    for (const esMsg of drainedMessages) {
      if (ended) break;
      let decoded;
      try {
        decoded = decodeFrame(esMsg);
      } catch {
        continue;
      }
      if (!decoded) continue;
      if (decoded.type === "error") {
        clearAllStreamTimers();
        ended = true;
        push({ type: "__error", error: new GatewayError(`[${decoded.code}] ${decoded.message}`, 502, "upstream_error") });
        try {
          ws.close();
        } catch { }
        return;
      }

      const ev = chunkedAssembler.push(decoded.data);
      if (!ev) continue;

      proto.observeTransport(ev);
      const evType = String(ev.type || "");
      const payload = (ev.payload && typeof ev.payload === "object" ? ev.payload : {}) as Record<string, unknown>;
      const evScope = typeof ev.scope === "string" ? ev.scope.trim() : "";
      if (evScope === "task_stream") {
        continue;
      }
      const evThreadId = typeof ev.thread_id === "string" ? ev.thread_id.trim() : "";
      const payloadRootId =
        typeof payload.root_session_id === "string" ? payload.root_session_id.trim() : "";

      if (evType === "session_established" || evType === "connected") {
        if (evType === "connected" && oauthClientId) {
          const u = payload.user as Record<string, unknown> | undefined;
          if (u && typeof u === "object") {
            cacheOAuthUserIdentity(oauthClientId, {
              ...(typeof u.email === "string" ? { email: u.email } : {}),
              ...(typeof u.name === "string" ? { name: u.name } : {}),
              ...(typeof u.aws_account_id === "string" ? { accountId: u.aws_account_id } : {}),
            });
          }
        }
        if (!initialChunkSent) triggerInitialSend();
        continue;
      }

      // Adopt new branch IDs emitted during `edit_message` branching (`tree_sync` / `tree_delta` / `runs_updated`).
      if (
        editBranch &&
        evThreadId &&
        evThreadId.startsWith("branch-") &&
        (evType === "runs_updated" || evType === "tree_delta" || evType === "tree_sync" || evType === "message_start")
      ) {
        activeKernelThreadId = evThreadId;
      }

      // Strict per-thread S2C isolation: ignore any stale/late frames from another thread_id
      // so multiplexed/background sessions can never bleed into or terminate the active turn.
      if (
        evThreadId &&
        evThreadId !== threadId &&
        evThreadId !== activeKernelThreadId &&
        evThreadId !== effectiveRootThreadId &&
        evThreadId !== editBranch?.threadId &&
        !(payloadRootId && payloadRootId === effectiveRootThreadId) &&
        !(editBranch && evThreadId.startsWith("branch-"))
      ) {
        continue;
      }

      if (evType === "tree_sync" || evType === "tree_delta") {
        const syncInfo = TurnProtocolTracker.parseTreeSync(payload);
        if (syncInfo.activeBranchId) activeKernelThreadId = syncInfo.activeBranchId;
        if (syncInfo.rootSessionId) effectiveRootThreadId = syncInfo.rootSessionId;
        touchIdleTimer();
        continue;
      }

      if (evType === "keepalive" || evType === "status" || evType === "_transport_setup_ok") {
        // Transport-level heartbeats confirm socket liveness (missedPongs already reset),
        // but must NOT reset the content-progress idleTimer so silent upstream loops still time out.
        continue;
      }

      if (advancingChunk && evType !== "error" && evType !== "guardrail_blocked") continue;
      if (activeChunkIndex < totalChunks - 1) {
        const curIdx = activeChunkIndex;
        if (evType === "message_complete") {
          advanceIntermediateChunk(curIdx);
          continue;
        } else if (evType === "stream_ended" || evType === "turn_aborted" || evType === "session_end") {
          clearAllStreamTimers();
          ended = true;
          push({ type: "__error", error: new GatewayError(`AWS Quick terminated mid-chunk upload (${evType})`, 502, "upstream_error") });
          try {
            ws.close();
          } catch { }
          return;
        } else if (evType === "text_delta" || evType === "thinking_delta" || evType === "tool_start" || evType === "tool_progress" || evType === "tool_result") {
          touchIdleTimer();
          if (postUsageTimer) {
            clearPostUsageTimer();
            postUsageTimer = setTimeout(() => advanceIntermediateChunk(curIdx), 45_000);
          }
          continue;
        } else if (evType === "turn_usage") {
          touchIdleTimer();
          clearPostUsageTimer();
          postUsageTimer = setTimeout(() => advanceIntermediateChunk(curIdx), 45_000);
          continue;
        } else if (evType !== "error" && evType !== "guardrail_blocked") {
          continue;
        }
      }

      const rearmPostUsageIfNeeded = () => {
        if (proto.hasUsage() && !proto.hasActiveCloudTools()) {
          clearPostUsageTimer();
          const usageThreadId = String(ev.thread_id || threadId);
          postUsageTimer = setTimeout(() => finalizeTurn(usageThreadId, false), 20_000);
          postUsageTimer.unref?.();
        }
      };

      if (typeof payload.kernel_thread_id === "string" && payload.kernel_thread_id.trim()) {
        activeKernelThreadId = payload.kernel_thread_id.trim();
      }

      if (evType === "message_start" || evType === "text_complete") {
        touchIdleTimer();
        continue;
      }
      if (evType === "thinking_start") {
        clearPostUsageTimer();
        touchIdleTimer();
        proto.onThinkingStart();
        rearmPostUsageIfNeeded();
        continue;
      }
      if (evType === "thinking_complete") {
        clearPostUsageTimer();
        thinkingOnlyStartedAt = 0;
        touchIdleTimer();
        proto.onThinkingComplete();
        rearmPostUsageIfNeeded();
        continue;
      }
      if (evType === "tool_start") {
        clearPostUsageTimer();
        thinkingOnlyStartedAt = 0;
        touchIdleTimer();
        proto.onCloudToolStart(
          typeof payload.tool_id === "string" ? payload.tool_id : undefined,
          typeof payload.tool_name === "string" ? payload.tool_name : undefined,
        );
        continue;
      }
      if (evType === "tool_progress" || evType === "tool_arguments") {
        clearPostUsageTimer();
        thinkingOnlyStartedAt = 0;
        touchIdleTimer();
        continue;
      }
      if (evType === "tool_result" || evType === "tool_error") {
        clearPostUsageTimer();
        thinkingOnlyStartedAt = 0;
        touchIdleTimer();
        proto.onCloudToolResult(
          typeof payload.tool_id === "string" ? payload.tool_id : undefined,
          typeof payload.tool_name === "string" ? payload.tool_name : undefined,
        );
        rearmPostUsageIfNeeded();
        continue;
      }

      if (evType === "routing_decision") {
        touchIdleTimer();
        const routed = String(payload.resolved_model_id || payload.model_id || payload.model || "");
        if (routed) {
          resolvedModelId = routed;
          proto.setResolvedModel(routed);
          onResolvedModel?.(routed);
          if (canEmitRoutedThinking()) emitOrDeferRoutedThinking(routed, true);
        }
      } else if (evType === "text_delta") {
        clearPostUsageTimer();
        thinkingOnlyStartedAt = 0;
        const delta = String(payload.delta || "");
        if (delta) {
          touchIdleTimer();
          let afterTools = delta;
          let toolEvents: StreamingToolCallEvent[] = [];
          if (toolFilter) {
            const inc = toolFilter.feedIncremental(delta);
            afterTools = inc.text;
            toolEvents = inc.events;
          }
          const emitText = afterTools ? uiTagSanitizer.feed(afterTools) : afterTools;
          if (emitText) {
            if (canEmitRoutedThinking()) {
              if (resolvedModelId) emitOrDeferRoutedThinking(resolvedModelId, true);
              else if (observedModelHint) emitOrDeferRoutedThinking(observedModelHint, false);
              else emitOrDeferRoutedThinking(undefined, false);
            }
            emitGuardedText(emitText);
          }
          if (toolEvents.length > 0) {
            emitStreamingToolEvents(toolEvents, () => {
              if (canEmitRoutedThinking()) {
                if (resolvedModelId) emitOrDeferRoutedThinking(resolvedModelId, true);
                else if (observedModelHint) emitOrDeferRoutedThinking(observedModelHint, false);
                else emitOrDeferRoutedThinking(undefined, false);
              }
            });
          }
        }
        rearmPostUsageIfNeeded();
      } else if (evType === "thinking_delta") {
        clearPostUsageTimer();
        const delta = String(payload.delta || "");
        if (delta) {
          touchIdleTimer();
          if (!thinkingOnlyStartedAt) thinkingOnlyStartedAt = Date.now();
          if (Date.now() - thinkingOnlyStartedAt > maxThinkingOnlyMs) {
            clearAllStreamTimers();
            ended = true;
            push({ type: "__error", error: new GatewayError("AWS Quick thinking stream stalled without producing output.", 504, "timeout_error") });
            try {
              ws.terminate();
            } catch { }
            return;
          }
          usageLimitChecked = true;
          if (canEmitRoutedThinking(true)) {
            if (resolvedModelId) emitOrDeferRoutedThinking(resolvedModelId, true);
            else if (observedModelHint) emitOrDeferRoutedThinking(observedModelHint, false);
            else emitOrDeferRoutedThinking(undefined, false);
          }
          const isFirstRealThinking = !sawRealThinking;
          sawRealThinking = true;
          flushPendingRoutedThinking();
          if (usageLimitPrefixBuf) {
            const flushed = usageLimitPrefixBuf;
            usageLimitPrefixBuf = "";
            if (flushed.trim()) {
              hasEmittedText = true;
              assistantOutputText += flushed;
              push({ type: "text", text: flushed });
            }
          }
          const prefixedDelta =
            isFirstRealThinking && emittedRoutedThinkingToClient && !delta.startsWith("\n")
              ? `\n${delta}`
              : delta;
          push({ type: "thinking", text: prefixedDelta });
        }
        rearmPostUsageIfNeeded();
      } else if (evType === "turn_usage") {
        touchIdleTimer();
        const inputTokens = Number(payload.input_tokens || 0);
        const outputTokens = Number(payload.output_tokens || 0);
        const cacheReadTokens = Number(payload.cache_read_tokens || 0);
        const cacheWriteTokens = Number(payload.cache_write_tokens || 0);
        const rawTotalTokens = Number(payload.total_tokens || 0);
        const contextWindow = Number(payload.context_window || 0);
        const rawContextPercent = Number(payload.context_percent || 0);
        const served = String(payload.resolved_model_id || payload.served_model_id || "");
        if (served) {
          resolvedModelId = served;
          onResolvedModel?.(served);
          if (canEmitRoutedThinking()) {
            emitOrDeferRoutedThinking(served, true);
          } else if (pendingRoutedThinking && !emittedRoutedThinkingToClient && !emittedRoutedExact) {
            pendingRoutedThinking = formatRoutedHeaderLine(served, true);
            emittedRoutedModelName = served;
            emittedRoutedExact = true;
          } else if (emittedRoutedThinkingToClient && !emittedRoutedExact && emittedRoutedModelName !== served) {
            emittedRoutedModelName = served;
            emittedRoutedExact = true;
            // Defer trailing correction until finalizeTurn() after toolFilter/uiTagSanitizer flush
            // so buffered tail text (e.g. closing ``` fence) or multi-step cloud tool text is never split.
            pendingLateRoutingCorrection = served;
          }
        }
        proto.recordTurnUsage({
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: rawTotalTokens,
          contextWindow,
          contextPercent: rawContextPercent,
          ...(resolvedModelId ? { resolvedModel: resolvedModelId } : {}),
        });
        if (!proto.hasActiveCloudTools() && (hasEmittedText || usageLimitPrefixBuf.length > 0 || outputTokens > 0)) {
          clearPostUsageTimer();
          const usageThreadId = String(ev.thread_id || threadId);
          postUsageTimer = setTimeout(() => finalizeTurn(usageThreadId, false), 20_000);
        }
      } else if (evType === "message_complete" || evType === "stream_ended") {
        finalizeTurn(String(ev.thread_id || threadId), evType === "message_complete");
        return;
      } else if (evType === "turn_aborted" || evType === "session_end") {
        if (hasEmittedText || sawRealThinking || usageLimitPrefixBuf.length > 0) {
          finalizeTurn(String(ev.thread_id || threadId), false);
        } else {
          clearAllStreamTimers();
          ended = true;
          push({ type: "__error", error: new GatewayError(`AWS Quick ended turn unexpectedly (${evType})`, 502, "upstream_error") });
          try {
            ws.close();
          } catch { }
        }
        return;
      } else if (evType === "error" || evType === "guardrail_blocked") {
        clearAllStreamTimers();
        ended = true;
        const errCode = String(payload.error_code || "");
        const errText =
          typeof payload.error === "string" && payload.error.trim()
            ? payload.error
            : typeof payload.message === "string"
              ? payload.message
              : "";
        let gatewayErr: GatewayError;
        if (evType === "guardrail_blocked" || errCode === "content_filtered") {
          const rawDetail = [
            errCode && errCode !== "content_filtered" ? errCode : "",
            typeof payload.reason === "string" ? payload.reason.trim() : "",
            errText.trim(),
          ]
            .filter(Boolean)
            .join(" | ")
            .slice(0, 180);
          const detailSuffix = rawDetail ? ` [upstream: ${rawDetail}]` : "";
          gatewayErr = new GatewayError(
            `AWS Quick upstream content filter blocked this reply (content_filtered${detailSuffix}). Rephrase or start a new chat. / 上游 AWS Quick 内容安全审核拦截了本次回复${detailSuffix}，请调整措辞或新开会话。`,
            400,
            "content_filter",
          );
          if (onContentFilterCapture && (!hasEmittedText || !turn.stream)) {
            const canHandOffWarmWs =
              isWarmIncremental &&
              ws.readyState === WebSocket.OPEN &&
              Boolean(lastSentMessageId) &&
              !editBranch &&
              totalChunks === 1;
            let onIdleErr: (() => void) | undefined;
            if (canHandOffWarmWs) {
              wsHandedOff = true;
              ws.off("message", onWsMessage);
              ws.off("error", onWsError);
              ws.off("close", onWsClose);
              onIdleErr = () => { };
              ws.on("error", onIdleErr);
            }
            onContentFilterCapture({
              ...(canHandOffWarmWs ? { ws, onIdleErr, outpostId, messageId: lastSentMessageId } : {}),
              threadId: activeKernelThreadId || threadId,
              rootSessionId: effectiveRootThreadId,
              isWarmIncremental,
              sawRealThinking,
              hasEmittedText,
              activePromptText: rawPromptForRephrase,
              ...(rephrasePreservePrefix ? { preserveContextPrefix: rephrasePreservePrefix } : {}),
            });
          }
        } else if (selection.agentMode === "advanced" && payload.turn_fatal === true) {
          gatewayErr = new GatewayError(
            "AWS Quick Advanced mode is not enabled on this account. Free-tier accounts should use quick-smart(Opus) or disable quick-advanced in Models.",
            403,
            "model_not_available",
          );
        } else if (errText) {
          gatewayErr = new GatewayError(
            `AWS Quick upstream error${errCode ? ` (${errCode})` : ""}: ${errText}`,
            502,
            "upstream_error",
          );
        } else {
          gatewayErr = new GatewayError(`${evType}: ${JSON.stringify(payload)}`, 502, "upstream_error");
        }
        push({ type: "__error", error: gatewayErr });
        if (!wsHandedOff) {
          try {
            ws.close();
          } catch { }
        }
        return;
      }
    }
  };

  const onWsError = (err: Error) => {
    clearAllStreamTimers();
    if (!ended) {
      ended = true;
      push({ type: "__error", error: mapSdkError(err) });
    }
  };

  const onWsClose = (code: number, reason: Buffer) => {
    clearAllStreamTimers();
    if (!ended) {
      // If upstream already delivered usage & text/tool call (with no pending cloud tools) and dropped the
      // socket right before `turn_complete`, finalize cleanly instead of failing the turn with 502.
      if (proto.hasUsage() && !proto.hasActiveCloudTools() && (hasEmittedText || hasEmittedToolCall || usageLimitPrefixBuf.length > 0)) {
        finalizeTurn(activeKernelThreadId || threadId, false);
        return;
      }
      ended = true;
      push({ type: "__error", error: new GatewayError(`WebSocket closed (${code}): ${reason.toString("utf8")}`, 502, "upstream_error") });
    }
  };

  let onWsOpen: (() => void) | null = null;
  ws.on("message", onWsMessage);
  ws.once("error", onWsError);
  ws.once("close", onWsClose);

  try {
    if (!ended && (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED)) {
      clearAllStreamTimers();
      ended = true;
      push({ type: "__error", error: new GatewayError("WebSocket closed before turn dispatch", 502, "upstream_error") });
    }
    if (!ended && preBufferedFrames && preBufferedFrames.length > 0) {
      for (const frameBuf of preBufferedFrames) {
        if (!ended) onWsMessage(frameBuf);
      }
    }
    if (!ended) {
      if (isReusedOpenWs && ws.readyState === WebSocket.OPEN) {
        startTurnPing();
        if (isStandbyWs) {
          // Fast half-open proxy detection: probe immediately with a WS ping and fail over in <=10s
          // if neither a pong nor any upstream frame arrives (prevents 90s+ dead NAT socket stalls).
          try {
            ws.ping();
          } catch { }
          standbyLivenessTimer = setTimeout(() => {
            if (!ended) {
              clearAllStreamTimers();
              ended = true;
              push({
                type: "__error",
                error: new GatewayError("Adopted standby WebSocket unresponsive (half-open proxy socket).", 502, "upstream_error"),
              });
              try {
                ws.terminate();
              } catch { }
            }
          }, 10_000);
          standbyLivenessTimer.unref?.();
        }
        if (!initialChunkSent) triggerInitialSend();
      } else if (preSessionConnectSent && ws.readyState === WebSocket.OPEN) {
        startTurnPing();
        if (!initialChunkSent) {
          if (!isWeb) {
            triggerInitialSend();
          } else {
            handshakeTimer = setTimeout(() => {
              try {
                triggerInitialSend();
              } catch (sendErr) {
                onWsError(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
              }
            }, 200);
            handshakeTimer.unref?.();
          }
        }
      } else {
        const sendConnectAndSchedule = () => {
          onWsOpen = null;
          if (ended) return;
          try {
            ws.send(
              encodeFrame({
                type: "session_connect",
                payload: {
                  ...(actorArn ? { actor_id: actorArn } : {}),
                  surfaceType,
                  outpostId,
                  appVersion,
                  ...DESKTOP_CAPABILITIES,
                  ...(isIncognito ? { incognito: true } : {}),
                },
              }),
            );
            if (!isWeb) {
              ws.send(encodeFrame({ type: "federate_status", payload: {} }));
            }
            startTurnPing();
            if (!isWeb) {
              // Live-verified on AWS Quick desktop WS: pipelining `user_message` immediately after
              // `session_connect` + `federate_status` eliminates a full handshake RTT (~350-512ms).
              triggerInitialSend();
            } else {
              handshakeTimer = setTimeout(() => {
                try {
                  triggerInitialSend();
                } catch (sendErr) {
                  onWsError(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
                }
              }, 200);
              handshakeTimer.unref?.();
            }
          } catch (openSendErr) {
            onWsError(openSendErr instanceof Error ? openSendErr : new Error(String(openSendErr)));
          }
        };
        if (ws.readyState === WebSocket.OPEN) {
          sendConnectAndSchedule();
        } else {
          onWsOpen = sendConnectAndSchedule;
          ws.once("open", sendConnectAndSchedule);
        }
      }
    }

    while (true) {
      await waitNext();
      while (qHead < queue.length) {
        const item = queue[qHead++]!;
        if (qHead >= 64 && qHead === queue.length) {
          queue.length = 0;
          qHead = 0;
        }
        if (item.type === "__error") throw item.error;
        yield item;
        if (item.type === "done") return;
      }
      if (ended) return;
    }
  } finally {
    warmPool.trackActiveWsEnd(slotId);
    clearAllStreamTimers();
    clearTimeout(timer);
    chunkedAssembler.clear();
    turn.signal?.removeEventListener("abort", onAbort);
    if (onWsOpen) {
      ws.off("open", onWsOpen);
      onWsOpen = null;
    }
    ws.off("pong", onWsPong);
    if (!wsParked && !wsHandedOff && !deferredGraceClose) {
      ws.off("message", onWsMessage);
      ws.off("error", onWsError);
      ws.off("close", onWsClose);
      safeCloseWs();
    }
  }
}
