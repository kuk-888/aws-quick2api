import crypto from "node:crypto";
import WebSocket from "ws";
import {
  decodeCloudOutputFrame,
  decodeGatewayFrame,
  encodeCloudInputFrame,
  encodeGatewayJsonFrame,
} from "../aws-quick/event-stream-cbor.js";
import { resolveOAuthAccessToken } from "../aws-quick/oauth-client.js";
import { parseQuickCredential, stopSharedOutpost } from "../aws-quick/outpost-singleton.js";
import type { SDKModel } from "../aws-quick/types.js";
import {
  APP_VERSION,
  createAndPublishCodingAgentForKey as createCodingAgentViaWs,
  DEFAULT_CODING_AGENT_DESCRIPTION,
  DEFAULT_CODING_AGENT_INSTRUCTIONS,
  DEFAULT_CODING_AGENT_NAME,
  deleteCloudSessionsForKey as deleteCloudSessionsViaWs,
  dialQuickWebSocket,
  LEGACY_CODING_AGENT_NAMES,
  listChatAgentsForKey as listChatAgentsViaWs,
  SURFACE_TYPE,
  updateAndPublishAgentForKey as updateAgentViaWs,
  type QuickChatAgentInfo,
  type QuickFrameDecoder,
  type QuickFrameEncoder,
  type QuickWebSocketFactory,
} from "../aws-quick/ws-transport.js";
import { listLiveModels, resolveModelSelection } from "../services/model-catalog.js";
import type { ExecutionModeTag, UsageTracker } from "../services/usage-tracker.js";
import { redactSecrets } from "../utils/hash.js";
import type { UpstreamKeyPool } from "./key-pool.js";
import {
  assertSafeRemoteImageUrl,
  buildOutOfBandContextPrompt,
  buildQuickImageAttachments,
  estimatePromptTokens,
  isPrivateOrReservedIp,
  mapAttachmentUploadError,
  MAX_INLINE_FILES,
  MAX_INLINE_IMAGES,
  pinnedHttpGet,
  splitPromptIntoSafeChunks,
  type QuickAttachment,
  type QuickImageAttachment,
} from "./media-utils.js";
import { RequestAttachmentCache } from "./request-attachment-cache.js";
import {
  buildToolBridgePrompt,
  sanitizeClientSystemPromptForQuick,
  StreamingToolCallFilter,
  stripHighRiskClientHeaders,
} from "./tool-bridge.js";
import {
  buildPromptAndAttachmentsForTurn,
  finalizePromptChunksAndOutOfBandText,
} from "./turn-attachment-builder.js";
import { runTurnStream, type ContentFilterCaptureContext } from "./turn-stream-runner.js";
import {
  GatewayError,
  type GatewayConfig,
  type GatewayStreamEvent,
  type ParsedProtocolTurn,
} from "./types.js";
import { StreamingUiTagSanitizer } from "./ui-tag-sanitizer.js";
import {
  classifyUpstreamError,
  DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
  DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
  isLikelySoftRefusal,
  isPseudo200UsageLimitPrefix,
  isPseudo200UsageLimitText,
  mapSdkError,
  SOFT_REFUSAL_PATTERNS,
} from "./upstream-errors.js";
import { MAX_PARKED_WS_PER_SLOT, WarmSessionPool } from "./warm-session-pool.js";

export type AgentFactory = unknown;

// Re-export extracted helpers & constants so all external imports remain 100% backward-compatible.
export {
  assertSafeRemoteImageUrl,
  buildOutOfBandContextPrompt,
  buildQuickImageAttachments,
  classifyUpstreamError,
  DEFAULT_CODING_AGENT_DESCRIPTION,
  DEFAULT_CODING_AGENT_INSTRUCTIONS,
  DEFAULT_CODING_AGENT_NAME,
  DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
  DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
  estimatePromptTokens,
  isLikelySoftRefusal,
  isPrivateOrReservedIp,
  isPseudo200UsageLimitPrefix,
  isPseudo200UsageLimitText,
  LEGACY_CODING_AGENT_NAMES,
  mapAttachmentUploadError,
  mapSdkError,
  MAX_PARKED_WS_PER_SLOT,
  pinnedHttpGet,
  SOFT_REFUSAL_PATTERNS,
  splitPromptIntoSafeChunks,
  type QuickAttachment,
  type QuickChatAgentInfo,
  type QuickImageAttachment,
};

export class QuickExecutionEngine {
  private readonly config: GatewayConfig;
  private readonly usageTracker: UsageTracker;
  private readonly modelListFetcher?: (apiKey: string) => Promise<SDKModel[]>;
  private readonly webSocketFactory?: QuickWebSocketFactory;
  private readonly autoEnsureCodingAgent: boolean;
  private readonly showRoutedModelInThinking: boolean;
  private readonly webSearchEnabled: boolean;
  private readonly workingSessionIds = new Map<string, string>();
  private readonly warmPool: WarmSessionPool;
  private readonly ensuringAgentBySlot = new Map<string, Promise<string | undefined>>();
  private readonly autoEnsureFailedSlots = new Map<string, { failedAt: number; count: number }>();

