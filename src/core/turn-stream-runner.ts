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
import { TurnProtocolTracker } from "./turn-protocol-state.js";
import {
  GatewayError,
  type GatewayStreamEvent,
  type ParsedProtocolTurn,
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

export interface RunTurnStreamParams {
  ws: WebSocket;
  isReusedOpenWs: boolean;
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
  showRoutedModelInThinking: boolean;
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
    webSearchEnabled,
    usageTracker,
    warmPool,
  } = params;

  const totalChunks = chunks.length;
  let effectiveRootThreadId = params.effectiveRootThreadId;
  let activeKernelThreadId = threadId;

  warmPool.trackActiveWsStart(slotId);

  const queue: Array<GatewayStreamEvent | { type: "__error"; error: Error }> = [];
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
      if (queue.length > 0 || ended) {
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
      ended = true;
      push({ type: "__error", error: new GatewayError("AWS Quick stream timed out", 504, "timeout_error") });
      try {
        ws.close();
      } catch { }
    }
  }, (runMaxTimeoutMs || 120_000) + Math.max(0, totalChunks - 1) * 50_000);

  let pingTimer: NodeJS.Timeout | null = null;
  let postUsageTimer: NodeJS.Timeout | null = null;
  let handshakeTimer: NodeJS.Timeout | null = null;
  let chunkAdvanceTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
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
  const clearAllStreamTimers = () => {
    clearPing();
    clearPostUsageTimer();
    clearAuxTimers();
    clearIdleTimer();
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

  const onAbort = () => {
    if (!ended) {
      ended = true;
      clearAllStreamTimers();
      const assistantMsgId = proto.getAssistantMessageId();
      if (ws.readyState === WebSocket.OPEN && assistantMsgId) {
        try {
          ws.send(
            encodeFrame({
              type: "stop_generation",
              payload: {
                message_id: assistantMsgId,
                thread_id: activeKernelThreadId || threadId,
              },
            }),
          );
        } catch { }
        const graceClose = setTimeout(() => {
          try {
            ws.close();
          } catch { }
        }, 350);
        graceClose.unref?.();
      } else {
        try {
          ws.close();
        } catch { }
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
  let hasEmittedText = false;
  let assistantOutputText = "";
  let usageLimitPrefixBuf = "";
  let usageLimitChecked = false;
  let resolvedModelId: string | undefined;
  let wsParked = false;
  let wsHandedOff = false;
  let lastSentMessageId: string | undefined;
  let pendingRoutedThinking: string | null = null;
  let sawRealThinking = false;
  let usageRecordedForTurn = false;

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

  const finalizeTurn = (realThreadId: string, allowParkWs = true) => {
    if (ended) return;
    clearAllStreamTimers();
    if (usageLimitPrefixBuf) {
      if (!sawRealThinking && isPseudo200UsageLimitText(usageLimitPrefixBuf)) {
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
    let pendingToolCalls: import("./types.js").NormalizedToolCall[] = [];
    if (toolFilter) {
      const { remainingText, toolCalls } = toolFilter.flush();
      const cleanRem = remainingText ? uiTagSanitizer.feed(remainingText) : remainingText;
      if (cleanRem) {
        hasEmittedText = true;
        assistantOutputText += cleanRem;
        push({ type: "text", text: cleanRem });
      }
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        emittedToolCalls = toolCalls.map((tc) => ({ id: tc.id, name: tc.name }));
        stopReason = "tool_calls";
      }
    }
    const tailText = uiTagSanitizer.flush();
    if (tailText) {
      hasEmittedText = true;
      assistantOutputText += tailText;
      push({ type: "text", text: tailText });
    }
    if (pendingToolCalls.length > 0) {
      push({ type: "tool_calls", calls: pendingToolCalls });
    }
    flushAggregatedTurnUsage();
    let parkedForReuse = false;
    const effectiveFinishThreadId = activeKernelThreadId || realThreadId;
    const effectiveContextWindow = proto.getMaxContextWindow() > 0 ? proto.getMaxContextWindow() : 1_000_000;
    const nearUpstreamContextLimit =
      proto.getMaxContextPercent() >= 80 ||
      proto.getMaxTotalTokens() >= Math.floor(effectiveContextWindow * 0.8);
    if (turn.currentInputPrefixHash && !isLikelySoftRefusal(assistantOutputText) && !nearUpstreamContextLimit) {
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
        parkedForReuse = warmPool.park({
          scope: turn.scope,
          conversationKey: turn.conversationKey,
          slotId,
          isIncognito,
          ...(chatAgentId ? { chatAgentId } : {}),
          prefixHashes: nextHashes,
          threadId: effectiveFinishThreadId,
          rootThreadId: effectiveRootThreadId,
          ...(allowParkWs
            ? {
              ws,
              outpostId,
              encodeFrame,
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
      try {
        ws.close();
      } catch { }
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
    ws.send(encodeFrame(frame));
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
  const maxThinkingOnlyMs = Math.max(120_000, Math.min(runIdleTimeoutMs || 300_000, 300_000));
  const onWsPong = () => {
    missedPongs = 0;
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
        } catch { }
      }
    }, 25_000);
    pingTimer.unref?.();
  };

  const onWsMessage = (data: Buffer) => {
    missedPongs = 0;
    let drainedMessages;
    try {
      recvBuf = appendWsRecvBuf(recvBuf, data);
      const { messages, consumed } = drainEventStream(recvBuf, 0);
      if (consumed > 0) recvBuf = recvBuf.subarray(consumed);
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

      if (evType === "tree_sync") {
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

      const advanceIntermediateChunk = (forChunkIdx: number) => {
        if (!awaitingChunkAck || advancingChunk || ended || activeChunkIndex !== forChunkIdx || activeChunkIndex >= totalChunks - 1) return;
        awaitingChunkAck = false;
        clearPostUsageTimer();
        advancingChunk = true;
        const drainDelayMs = activeChunkIndex === totalChunks - 2 ? 400 : 250;
        chunkAdvanceTimer = setTimeout(() => {
          chunkAdvanceTimer = null;
          if (ended || activeChunkIndex !== forChunkIdx) {
            advancingChunk = false;
            return;
          }
          activeChunkIndex += 1;
          advancingChunk = false;
          sendChunkMessage(activeChunkIndex);
        }, drainDelayMs);
      };
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

      const rawThinkingObj =
        turn.rawBody?.thinking && typeof turn.rawBody.thinking === "object"
          ? (turn.rawBody.thinking as { type?: unknown })
          : undefined;
      const rawReasoningObj =
        turn.rawBody?.reasoning && typeof turn.rawBody.reasoning === "object"
          ? (turn.rawBody.reasoning as { effort?: unknown })
          : undefined;
      const explicitThinkingDisabled =
        rawThinkingObj?.type === "disabled" ||
        turn.rawBody?.enable_thinking === false ||
        turn.rawBody?.reasoning_effort === "none" ||
        turn.rawBody?.reasoning_effort === "off" ||
        rawReasoningObj?.effort === "none" ||
        rawReasoningObj?.effort === "off";
      const canEmitRoutedThinking = () =>
        showRoutedModelInThinking && !explicitThinkingDisabled && !emittedRoutedModel && !hasEmittedText;
      const emitOrDeferRoutedThinking = (modelName: string) => {
        emittedRoutedModel = true;
        const rephraseTag = isRephraseRetry ? " · rephrased" : "";
        const line = `[AWS Quick] mode=${selection.agentMode} · effort=${selection.thinkingEffort} · routed=${modelName}${rephraseTag}\n`;
        if (!usageLimitChecked) pendingRoutedThinking = line;
        else push({ type: "thinking", text: line });
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
        continue;
      }
      if (evType === "thinking_complete") {
        clearPostUsageTimer();
        touchIdleTimer();
        proto.onThinkingComplete();
        continue;
      }
      if (evType === "tool_start") {
        clearPostUsageTimer();
        touchIdleTimer();
        proto.onCloudToolStart(
          typeof payload.tool_id === "string" ? payload.tool_id : undefined,
          typeof payload.tool_name === "string" ? payload.tool_name : undefined,
        );
        continue;
      }
      if (evType === "tool_progress" || evType === "tool_arguments") {
        clearPostUsageTimer();
        touchIdleTimer();
        continue;
      }
      if (evType === "tool_result") {
        clearPostUsageTimer();
        touchIdleTimer();
        proto.onCloudToolResult(
          typeof payload.tool_id === "string" ? payload.tool_id : undefined,
          typeof payload.tool_name === "string" ? payload.tool_name : undefined,
        );
        continue;
      }

      if (evType === "routing_decision") {
        touchIdleTimer();
        const routed = String(payload.resolved_model_id || payload.model_id || payload.model || "");
        if (routed) {
          resolvedModelId = routed;
          proto.setResolvedModel(routed);
          if (canEmitRoutedThinking()) emitOrDeferRoutedThinking(routed);
        }
      } else if (evType === "text_delta") {
        clearPostUsageTimer();
        thinkingOnlyStartedAt = 0;
        touchIdleTimer();
        const delta = String(payload.delta || "");
        if (delta) {
          const afterTools = toolFilter ? toolFilter.feed(delta) : delta;
          const emitText = afterTools ? uiTagSanitizer.feed(afterTools) : afterTools;
          if (emitText) emitGuardedText(emitText);
        }
        if (proto.hasUsage() && !proto.hasActiveCloudTools()) {
          const usageThreadId = String(ev.thread_id || threadId);
          postUsageTimer = setTimeout(() => finalizeTurn(usageThreadId, false), 20_000);
        }
      } else if (evType === "thinking_delta") {
        clearPostUsageTimer();
        if (!hasEmittedText) {
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
        }
        touchIdleTimer();
        const delta = String(payload.delta || "");
        if (delta) {
          usageLimitChecked = true;
          sawRealThinking = true;
          flushPendingRoutedThinking();
          if (usageLimitPrefixBuf) {
            const flushed = usageLimitPrefixBuf;
            usageLimitPrefixBuf = "";
            hasEmittedText = true;
            assistantOutputText += flushed;
            push({ type: "text", text: flushed });
          }
          push({ type: "thinking", text: delta });
        }
        if (proto.hasUsage() && !proto.hasActiveCloudTools()) {
          const usageThreadId = String(ev.thread_id || threadId);
          postUsageTimer = setTimeout(() => finalizeTurn(usageThreadId, false), 20_000);
        }
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
          if (canEmitRoutedThinking()) emitOrDeferRoutedThinking(served);
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
        const errText = typeof payload.error === "string" ? payload.error : "";
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
      ended = true;
      push({ type: "__error", error: new GatewayError(`WebSocket closed (${code}): ${reason.toString("utf8")}`, 502, "upstream_error") });
    }
  };

  ws.on("message", onWsMessage);
  ws.once("error", onWsError);
  ws.once("close", onWsClose);

  try {
    if (isReusedOpenWs && ws.readyState === WebSocket.OPEN) {
      startTurnPing();
      triggerInitialSend();
    } else {
      ws.once("open", () => {
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
          handshakeTimer = setTimeout(() => {
            try {
              triggerInitialSend();
            } catch (sendErr) {
              onWsError(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
            }
          }, 200);
          handshakeTimer.unref?.();
        } catch (openSendErr) {
          onWsError(openSendErr instanceof Error ? openSendErr : new Error(String(openSendErr)));
        }
      });
    }

    while (true) {
      await waitNext();
      while (queue.length > 0) {
        const item = queue.shift()!;
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
    ws.off("pong", onWsPong);
    if (!wsParked && !wsHandedOff) {
      ws.off("message", onWsMessage);
      ws.off("error", onWsError);
      ws.off("close", onWsClose);
      try {
        ws.close();
      } catch { }
    }
  }
}