  constructor(options: {
    config: GatewayConfig;
    usageTracker: UsageTracker;
    agentFactory?: AgentFactory;
    modelListFetcher?: (apiKey: string) => Promise<SDKModel[]>;
    webSocketFactory?: QuickWebSocketFactory;
  }) {
    this.config = options.config;
    this.usageTracker = options.usageTracker;
    this.modelListFetcher = options.modelListFetcher;
    this.webSocketFactory = options.webSocketFactory;
    this.warmPool = new WarmSessionPool({
      maxWarmSessions: options.config.maxWarmSessions,
      warmSessionTtlMs: options.config.warmSessionTtlMs,
    });
    this.autoEnsureCodingAgent = process.env.AUTO_ENSURE_CODING_AGENT !== "false";
    this.showRoutedModelInThinking = process.env.SHOW_ROUTED_MODEL_IN_THINKING !== "false";
    this.webSearchEnabled = process.env.WEB_SEARCH_ENABLED !== "false";
  }

  runtimeStats() {
    const { warmIncrementalSessions, warmIdleSessions } = this.warmPool.stats();
    return {
      parkedToolSessions: 0,
      warmIncrementalSessions,
      warmIdleSessions,
      memoryStore: { blobs: 0, totalBytes: 0 },
    };
  }

  async sweepStaleAssets(): Promise<void> {
    this.warmPool.sweepExpired();
  }

  async disposeAll(): Promise<void> {
    this.warmPool.disposeAll();
    stopSharedOutpost();
  }

  async resolveModel(apiKey: string, requestedModel: string, body: Record<string, unknown>) {
    const models = await listLiveModels(apiKey, this.modelListFetcher);
    return resolveModelSelection(requestedModel, body, models.find((m) => m.id === requestedModel));
  }

  async deleteCloudSessionsForKey(apiKey: string, sessionIds: string[], proxyUrl?: string): Promise<string[]> {
    return deleteCloudSessionsViaWs(apiKey, sessionIds, proxyUrl, this.webSocketFactory);
  }

  async listChatAgentsForKey(apiKey: string, proxyUrl?: string): Promise<QuickChatAgentInfo[]> {
    return listChatAgentsViaWs(apiKey, proxyUrl, this.webSocketFactory);
  }

  async createAndPublishCodingAgentForKey(
    apiKey: string,
    opts?: { name?: string; description?: string; instructions?: string },
    proxyUrl?: string,
  ): Promise<{ agentId: string; name: string }> {
    return createCodingAgentViaWs(apiKey, opts, proxyUrl, this.webSocketFactory);
  }

  async updateAndPublishAgentForKey(
    apiKey: string,
    agentId: string,
    opts: { instructions: string; name?: string; description?: string },
    proxyUrl?: string,
  ): Promise<{ agentId: string }> {
    return updateAgentViaWs(apiKey, agentId, opts, proxyUrl, this.webSocketFactory);
  }

  /**
   * Finds an existing custom agent on the account (preferring `Coding Assistant` / legacy names,
   * otherwise any existing non-SYSTEM custom agent) or creates & publishes one, then binds it to `slotId`.
   * Deduplicates concurrent calls per `slotId` and fails open on errors.
   */
  async ensureCodingAgentForKey(
    apiKey: string,
    slotId: string,
    keyPool: UpstreamKeyPool,
    proxyUrl?: string,
    opts?: { forceCreate?: boolean },
  ): Promise<string | undefined> {
    const existingPromise = this.ensuringAgentBySlot.get(slotId);
    if (existingPromise && !opts?.forceCreate) {
      return existingPromise;
    }

    const work = (async (): Promise<string | undefined> => {
      try {
        if (!opts?.forceCreate) {
          const agents = await this.listChatAgentsForKey(apiKey, proxyUrl);
          const customAgents = agents.filter((a) => !a.isSystem);
          const knownNames = new Set(LEGACY_CODING_AGENT_NAMES.map((n) => n.toLowerCase()));
          const preferred =
            customAgents.find((a) => knownNames.has(a.name.trim().toLowerCase())) || customAgents[0];
          if (preferred) {
            const chosenId = preferred.shortId || preferred.agentId;
            keyPool.updateSlotMeta(slotId, { chatAgentId: chosenId });
            this.autoEnsureFailedSlots.delete(slotId);
            return chosenId;
          }
        }
        const templatePrompt = keyPool.getSettings().customAgentPrompt || DEFAULT_CODING_AGENT_INSTRUCTIONS;
        const created = await this.createAndPublishCodingAgentForKey(
          apiKey,
          { instructions: templatePrompt },
          proxyUrl,
        );
        keyPool.updateSlotMeta(slotId, { chatAgentId: created.agentId });
        this.autoEnsureFailedSlots.delete(slotId);
        return created.agentId;
      } catch (err) {
        const prev = this.autoEnsureFailedSlots.get(slotId);
        const failCount = (prev?.count || 0) + 1;
        this.autoEnsureFailedSlots.set(slotId, { failedAt: Date.now(), count: failCount });
        console.warn(
          JSON.stringify({
            event: "ensure_coding_agent_failed",
            slotId,
            failCount,
            reason: redactSecrets(err instanceof Error ? err.message : String(err || "unknown")).slice(0, 200),
          }),
        );
        return undefined;
      }
    })();

    this.ensuringAgentBySlot.set(slotId, work);
    void work.finally(() => {
      if (this.ensuringAgentBySlot.get(slotId) === work) {
        this.ensuringAgentBySlot.delete(slotId);
      }
    });
    return work;
  }

  async *executeTurnWithPool(
    turn: ParsedProtocolTurn,
    keyPool: UpstreamKeyPool,
    onExecMeta?: (meta: {
      slotId?: string;
      maskedKey: string;
      accountLabel?: string;
      execMode: ExecutionModeTag;
      usedProxy?: boolean;
      contentFilterRecovered?: boolean;
      warmFallbackToCold?: boolean;
      accountFailoverCount?: number;
      usedDefaultSystemAgent?: boolean;
    }) => void,
  ): AsyncGenerator<GatewayStreamEvent, void, unknown> {
    // Pre-lease validation: reject empty prompts, attachment count overflows, and SSRF URLs before leasing a slot.
    const allImages = [...(turn.images || []), ...(turn.incrementalImages || [])];
    const allFiles = [...(turn.files || []), ...(turn.incrementalFiles || [])];
    if (!turn.fullTranscriptText?.trim() && allImages.length === 0 && allFiles.length === 0) {
      throw new GatewayError("Empty prompt", 400, "invalid_request_error");
    }
    const currentTurnImages = turn.incrementalImages ?? turn.images ?? [];
    if (currentTurnImages.length > MAX_INLINE_IMAGES) {
      throw new GatewayError(
        `Too many images in request (${currentTurnImages.length}; max supported per turn is ${MAX_INLINE_IMAGES}).`,
        400,
        "invalid_request_error",
      );
    }
    const currentTurnFiles = turn.incrementalFiles ?? turn.files ?? [];
    if (currentTurnFiles.length > MAX_INLINE_FILES) {
      throw new GatewayError(
        `Too many files in request (${currentTurnFiles.length}; max supported per turn is ${MAX_INLINE_FILES}).`,
        400,
        "invalid_request_error",
      );
    }
    const checkedRemoteUrls = new Set<string>();
    for (const img of allImages) {
      if ("url" in img && img.url && !img.url.startsWith("data:") && !checkedRemoteUrls.has(img.url)) {
        checkedRemoteUrls.add(img.url);
        await assertSafeRemoteImageUrl(img.url);
      }
    }
    for (const f of allFiles) {
      if (f.url && !f.url.startsWith("data:") && !checkedRemoteUrls.has(f.url)) {
        checkedRemoteUrls.add(f.url);
        await assertSafeRemoteImageUrl(f.url);
      }
    }

    const excluded = new Set<string>();
    const retriedAuthRefreshSlots = new Set<string>();
    const attachmentCache = new RequestAttachmentCache();
    const maxAttempts = Math.min(Math.max(1, keyPool.enabledKeyCount()), 5);
    let remainingWaitBudgetMs = 18_000;
    let retriedSameSlotConnLimit = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const waitStartedAt = Date.now();
      const lease = await keyPool.leaseKeyWithWait(
        turn.requestedModel,
        excluded.size > 0 ? excluded : undefined,
        turn.conversationKey,
        {
          signal: turn.signal,
          maxWaitMs: Math.max(0, Math.min(15_000, remainingWaitBudgetMs)),
        },
      );
      remainingWaitBudgetMs = Math.max(0, remainingWaitBudgetMs - (Date.now() - waitStartedAt));
      const poolSettings = keyPool.getSettings();
      const isIncognito = poolSettings.incognitoMode;
      const shouldAutoEnsure =
        poolSettings.autoEnsureCodingAgent !== undefined
          ? poolSettings.autoEnsureCodingAgent
          : this.autoEnsureCodingAgent;
      let effectiveChatAgentId = (lease.chatAgentId || poolSettings.chatAgentId || "").trim() || undefined;
      let yieldedOutput = false;
      let hasEmittedClientText = false;
      let hasEmittedThinking = false;
      let retriedContentFilterRephrase = false;
      let lastExecMode: ExecutionModeTag | undefined;
      let capturedFilterCtx: ContentFilterCaptureContext | undefined;
      const closeCapturedFilterWs = () => {
        if (capturedFilterCtx?.ws) {
          const staleWs = capturedFilterCtx.ws;
          const errFn = capturedFilterCtx.onIdleErr;
          capturedFilterCtx.ws = undefined;
          capturedFilterCtx.onIdleErr = undefined;
          if (errFn) staleWs.off("error", errFn);
          staleWs.on("error", () => { });
          try {
            staleWs.close();
          } catch { }
        }
      };
      const wrappedMeta: typeof onExecMeta = (meta) => {
        lastExecMode = meta.execMode;
        onExecMeta?.({
          ...meta,
          ...(attempt > 0 ? { accountFailoverCount: attempt } : {}),
        });
      };
      const isInternalCall = Boolean(turn.rawBody?.__internalRephrase);
      const allowContentFilterRephrase =
        poolSettings.autoRephraseOnContentFilter === true && !isInternalCall;

      try {
        if (!effectiveChatAgentId && shouldAutoEnsure && !isInternalCall && !turn.signal?.aborted) {
          const failRec = this.autoEnsureFailedSlots.get(lease.slotId);
          const backoffMs = failRec
            ? [30_000, 120_000, 600_000, 1_800_000][Math.min(failRec.count - 1, 3)]!
            : 0;
          if (!failRec || Date.now() - failRec.failedAt > backoffMs) {
            const ensurePromise = this.ensureCodingAgentForKey(
              lease.apiKey,
              lease.slotId,
              keyPool,
              lease.proxyUrl,
            ).catch(() => undefined);
            if (turn.signal) {
              effectiveChatAgentId = await new Promise<string | undefined>((resolve) => {
                if (turn.signal!.aborted) return resolve(undefined);
                const onAbort = () => resolve(undefined);
                turn.signal!.addEventListener("abort", onAbort, { once: true });
                ensurePromise.then((val) => {
                  turn.signal!.removeEventListener("abort", onAbort);
                  resolve(val);
                });
              });
            } else {
              effectiveChatAgentId = await ensurePromise;
            }
          }
        }
        if (turn.signal?.aborted) {
          throw new GatewayError("Request aborted before starting upstream turn.", 499, "client_aborted");
        }
        const initialLeaseOpts = {
          attachmentCache,
          ...(allowContentFilterRephrase
            ? {
                onContentFilterCapture: (ctx: NonNullable<typeof capturedFilterCtx>) => {
                  closeCapturedFilterWs();
                  capturedFilterCtx = ctx;
                },
              }
            : {}),
        };
        for await (const ev of this.executeTurnWithLease(
          turn,
          lease,
          isIncognito,
          wrappedMeta,
          effectiveChatAgentId,
          keyPool,
          initialLeaseOpts,
        )) {
          if (ev.type === "text" || ev.type === "tool_calls") {
            yieldedOutput = true;
            hasEmittedClientText = true;
          } else if (ev.type === "thinking") {
            yieldedOutput = true;
            hasEmittedThinking = true;
          }
          yield ev;
        }
        closeCapturedFilterWs();
        lease.markSuccess();
        return;
      } catch (err) {
        let gwErr = mapSdkError(err);

        // Opt-in defensive auto-rephrase on upstream `content_filtered` (strictly keeps the requested model).
        if (
          gwErr.code === "content_filter" &&
          allowContentFilterRephrase &&
          (!hasEmittedClientText || !turn.stream) &&
          !retriedContentFilterRephrase &&
          !turn.signal?.aborted
        ) {
          retriedContentFilterRephrase = true;
          const filterCtx = capturedFilterCtx;
          const rawTargetText =
            filterCtx?.activePromptText || turn.incrementalUserText || turn.fullTranscriptText;
          const rephrased = await this.rephrasePromptForContentFilter(
            rawTargetText,
            lease,
            poolSettings,
            turn.signal,
            effectiveChatAgentId,
          ).catch(() => undefined);

          if (rephrased && rephrased.trim() && rephrased.trim() !== rawTargetText.trim()) {
            const editBranch =
              filterCtx?.ws &&
              filterCtx.ws.readyState === WebSocket.OPEN &&
              filterCtx.isWarmIncremental &&
              filterCtx.messageId
                ? {
                    ws: filterCtx.ws,
                    outpostId: filterCtx.outpostId || "web0",
                    originalMessageId: filterCtx.messageId,
                    rootSessionId: filterCtx.rootSessionId,
                    threadId: filterCtx.threadId,
                  }
                : undefined;
            if (editBranch && capturedFilterCtx) {
              if (capturedFilterCtx.onIdleErr) {
                editBranch.ws.off("error", capturedFilterCtx.onIdleErr);
                capturedFilterCtx.onIdleErr = undefined;
              }
              capturedFilterCtx.ws = undefined;
            } else {
              closeCapturedFilterWs();
            }
            try {
              if (turn.stream && hasEmittedThinking) {
                yield {
                  type: "thinking",
                  text: "\n[Content filter triggered before answer; retrying with defensive phrasing...]\n",
                };
              }
              const rephrasedFinalPrompt =
                !editBranch && filterCtx?.preserveContextPrefix
                  ? `${filterCtx.preserveContextPrefix}${rephrased.trim()}`
                  : rephrased.trim();
              for await (const ev of this.executeTurnWithLease(
                turn,
                lease,
                isIncognito,
                wrappedMeta,
                effectiveChatAgentId,
                keyPool,
                {
                  attachmentCache,
                  overridePromptText: rephrasedFinalPrompt,
                  ...(editBranch ? { editBranch } : { forceColdReplay: true }),
                  isRephraseRetry: true,
                },
              )) {
                if (ev.type === "text" || ev.type === "tool_calls") {
                  yieldedOutput = true;
                  hasEmittedClientText = true;
                } else if (ev.type === "thinking") {
                  yieldedOutput = true;
                  hasEmittedThinking = true;
                }
                yield ev;
              }
              lease.markSuccess();
              return;
            } catch (rephraseRetryErr) {
              err = rephraseRetryErr;
              gwErr = mapSdkError(rephraseRetryErr);
            }
          } else {
            closeCapturedFilterWs();
          }
        } else {
          closeCapturedFilterWs();
        }

        const preClass = classifyUpstreamError(gwErr);
        // Fail-safe: warm_incremental failure before output falls back once to cold replay on the same account.
        if (
          lastExecMode === "warm_incremental" &&
          !yieldedOutput &&
          !turn.signal?.aborted &&
          gwErr.code !== "content_filter" &&
          gwErr.code !== "content_filtered" &&
          !preClass.isQuotaErr &&
          !preClass.isConnLimitErr &&
          !preClass.isRateLimitErr &&
          !preClass.isAuthErr
        ) {
          try {
            for await (const ev of this.executeTurnWithLease(
              turn,
              lease,
              isIncognito,
              wrappedMeta,
              effectiveChatAgentId,
              keyPool,
              { attachmentCache, warmFallbackToCold: true },
            )) {
              if (ev.type === "text" || ev.type === "thinking" || ev.type === "tool_calls") {
                yieldedOutput = true;
              }
              yield ev;
            }
            lease.markSuccess();
            return;
          } catch (fallbackErr) {
            err = fallbackErr;
          }
        }
        let finalErr = mapSdkError(err);
        let msg = finalErr.message || "";
        let { isConnLimitErr, isQuotaErr, isRateLimitErr, isAuthErr, isProxyOrConnErr } =
          classifyUpstreamError(finalErr);

        // On 401/403 auth errors for OAuth accounts, force-refresh once before marking auth-failed.
        if (
          isAuthErr &&
          !yieldedOutput &&
          !turn.signal?.aborted &&
          !retriedAuthRefreshSlots.has(lease.slotId)
        ) {
          const parsedCred = parseQuickCredential(lease.apiKey);
          if (parsedCred.mode === "oauth" && parsedCred.oauth) {
            retriedAuthRefreshSlots.add(lease.slotId);
            try {
              await resolveOAuthAccessToken(parsedCred.oauth, true, lease.proxyUrl);
              attempt -= 1;
              continue;
            } catch (refreshErr) {
              finalErr = mapSdkError(refreshErr);
              msg = finalErr.message || "";
              ({ isConnLimitErr, isQuotaErr, isRateLimitErr, isAuthErr, isProxyOrConnErr } =
                classifyUpstreamError(finalErr));
            }
          }
        }

        const evictedParked = isConnLimitErr
          ? this.warmPool.evictParkedWsForSlot(lease.slotId, Number.POSITIVE_INFINITY)
          : 0;

        if (
          isConnLimitErr &&
          evictedParked > 0 &&
          !retriedSameSlotConnLimit &&
          !yieldedOutput &&
          !turn.signal?.aborted
        ) {
          retriedSameSlotConnLimit = true;
          await new Promise<void>((r) => setTimeout(r, 200));
          attempt -= 1;
          continue;
        }

        if (isQuotaErr) {
          keyPool.reportQuotaExhausted(lease.apiKey, turn.requestedModel, msg);
        } else if (isConnLimitErr) {
          keyPool.reportConnLimit(lease.apiKey);
        } else if (isRateLimitErr) {
          const retryAfterMatch = /retry[-_\s]?after[\s:=]+(\d+(?:\.\d+)?)/i.exec(msg);
          const retryAfterMs = retryAfterMatch ? Number(retryAfterMatch[1]) * 1_000 : undefined;
          keyPool.reportRateLimit(lease.apiKey, retryAfterMs);
        } else if (isProxyOrConnErr) {
          keyPool.reportTransientError(lease.apiKey);
        } else if (isAuthErr) {
          keyPool.reportAuthFailure(lease.apiKey, msg);
        }

        const canFailover =
          !yieldedOutput &&
          !turn.signal?.aborted &&
          (isQuotaErr || isConnLimitErr || isRateLimitErr || isAuthErr || isProxyOrConnErr) &&
          attempt + 1 < maxAttempts;

        if (canFailover) {
          excluded.add(lease.apiKey);
          const hasUntriedEnabledKey = keyPool
            .allManagedKeys()
            .some((k) => k.enabled && !excluded.has(k.rawKey));
          if (hasUntriedEnabledKey) continue;
        }
        throw finalErr;
      } finally {
        closeCapturedFilterWs();
        lease.release();
      }
    }
  }

  private async *executeTurnWithLease(
    turn: ParsedProtocolTurn,
    lease: ReturnType<UpstreamKeyPool["leaseKey"]>,
    isIncognito: boolean,
    onExecMeta?: (meta: {
      slotId?: string;
      maskedKey: string;
      accountLabel?: string;
      execMode: ExecutionModeTag;
      usedProxy?: boolean;
      contentFilterRecovered?: boolean;
      warmFallbackToCold?: boolean;
      accountFailoverCount?: number;
      usedDefaultSystemAgent?: boolean;
    }) => void,
    chatAgentId?: string,
    keyPool?: UpstreamKeyPool,
    turnOpts?: {
      attachmentCache?: RequestAttachmentCache;
      overridePromptText?: string;
      forceColdReplay?: boolean;
      isRephraseRetry?: boolean;
      warmFallbackToCold?: boolean;
      editBranch?: {
        ws: WebSocket;
        outpostId: string;
        originalMessageId: string;
        rootSessionId: string;
        threadId: string;
      };
      onContentFilterCapture?: (ctx: ContentFilterCaptureContext) => void;
    },
  ): AsyncGenerator<GatewayStreamEvent, void, unknown> {
    const { selection } = await this.resolveModel(lease.apiKey, turn.requestedModel, turn.rawBody);

    const hasCustomAgent = Boolean(chatAgentId);
    const toolBridgePrompt = buildToolBridgePrompt(turn.tools, turn.toolChoice, {
      compactForCustomAgent: hasCustomAgent,
      preferClientToolsOverWorkspace: true,
    });
    const customPromptParts: string[] = [];
    if (turn.systemPrompt?.trim()) {
      const strippedSys = stripHighRiskClientHeaders(turn.systemPrompt.trim());
      const sysText = toolBridgePrompt ? sanitizeClientSystemPromptForQuick(strippedSys, true) : strippedSys;
      if (sysText) customPromptParts.push(sysText);
    }
    if (toolBridgePrompt) customPromptParts.push(toolBridgePrompt);
    const customPrompt = customPromptParts.length > 0 ? customPromptParts.join("\n\n") : null;

    const editBranch = turnOpts?.editBranch;
    const warmHit =
      !editBranch &&
      !turnOpts?.forceColdReplay &&
      turn.priorPrefixHash &&
      turn.incrementalUserText !== undefined
        ? this.warmPool.lookup(turn.scope, turn.conversationKey, lease.slotId, isIncognito, turn.priorPrefixHash, chatAgentId)
        : undefined;
    let warmThreadId = editBranch ? editBranch.threadId : warmHit?.threadId;
    const rootThreadId = editBranch ? editBranch.rootSessionId : warmHit?.rootThreadId;
    let reusedWs = editBranch ? editBranch.ws : warmHit?.reusedWs;
    let isWarmIncremental = Boolean(editBranch || warmThreadId);

    let tempReusedDead = false;
    const onTempReusedDead = () => {
      tempReusedDead = true;
    };
    if (reusedWs) {
      reusedWs.on("error", onTempReusedDead);
      reusedWs.on("close", onTempReusedDead);
    }

    const cred = parseQuickCredential(lease.apiKey);
    const isWeb = cred.mode === "web" && Boolean(cred.web);
    const isOAuthAccount = cred.mode === "oauth" && Boolean(cred.oauth);
    const effectiveProxy = lease.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const isInternalHelperCall = Boolean(turn.rawBody?.__internalRephrase);
    let workingSessionId = isInternalHelperCall
      ? crypto.randomUUID()
      : this.workingSessionIds.get(lease.slotId);
    if (!workingSessionId) {
      workingSessionId = crypto.randomUUID();
      this.workingSessionIds.set(lease.slotId, workingSessionId);
    }

    if (reusedWs && (tempReusedDead || reusedWs.readyState !== WebSocket.OPEN)) {
      reusedWs.off("error", onTempReusedDead);
      reusedWs.off("close", onTempReusedDead);
      try {
        reusedWs.close();
      } catch { }
      reusedWs = undefined;
      if (isIncognito) {
        warmThreadId = undefined;
        isWarmIncremental = false;
      }
    }
    let threadId = warmThreadId || crypto.randomUUID();
    let effectiveRootThreadId = rootThreadId || threadId;
    const reqAttCache = turnOpts?.attachmentCache;

    let prompt: string;
    let attachments: QuickAttachment[];
    try {
      const built = await buildPromptAndAttachmentsForTurn({
        turn,
        slotId: lease.slotId,
        customPrompt,
        incremental: isWarmIncremental,
        threadId,
        overridePromptText: turnOpts?.overridePromptText,
        isOAuthAccount,
        oauthCred: cred.oauth,
        isWeb,
        webCred: cred.web,
        effectiveProxy,
        reqAttCache,
      });
      prompt = built.promptText;
      attachments = built.attachments;

      if (reusedWs && (tempReusedDead || reusedWs.readyState !== WebSocket.OPEN)) {
        reusedWs.off("error", onTempReusedDead);
        reusedWs.off("close", onTempReusedDead);
        try {
          reusedWs.close();
        } catch { }
        reusedWs = undefined;
        if (isIncognito) {
          warmThreadId = undefined;
          isWarmIncremental = false;
          threadId = crypto.randomUUID();
          effectiveRootThreadId = threadId;
          const coldBuilt = await buildPromptAndAttachmentsForTurn({
            turn,
            slotId: lease.slotId,
            customPrompt,
            incremental: false,
            threadId,
            overridePromptText: turnOpts?.overridePromptText,
            isOAuthAccount,
            oauthCred: cred.oauth,
            isWeb,
            webCred: cred.web,
            effectiveProxy,
            reqAttCache,
          });
          prompt = coldBuilt.promptText;
          attachments = coldBuilt.attachments;
        }
      }
    } catch (prepErr) {
      if (reusedWs) {
        reusedWs.off("error", onTempReusedDead);
        reusedWs.off("close", onTempReusedDead);
        try {
          reusedWs.close();
        } catch { }
      }
      throw prepErr;
    }

    if (reusedWs) {
      reusedWs.off("error", onTempReusedDead);
      reusedWs.off("close", onTempReusedDead);
    }

    const execMode: ExecutionModeTag = isWarmIncremental
      ? "warm_incremental"
      : isIncognito
        ? "incognito"
        : "cloud";

    onExecMeta?.({
      slotId: lease.slotId,
      maskedKey: lease.maskedKey,
      accountLabel: lease.label,
      execMode,
      usedProxy: Boolean(lease.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY),
      ...(turnOpts?.isRephraseRetry ? { contentFilterRecovered: true } : {}),
      ...(turnOpts?.warmFallbackToCold ? { warmFallbackToCold: true } : {}),
      ...(!chatAgentId && !isInternalHelperCall ? { usedDefaultSystemAgent: true } : {}),
    });

    if (turn.signal?.aborted) {
      if (reusedWs) {
        reusedWs.on("error", () => { });
        try {
          reusedWs.close();
        } catch { }
      }
      throw new GatewayError("Request aborted by client.", 499, "client_aborted");
    }

    let chunks: string[];
    let effectiveCustomPrompt: string | null;
    let rawPromptForRephrase: string;
    let rephrasePreservePrefix: string | undefined;
    try {
      const prepared = await finalizePromptChunksAndOutOfBandText({
        turn,
        slotId: lease.slotId,
        threadId,
        isWarmIncremental,
        overridePromptText: turnOpts?.overridePromptText,
        prompt,
        customPrompt,
        attachments,
        isOAuthAccount,
        oauthCred: cred.oauth,
        effectiveProxy,
        reqAttCache,
      });
      chunks = prepared.chunks;
      effectiveCustomPrompt = prepared.effectiveCustomPrompt;
      attachments = prepared.attachments;
      rawPromptForRephrase = prepared.rawPromptForRephrase;
      rephrasePreservePrefix = prepared.rephrasePreservePrefix;
    } catch (chunkErr) {
      if (reusedWs) {
        reusedWs.on("error", () => { });
        try {
          reusedWs.close();
        } catch { }
      }
      throw chunkErr;
    }

    const totalChunks = chunks.length;
    if (totalChunks > 1) {
      console.info(
        JSON.stringify({
          event: "inline_chunked_turn",
          slotId: lease.slotId,
          chunks: totalChunks,
          mode: selection.agentMode,
        }),
      );
    }

    const allowedToolNames = new Set<string>();
    for (const t of turn.tools) {
      if (t.name) allowedToolNames.add(t.name);
      if (t.wireName) allowedToolNames.add(t.wireName);
    }
    const toolFilter = toolBridgePrompt ? new StreamingToolCallFilter(allowedToolNames) : null;
    const uiTagSanitizer = new StreamingUiTagSanitizer();

    let encodeFrame: QuickFrameEncoder = isWeb ? encodeGatewayJsonFrame : encodeCloudInputFrame;
    let decodeFrame: QuickFrameDecoder = isWeb ? decodeGatewayFrame : decodeCloudOutputFrame;
    let surfaceType = isWeb ? "WEB_EXPERIENCE" : SURFACE_TYPE;
    let appVersion = isWeb ? "qbiz-web-bridge" : APP_VERSION;
    let surfaceName: "web" | "desktop" = isWeb ? "web" : "desktop";
    let ws: WebSocket;
    let actorArn: string | undefined;
    let outpostId = editBranch?.outpostId || warmHit?.reusedOutpostId || "web0";

    if (reusedWs && reusedWs.readyState === WebSocket.OPEN) {
      ws = reusedWs;
    } else {
      const ensureHeadroomBeforeDial = async () => {
        if (turn.signal?.aborted) {
          throw new GatewayError("Request aborted before dialing upstream WebSocket.", 499, "client_aborted");
        }
        const activeForSlot = Math.max(
          this.warmPool.getActiveWsCount(lease.slotId),
          keyPool ? keyPool.activeInflightForSlot(lease.slotId) : 0,
        );
        const parkedForSlot = this.warmPool.countParkedWsForSlot(lease.slotId);
        const overflow = activeForSlot + parkedForSlot - 4;
        if (overflow > 0) {
          const evicted = this.warmPool.evictParkedWsForSlot(lease.slotId, overflow);
          if (evicted > 0 && !turn.signal?.aborted) {
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                clearTimeout(t);
                resolve();
              };
              const t = setTimeout(() => {
                turn.signal?.removeEventListener("abort", onAbort);
                resolve();
              }, 150);
              t.unref?.();
              turn.signal?.addEventListener("abort", onAbort, { once: true });
              if (turn.signal?.aborted) onAbort();
            });
          }
        }
        if (turn.signal?.aborted) {
          throw new GatewayError("Request aborted before dialing upstream WebSocket.", 499, "client_aborted");
        }
      };

      const dialed = await dialQuickWebSocket({
        apiKey: lease.apiKey,
        workingSessionId,
        proxyUrl: lease.proxyUrl,
        webSocketFactory: this.webSocketFactory,
        beforeDial: ensureHeadroomBeforeDial,
      });
      ws = dialed.ws;
      encodeFrame = dialed.encodeFrame;
      decodeFrame = dialed.decodeFrame;
      surfaceType = dialed.surfaceType;
      appVersion = dialed.appVersion;
      surfaceName = dialed.surfaceName;
      outpostId = dialed.outpostId;
      actorArn = dialed.actorArn;
    }

    yield* runTurnStream({
      ws,
      isReusedOpenWs: Boolean(reusedWs && ws === reusedWs && ws.readyState === WebSocket.OPEN),
      encodeFrame,
      decodeFrame,
      isWeb,
      oauthClientId: cred.mode === "oauth" ? cred.oauth?.clientId : undefined,
      surfaceType,
      appVersion,
      surfaceName,
      outpostId,
      actorArn,
      turn,
      apiKey: lease.apiKey,
      slotId: lease.slotId,
      proxyUrl: lease.proxyUrl,
      execMode,
      selection,
      chatAgentId,
      isIncognito,
      isWarmIncremental,
      isInternalHelperCall,
      isRephraseRetry: turnOpts?.isRephraseRetry,
      threadId,
      effectiveRootThreadId,
      chunks,
      effectiveCustomPrompt,
      attachments,
      rawPromptForRephrase,
      rephrasePreservePrefix,
      toolFilter,
      uiTagSanitizer,
      editBranch,
      onContentFilterCapture: turnOpts?.onContentFilterCapture,
      runMaxTimeoutMs: this.config.runMaxTimeoutMs,
      runIdleTimeoutMs: this.config.runIdleTimeoutMs,
      showRoutedModelInThinking: this.showRoutedModelInThinking,
      webSearchEnabled: this.webSearchEnabled,
      usageTracker: this.usageTracker,
      warmPool: this.warmPool,
    });
  }

  /**
   * Opt-in defensive prompt rewriter invoked ONLY when upstream returns `content_filtered`
   * and `AUTO_REPHRASE_ON_CONTENT_FILTER=true`.
   */
  private async rephrasePromptForContentFilter(
    rawPrompt: string,
    lease: ReturnType<UpstreamKeyPool["leaseKey"]>,
    settings: ReturnType<UpstreamKeyPool["getSettings"]>,
    parentSignal?: AbortSignal,
    chatAgentId?: string,
  ): Promise<string | undefined> {
    const trimmedInput = rawPrompt.trim();
    if (!trimmedInput || trimmedInput.length > 24_000) return undefined;

    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => ac.abort(), 22_000);
    timeout.unref?.();

    const instruction = (settings.contentFilterRephrasePrompt || DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT).trim();
    const helperModel =
      settings.contentFilterRephraseModel === "quick-balanced"
        ? "quick-balanced"
        : DEFAULT_CONTENT_FILTER_REPHRASE_MODEL;
    const wrappedInput = [
      "Rewrite ONLY the text inside <original_request> according to the system instructions. Do NOT answer the request itself.",
      "",
      "<original_request>",
      trimmedInput,
      "</original_request>",
    ].join("\n");

    try {
      const rephraseTurn: ParsedProtocolTurn = {
        scope: "internal-rephrase",
        requestedModel: helperModel,
        stream: false,
        systemPrompt: instruction,
        fullTranscriptText: wrappedInput,
        images: [],
        tools: [],
        toolChoice: "none",
        trailingToolResults: [],
        estimatedInputTokens: estimatePromptTokens(wrappedInput),
        conversationKey: `rephrase-${crypto.randomUUID()}`,
        rawBody: { __internalRephrase: true },
        signal: ac.signal,
      };
      let out = "";
      const subLease = { ...lease, release: () => { }, markSuccess: () => { } };
      for await (const ev of this.executeTurnWithLease(rephraseTurn, subLease, true, undefined, chatAgentId)) {
        if (ev.type === "text") out += ev.text;
      }
      const cleaned = out
        .trim()
        .replace(/^<original_request>\s*/i, "")
        .replace(/\s*<\/original_request>$/i, "")
        .trim();
      if (!cleaned) return undefined;
      if (isLikelySoftRefusal(cleaned)) return undefined;
      if (cleaned.length > Math.max(4_000, trimmedInput.length * 2.5)) return undefined;
      return cleaned;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }
}
