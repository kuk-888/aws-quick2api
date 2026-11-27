import crypto from "node:crypto";
import WebSocket from "ws";
import {
  decodeCloudOutputFrame,
  decodeGatewayFrame,
  drainEventStream,
  encodeCloudInputFrame,
  encodeGatewayJsonFrame,
} from "../aws-quick/event-stream-cbor.js";
import { cacheOAuthUserIdentity, resolveOAuthAccessToken } from "../aws-quick/oauth-client.js";
import { parseQuickCredential, stopSharedOutpost } from "../aws-quick/outpost-singleton.js";
import type { SDKModel } from "../aws-quick/types.js";
import {
  APP_VERSION,
  createAndPublishCodingAgentForKey as createCodingAgentViaWs,
  DEFAULT_CODING_AGENT_DESCRIPTION,
  DEFAULT_CODING_AGENT_INSTRUCTIONS,
  DEFAULT_CODING_AGENT_NAME,
  deleteCloudSessionsForKey as deleteCloudSessionsViaWs,
  DESKTOP_CAPABILITIES,
  dialQuickWebSocket,
  LEGACY_CODING_AGENT_NAMES,
  listChatAgentsForKey as listChatAgentsViaWs,
  normalizeChatAgentShortId,
  SURFACE_TYPE,
  updateAndPublishAgentForKey as updateAgentViaWs,
  type DialedQuickWs,
  type QuickChatAgentInfo,
  type QuickFrameDecoder,
  type QuickFrameEncoder,
  type QuickWebSocketFactory,
} from "../aws-quick/ws-transport.js";
import { listLiveModels, resolveModelSelection } from "../services/model-catalog.js";
import type { ExecutionModeTag, UsageTracker } from "../services/usage-tracker.js";
import { redactSecrets } from "../utils/hash.js";
import { resolveEffectiveProxyUrl } from "../utils/proxy-agent.js";
import type { UpstreamKeyPool } from "./key-pool.js";
import {
  assertSafeRemoteImageUrl,
  buildOutOfBandContextPrompt,
  buildQuickImageAttachments,
  estimatePromptTokens,
  isPrivateOrReservedIp,
  jsonStringUtf8Bytes,
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
  deepSanitizeClientSystemPrompt,
  sanitizeClientSystemPromptForQuick,
  StreamingToolCallFilter,
  stripHighRiskClientHeaders,
} from "./tool-bridge.js";
import {
  buildPromptAndAttachmentsForTurn,
  finalizePromptChunksAndOutOfBandText,
} from "./turn-attachment-builder.js";
import {
  parseRoutedModelThinkingMode,
  runTurnStream,
  type ContentFilterCaptureContext,
  type RoutedModelThinkingMode,
} from "./turn-stream-runner.js";
import {
  GatewayError,
  parseSanitizeClientSystemPromptMode,
  type GatewayConfig,
  type GatewayStreamEvent,
  type ParsedProtocolTurn,
} from "./types.js";
import { StreamingUiTagSanitizer } from "./ui-tag-sanitizer.js";
import {
  classifyUpstreamError,
  DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
  DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
  extractPreservableEntities,
  isLikelySoftRefusal,
  isPseudo200UsageLimitPrefix,
  isPseudo200UsageLimitText,
  LEGACY_CONTENT_FILTER_REPHRASE_PROMPT,
  mapSdkError,
  SOFT_REFUSAL_PATTERNS,
  splitTrailingUserTurn,
  validateRephrasedPrompt,
} from "./upstream-errors.js";
import { MAX_PARKED_WS_PER_SLOT, WarmSessionPool, type StandbyRemovalReason } from "./warm-session-pool.js";

export type AgentFactory = unknown;

// Re-export extracted helpers & constants so all external imports remain 100% backward-compatible.
export {
  assertSafeRemoteImageUrl,
  buildOutOfBandContextPrompt,
  buildQuickImageAttachments,
  classifyUpstreamError,
  deepSanitizeClientSystemPrompt,
  DEFAULT_CODING_AGENT_DESCRIPTION,
  DEFAULT_CODING_AGENT_INSTRUCTIONS,
  DEFAULT_CODING_AGENT_NAME,
  parseRoutedModelThinkingMode,
  DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
  DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
  estimatePromptTokens,
  extractPreservableEntities,
  isLikelySoftRefusal,
  isPrivateOrReservedIp,
  isPseudo200UsageLimitPrefix,
  isPseudo200UsageLimitText,
  LEGACY_CODING_AGENT_NAMES,
  LEGACY_CONTENT_FILTER_REPHRASE_PROMPT,
  mapAttachmentUploadError,
  mapSdkError,
  MAX_PARKED_WS_PER_SLOT,
  pinnedHttpGet,
  SOFT_REFUSAL_PATTERNS,
  splitPromptIntoSafeChunks,
  splitTrailingUserTurn,
  validateRephrasedPrompt,
  type QuickAttachment,
  type QuickChatAgentInfo,
  type QuickImageAttachment,
};

const STANDBY_MAINTAIN_INTERVAL_MS = 60_000;
const STANDBY_DIAL_FAILURE_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000] as const;

export class QuickExecutionEngine {
  private readonly config: GatewayConfig;
  private readonly usageTracker: UsageTracker;
  private readonly modelListFetcher?: (apiKey: string) => Promise<SDKModel[]>;
  private readonly webSocketFactory?: QuickWebSocketFactory;
  private readonly enableStandbyPrewarmWithFactory: boolean;
  private readonly standbyMaintainIntervalMs: number;
  private readonly standbyReplenishDelayMs?: number;
  private readonly autoEnsureCodingAgent: boolean;
  private readonly showRoutedModelInThinking: RoutedModelThinkingMode;
  private readonly webSearchEnabled: boolean;
  private readonly workingSessionIds = new Map<string, string>();
  private readonly observedModelBySlotMode = new Map<string, string>();
  private readonly observedModelByMode = new Map<string, string>();
  private readonly warmPool: WarmSessionPool;
  private readonly ensuringAgentBySlot = new Map<string, Promise<string | undefined>>();
  private readonly autoEnsureFailedSlots = new Map<string, { failedAt: number; count: number }>();
  private readonly standbyWarmupTimers = new Set<NodeJS.Timeout>();
  private readonly standbyDialFailures = new Map<string, { count: number; retryAfter: number }>();
  private standbyKeyPool?: UpstreamKeyPool;
  private standbyMaintainTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(options: {
    config: GatewayConfig;
    usageTracker: UsageTracker;
    agentFactory?: AgentFactory;
    modelListFetcher?: (apiKey: string) => Promise<SDKModel[]>;
    webSocketFactory?: QuickWebSocketFactory;
    enableStandbyPrewarmWithFactory?: boolean;
    standbyTtlMs?: number;
    standbyMaintainIntervalMs?: number;
    standbyReplenishDelayMs?: number;
  }) {
    this.config = options.config;
    this.usageTracker = options.usageTracker;
    this.modelListFetcher = options.modelListFetcher;
    this.webSocketFactory = options.webSocketFactory;
    this.enableStandbyPrewarmWithFactory = options.enableStandbyPrewarmWithFactory === true;
    this.standbyMaintainIntervalMs =
      options.standbyMaintainIntervalMs && options.standbyMaintainIntervalMs > 0
        ? options.standbyMaintainIntervalMs
        : STANDBY_MAINTAIN_INTERVAL_MS;
    this.standbyReplenishDelayMs = options.standbyReplenishDelayMs;
    this.warmPool = new WarmSessionPool({
      maxWarmSessions: options.config.maxWarmSessions,
      warmSessionTtlMs: options.config.warmSessionTtlMs,
      parkedWsIdleTtlMs: options.config.parkedWsIdleTtlMs,
      standbyTtlMs: options.standbyTtlMs,
      onStandbyRemoved: (slotId, reason) => this.handleStandbyRemoved(slotId, reason),
    });
    this.autoEnsureCodingAgent = process.env.AUTO_ENSURE_CODING_AGENT !== "false";
    this.showRoutedModelInThinking =
      options.config.showRoutedModelInThinking ??
      parseRoutedModelThinkingMode(process.env.SHOW_ROUTED_MODEL_IN_THINKING);
    this.webSearchEnabled = process.env.WEB_SEARCH_ENABLED !== "false";
  }

  /** Records the real upstream `resolved_model_id` observed from `routing_decision` or `turn_usage`. */
  recordObservedModel(slotId: string | undefined, agentMode: string | undefined, modelId: string | undefined): void {
    const mode = typeof agentMode === "string" ? agentMode.trim() : "";
    const model = typeof modelId === "string" ? modelId.trim() : "";
    if (!mode || !model) return;
    this.observedModelByMode.set(mode, model);
    if (typeof slotId === "string" && slotId.trim()) {
      this.observedModelBySlotMode.set(`${slotId.trim()}:${mode}`, model);
    }
  }

  /** Returns the most recently observed real upstream model for `(slotId, agentMode)` or `agentMode`. */
  getObservedModelHint(slotId: string, agentMode: string): string | undefined {
    const mode = (agentMode || "").trim();
    if (!mode) return undefined;
    const bySlot = slotId?.trim() ? this.observedModelBySlotMode.get(`${slotId.trim()}:${mode}`) : undefined;
    return bySlot || this.observedModelByMode.get(mode);
  }

  /** Seeds observed model cache at startup from persisted metadata-only traces (oldest -> newest). */
  seedObservedModels(entries: Array<{ slotId?: string; agentMode?: string; resolvedModel?: string }>): void {
    for (const entry of entries) {
      this.recordObservedModel(entry.slotId, entry.agentMode, entry.resolvedModel);
    }
  }

  runtimeStats() {
    const { warmIncrementalSessions, warmIdleSessions, standbyWs } = this.warmPool.stats();
    return {
      parkedToolSessions: 0,
      warmIncrementalSessions,
      warmIdleSessions,
      standbyWs,
      memoryStore: { blobs: 0, totalBytes: 0 },
    };
  }

  async sweepStaleAssets(): Promise<void> {
    this.warmPool.sweepExpired();
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    if (this.standbyMaintainTimer) {
      clearInterval(this.standbyMaintainTimer);
      this.standbyMaintainTimer = undefined;
    }
    for (const t of this.standbyWarmupTimers) {
      clearTimeout(t);
    }
    this.standbyWarmupTimers.clear();
    this.standbyDialFailures.clear();
    this.standbyKeyPool = undefined;
    this.warmPool.disposeAll();
    stopSharedOutpost();
  }

  /**
   * Immediately invalidates parked WebSockets & warm sessions for `slotId` and bumps its generation
   * so in-flight turns with an outdated `chatAgentId` or instructions never park stale sockets.
   */
  invalidateWarmSessionsForSlot(slotId: string, opts?: { keepStandby?: boolean }): number {
    const invalidated = this.warmPool.invalidateSlot(slotId, opts);
    if (!opts?.keepStandby && this.standbyKeyPool) {
      const slot = this.standbyKeyPool.allManagedKeys().find((k) => k.slotId === slotId);
      if (slot?.enabled) {
        this.scheduleStandbyWarmup(this.standbyKeyPool, slotId, 400, { ignoreBackoff: true });
      }
    }
    return invalidated;
  }

  /** Read-only probe used by `UpstreamKeyPool` for standby-aware tiebreaking on cold turns. */
  hasOpenStandbyForSlot(slotId: string, isIncognito: boolean): boolean {
    return this.warmPool.hasOpenStandby(slotId, isIncognito);
  }

  /**
   * Preserves live parked & standby WebSockets when an OAuth slot's single-use refresh token
   * rotates (same account, new `slotId`).
   */
  rekeyWarmSessionsForSlot(oldSlotId: string, newSlotId: string): void {
    this.warmPool.rekeySlot(oldSlotId, newSlotId);
    const oldWsId = this.workingSessionIds.get(oldSlotId);
    if (oldWsId) {
      this.workingSessionIds.delete(oldSlotId);
      if (!this.workingSessionIds.has(newSlotId)) {
        this.workingSessionIds.set(newSlotId, oldWsId);
      }
    }
    const oldFail = this.standbyDialFailures.get(oldSlotId);
    if (oldFail) {
      this.standbyDialFailures.delete(oldSlotId);
      if (!this.standbyDialFailures.has(newSlotId)) {
        this.standbyDialFailures.set(newSlotId, oldFail);
      }
    }
  }

  /**
   * Immediately invalidates parked WebSockets & warm sessions across all slots
   * (e.g. when global `chatAgentId` or `incognitoMode` changes).
   */
  invalidateWarmSessionsAll(opts?: { keepStandby?: boolean }): number {
    const invalidated = this.warmPool.invalidateAll(opts);
    if (!opts?.keepStandby && this.standbyKeyPool) {
      this.warmStandbyPool(this.standbyKeyPool);
    }
    return invalidated;
  }

  private isStandbyPrewarmEnabled(): boolean {
    if (this.disposed) return false;
    if (this.webSocketFactory && !this.enableStandbyPrewarmWithFactory) return false;
    if (process.env.STANDBY_WS_PREWARM === "false") return false;
    return true;
  }

  private recordStandbyDialFailure(slotId: string): void {
    const prev = this.standbyDialFailures.get(slotId);
    const count = (prev?.count || 0) + 1;
    const backoffMs =
      STANDBY_DIAL_FAILURE_BACKOFF_MS[Math.min(count - 1, STANDBY_DIAL_FAILURE_BACKOFF_MS.length - 1)]!;
    this.standbyDialFailures.set(slotId, { count, retryAfter: Date.now() + backoffMs });
  }

  private handleStandbyRemoved(slotId: string, reason: StandbyRemovalReason): void {
    if (!this.standbyKeyPool || !this.isStandbyPrewarmEnabled()) return;
    if (reason === "expired") {
      // Smooth jittered rotation so idle slots stay permanently warm without thundering herds.
      const delayMs =
        this.standbyReplenishDelayMs !== undefined
          ? this.standbyReplenishDelayMs
          : 500 + Math.floor(Math.random() * 1_500);
      this.scheduleStandbyWarmup(this.standbyKeyPool, slotId, delayMs);
      return;
    }
    // Unexpected drop (remote close / error / pong timeout / token refresh failure):
    // apply failure backoff on non-clean drops and wait a short cooldown before redialing.
    if (reason === "error" || reason === "pong_timeout" || reason === "token_refresh_failed") {
      this.recordStandbyDialFailure(slotId);
    }
    const failRec = this.standbyDialFailures.get(slotId);
    const backoffDelay = failRec ? Math.max(0, failRec.retryAfter - Date.now()) : 0;
    const baseDelay =
      this.standbyReplenishDelayMs !== undefined
        ? this.standbyReplenishDelayMs
        : 15_000 + Math.floor(Math.random() * 5_000);
    this.scheduleStandbyWarmup(this.standbyKeyPool, slotId, Math.max(baseDelay, backoffDelay));
  }

  /**
   * Starts a lightweight periodic safety-net loop that sweeps expired sessions and gently
   * replenishes standby WebSockets for healthy enabled OAuth slots (e.g. after transient bursts,
   * cooldown recovery, global setting toggles, or newly enabled accounts).
   */
  startStandbyMaintenance(keyPool: UpstreamKeyPool): void {
    if (!this.isStandbyPrewarmEnabled()) return;
    this.standbyKeyPool = keyPool;
    if (this.standbyMaintainTimer) return;
    this.standbyMaintainTimer = setInterval(() => {
      if (!this.isStandbyPrewarmEnabled() || !this.standbyKeyPool) return;
      this.warmPool.sweepExpired();
      this.warmStandbyPool(this.standbyKeyPool);
    }, this.standbyMaintainIntervalMs);
    this.standbyMaintainTimer.unref?.();
  }

  /**
   * Schedules a non-blocking background pre-warm of 1 standby `session_established` WebSocket
   * for `slotId` (and caches its OAuth access token). Safe under AWS's 5-WS/account cap because
   * it skips whenever `active + parked > 3` and standby sockets are evicted first under load.
   */
  scheduleStandbyWarmup(
    keyPool: UpstreamKeyPool | undefined,
    slotId: string,
    delayMs = 300,
    opts?: { ignoreBackoff?: boolean },
  ): void {
    if (!keyPool || !slotId || !this.isStandbyPrewarmEnabled()) return;
    this.standbyKeyPool = keyPool;
    if (opts?.ignoreBackoff) {
      this.standbyDialFailures.delete(slotId);
    } else {
      const failRec = this.standbyDialFailures.get(slotId);
      if (failRec && Date.now() < failRec.retryAfter) return;
    }
    const isIncognito = keyPool.getSettings().incognitoMode;
    if (this.warmPool.hasLivePrimaryOrStandby(slotId, isIncognito)) return;
    if (!this.warmPool.tryClaimStandbyDial(slotId)) return;

    const timer = setTimeout(() => {
      this.standbyWarmupTimers.delete(timer);
      void this.warmStandbyForSlot(keyPool, slotId).finally(() => {
        this.warmPool.releaseStandbyDial(slotId);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.standbyWarmupTimers.add(timer);
  }

  /**
   * Staggered startup & maintenance pre-warm for enabled healthy OAuth slots (capped at 16 sockets globally).
   */
  warmStandbyPool(keyPool: UpstreamKeyPool): void {
    if (!this.isStandbyPrewarmEnabled()) return;
    this.standbyKeyPool = keyPool;
    const isIncognito = keyPool.getSettings().incognitoMode;
    const snapshots = keyPool.statusSnapshot();
    const activeSlotIds = new Set(snapshots.map((s) => s.slotId));
    for (const staleSid of this.standbyDialFailures.keys()) {
      if (!activeSlotIds.has(staleSid)) this.standbyDialFailures.delete(staleSid);
    }
    let eligibleCount = 0;
    let scheduledIdx = 0;
    for (const snap of snapshots) {
      if (eligibleCount >= 16) break;
      if (!snap.enabled || snap.authType !== "oauth") continue;
      if (snap.cooldownRemainingMs > 0 || snap.apiPoolExhausted || snap.autoPoolExhausted) continue;
      eligibleCount += 1;
      if (this.warmPool.hasLivePrimaryOrStandby(snap.slotId, isIncognito)) continue;
      const failRec = this.standbyDialFailures.get(snap.slotId);
      if (failRec && Date.now() < failRec.retryAfter) continue;
      const staggerMs =
        this.standbyReplenishDelayMs !== undefined ? this.standbyReplenishDelayMs * scheduledIdx : 250 * scheduledIdx;
      this.scheduleStandbyWarmup(keyPool, snap.slotId, staggerMs);
      scheduledIdx += 1;
    }
  }

  private async warmStandbyForSlot(keyPool: UpstreamKeyPool, slotId: string): Promise<void> {
    if (!this.isStandbyPrewarmEnabled()) return;
    const snap = keyPool.statusSnapshot().find((s) => s.slotId === slotId);
    if (!snap || !snap.enabled || snap.authType !== "oauth") return;
    if (snap.cooldownRemainingMs > 0 || snap.apiPoolExhausted || snap.autoPoolExhausted) return;
    const managed = keyPool.allManagedKeys().find((k) => k.slotId === slotId && k.enabled);
    if (!managed) return;
    const parsed = parseQuickCredential(managed.rawKey);
    if (parsed.mode !== "oauth" || !parsed.oauth) return;

    const isIncognito = keyPool.getSettings().incognitoMode;
    if (this.warmPool.hasLivePrimaryOrStandby(slotId, isIncognito)) return;
    const activeForSlot = Math.max(
      this.warmPool.getActiveWsCount(slotId),
      keyPool.activeInflightForSlot(slotId),
    );
    if (activeForSlot + this.warmPool.countIdleWsForSlot(slotId) > 3) return;

    const expectedGeneration = this.warmPool.getSlotGeneration(slotId);
    let workingSessionId = this.workingSessionIds.get(slotId);
    if (!workingSessionId) {
      workingSessionId = crypto.randomUUID();
      this.workingSessionIds.set(slotId, workingSessionId);
    }

    let dialed: DialedQuickWs | undefined;
    let cancelled = false;
    let cancelHandshake: (() => void) | null = null;
    this.warmPool.registerStandbyCancel(slotId, () => {
      cancelled = true;
      cancelHandshake?.();
      if (dialed) {
        dialed.ws.on("error", () => { });
        try { dialed.ws.close(); } catch { }
      }
    });
    try {
      dialed = await dialQuickWebSocket({
        apiKey: managed.rawKey,
        workingSessionId,
        proxyUrl: managed.proxyUrl,
        webSocketFactory: this.webSocketFactory,
      });
      if (this.disposed || cancelled) {
        dialed.ws.on("error", () => { });
        try { dialed.ws.close(); } catch { }
        return;
      }

      const established = await new Promise<boolean>((resolve) => {
        let settled = false;
        let recvBuf = Buffer.alloc(0);
        const ws = dialed!.ws;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          cancelHandshake = null;
          clearTimeout(handshakeTimeout);
          ws.off("open", onOpen);
          ws.off("message", onMessage);
          ws.off("error", onDead);
          ws.off("close", onDead);
          resolve(ok);
        };
        cancelHandshake = () => finish(false);
        const onDead = () => finish(false);
        const onOpen = () => {
          if (settled || this.disposed || ws.readyState !== WebSocket.OPEN) {
            finish(false);
            return;
          }
          try {
            ws.send(
              dialed!.encodeFrame({
                type: "session_connect",
                payload: {
                  ...(dialed!.actorArn ? { actor_id: dialed!.actorArn } : {}),
                  surfaceType: dialed!.surfaceType,
                  outpostId: dialed!.outpostId,
                  appVersion: dialed!.appVersion,
                  ...DESKTOP_CAPABILITIES,
                  ...(isIncognito ? { incognito: true } : {}),
                },
              }),
            );
            if (!dialed!.isWeb) {
              ws.send(dialed!.encodeFrame({ type: "federate_status", payload: {} }));
            }
          } catch {
            finish(false);
          }
        };
        const onMessage = (data: Buffer) => {
          if (settled) return;
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          try {
            recvBuf = Buffer.concat([recvBuf, chunk]);
            const drained = drainEventStream(recvBuf, 0);
            if (drained.consumed > 0) recvBuf = recvBuf.subarray(drained.consumed);
            for (const esMsg of drained.messages) {
              const dec = dialed!.decodeFrame(esMsg);
              if (dec?.type === "error") {
                finish(false);
                return;
              }
              if (dec?.type === "event" && dec.data && typeof dec.data === "object") {
                const evObj = dec.data as { type?: unknown; payload?: Record<string, unknown> };
                const evT = String(evObj.type || "");
                if (evT === "connected" && parsed.oauth?.clientId) {
                  const u = evObj.payload?.user as Record<string, unknown> | undefined;
                  if (u && typeof u === "object") {
                    cacheOAuthUserIdentity(parsed.oauth.clientId, {
                      ...(typeof u.email === "string" ? { email: u.email } : {}),
                      ...(typeof u.name === "string" ? { name: u.name } : {}),
                      ...(typeof u.aws_account_id === "string" ? { accountId: u.aws_account_id } : {}),
                    });
                  }
                }
                if (evT === "session_established" || evT === "connected") {
                  finish(true);
                  return;
                }
              }
            }
          } catch {
            finish(false);
          }
        };
        const handshakeTimeout = setTimeout(() => finish(false), 8_000);
        handshakeTimeout.unref?.();
        ws.on("error", onDead);
        ws.on("close", onDead);
        ws.on("message", onMessage);
        if (ws.readyState === WebSocket.OPEN) onOpen();
        else ws.once("open", onOpen);
      });

      if (!established || this.disposed || cancelled || dialed.ws.readyState !== WebSocket.OPEN) {
        if (!this.disposed && !cancelled) this.recordStandbyDialFailure(slotId);
        dialed.ws.on("error", () => { });
        try { dialed.ws.close(); } catch { }
        return;
      }

      // Resolve live slotId/rawKey in case OAuth refresh token rotated during `dialQuickWebSocket`.
      const liveSlot =
        keyPool.allManagedKeys().find((k) => k.slotId === slotId && k.enabled) ||
        keyPool.allManagedKeys().find((k) => {
          if (!k.enabled) return false;
          const p = parseQuickCredential(k.rawKey);
          return p.mode === "oauth" && p.oauth?.clientId === parsed.oauth?.clientId;
        });
      if (!liveSlot) {
        dialed.ws.on("error", () => { });
        try { dialed.ws.close(); } catch { }
        return;
      }

      const stored = this.warmPool.storeStandby({
        slotId: liveSlot.slotId,
        isIncognito,
        expectedGeneration,
        activeInflightOverride: keyPool.activeInflightForSlot(liveSlot.slotId),
        handle: {
          ws: dialed.ws,
          outpostId: dialed.outpostId,
          encodeFrame: dialed.encodeFrame,
          decodeFrame: dialed.decodeFrame,
          surfaceType: dialed.surfaceType,
          appVersion: dialed.appVersion,
          surfaceName: dialed.surfaceName,
          actorArn: dialed.actorArn,
        },
        apiKey: liveSlot.rawKey,
        proxyUrl: liveSlot.proxyUrl,
      });
      if (stored) {
        this.standbyDialFailures.delete(slotId);
        this.standbyDialFailures.delete(liveSlot.slotId);
      } else {
        dialed.ws.on("error", () => { });
        try { dialed.ws.close(); } catch { }
      }
    } catch {
      if (!this.disposed) this.recordStandbyDialFailure(slotId);
      if (dialed) {
        dialed.ws.on("error", () => { });
        try { dialed.ws.close(); } catch { }
      }
    }
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
          const preferred = customAgents.find((a) => knownNames.has(a.name.trim().toLowerCase()));
          if (preferred) {
            const chosenId = normalizeChatAgentShortId(preferred.shortId || preferred.agentId);
            const prevBound = normalizeChatAgentShortId(
              keyPool.allManagedKeys().find((k) => k.slotId === slotId)?.chatAgentId || "",
            );
            keyPool.updateSlotMeta(slotId, { chatAgentId: chosenId });
            if (chosenId !== prevBound) this.warmPool.invalidateSlot(slotId, { keepStandby: true });
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
        const createdId = normalizeChatAgentShortId(created.agentId);
        keyPool.updateSlotMeta(slotId, { chatAgentId: createdId });
        this.warmPool.invalidateSlot(slotId, { keepStandby: true });
        this.autoEnsureFailedSlots.delete(slotId);
        return createdId;
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

  /**
   * Batch/one-click cloud agent sync for an account:
   * - `mode: "create"` (default): creates and publishes a brand-new cloud agent with the requested
   *   `name`, `description`, and `instructions` without touching any existing cloud agents;
   * - `mode: "upgrade"`: upgrades an existing agent matching `name` (or legacy `Quick2API Bridge`
   *   when targeting default `Coding Assistant`) in-place, or creates a new one if none matches;
   * - When `setAsDefault !== false` (default `true`), binds the resulting `agentId` to `slotId`
   *   and immediately invalidates warm sessions / parked WebSockets for `slotId` so active
   *   conversations hot-switch cleanly to the new agent on the very next turn.
   */
  async syncCodingAgentForKey(
    apiKey: string,
    slotId: string,
    keyPool: UpstreamKeyPool,
    proxyUrl?: string,
    opts?: {
      mode?: "create" | "upgrade";
      name?: string;
      description?: string;
      instructions?: string;
      setAsDefault?: boolean;
    },
  ): Promise<{
    agentId: string;
    name: string;
    action: "upgraded" | "created" | "unchanged";
    boundAsDefault: boolean;
    previousName?: string;
  }> {
    const mode = opts?.mode === "upgrade" ? "upgrade" : "create";
    const setAsDefault = opts?.setAsDefault !== false;
    const targetName = (opts?.name || "").trim() || DEFAULT_CODING_AGENT_NAME;
    const targetDesc =
      typeof opts?.description === "string" && opts.description.trim()
        ? opts.description.trim()
        : DEFAULT_CODING_AGENT_DESCRIPTION;
    const targetInstructions =
      (opts?.instructions || "").trim() ||
      (keyPool.getSettings().customAgentPrompt || DEFAULT_CODING_AGENT_INSTRUCTIONS).trim();

    if (targetName.length > 120) {
      throw new GatewayError("Agent `name` must be 120 characters or fewer.", 400, "invalid_request_error");
    }
    if (targetDesc.length > 500) {
      throw new GatewayError("Agent `description` must be 500 characters or fewer.", 400, "invalid_request_error");
    }
    if (targetInstructions.length > 16_000) {
      throw new GatewayError("Agent `instructions` must be 16,000 characters or fewer.", 400, "invalid_request_error");
    }

    const currentBoundId = normalizeChatAgentShortId(
      keyPool.allManagedKeys().find((k) => k.slotId === slotId)?.chatAgentId || "",
    );

    if (mode === "upgrade") {
      const agents = await this.listChatAgentsForKey(apiKey, proxyUrl);
      const customAgents = agents.filter((a) => !a.isSystem);
      const targetNameLow = targetName.toLowerCase();
      const matchNames = new Set<string>([targetNameLow]);
      if (targetNameLow === DEFAULT_CODING_AGENT_NAME.toLowerCase()) {
        for (const n of LEGACY_CODING_AGENT_NAMES) matchNames.add(n.toLowerCase());
      }

      const boundMatch = currentBoundId
        ? customAgents.find(
          (a) =>
            (normalizeChatAgentShortId(a.shortId || a.agentId) === currentBoundId ||
              a.agentId === currentBoundId) &&
            matchNames.has(a.name.trim().toLowerCase()),
        )
        : undefined;
      const candidate =
        boundMatch || customAgents.find((a) => matchNames.has(a.name.trim().toLowerCase()));

      if (candidate) {
        const chosenId = normalizeChatAgentShortId(candidate.shortId || candidate.agentId);
        const isUpToDate =
          candidate.name.trim() === targetName &&
          candidate.description.trim() === targetDesc &&
          candidate.systemPrompt.trim() === targetInstructions;
        if (!isUpToDate) {
          await this.updateAndPublishAgentForKey(
            apiKey,
            chosenId,
            {
              name: targetName,
              description: targetDesc,
              instructions: targetInstructions,
            },
            proxyUrl,
          );
        }
        if (setAsDefault) {
          keyPool.updateSlotMeta(slotId, { chatAgentId: chosenId });
          this.autoEnsureFailedSlots.delete(slotId);
        }
        // Invalidate warm sessions whenever cloud instructions/name changed OR the active binding changed.
        // Keep healthy open standby sockets intact (`session_connect` does not bind `chat_agent_id`).
        if (!isUpToDate || (setAsDefault && chosenId !== currentBoundId)) {
          this.warmPool.invalidateSlot(slotId, { keepStandby: true });
          if (!this.warmPool.hasOpenStandby(slotId, keyPool.getSettings().incognitoMode)) {
            this.scheduleStandbyWarmup(keyPool, slotId, 300, { ignoreBackoff: true });
          }
        }
        return {
          agentId: chosenId,
          name: targetName,
          action: isUpToDate ? "unchanged" : "upgraded",
          boundAsDefault: setAsDefault,
          ...(candidate.name.trim() !== targetName ? { previousName: candidate.name.trim() } : {}),
        };
      }
    }

    const created = await this.createAndPublishCodingAgentForKey(
      apiKey,
      {
        name: targetName,
        description: targetDesc,
        instructions: targetInstructions,
      },
      proxyUrl,
    );
    const createdId = normalizeChatAgentShortId(created.agentId);
    if (setAsDefault) {
      keyPool.updateSlotMeta(slotId, { chatAgentId: createdId });
      this.warmPool.invalidateSlot(slotId, { keepStandby: true });
      if (!this.warmPool.hasOpenStandby(slotId, keyPool.getSettings().incognitoMode)) {
        this.scheduleStandbyWarmup(keyPool, slotId, 300, { ignoreBackoff: true });
      }
      this.autoEnsureFailedSlots.delete(slotId);
    }
    return {
      agentId: createdId,
      name: targetName,
      action: "created",
      boundAsDefault: setAsDefault,
    };
  }

  async *executeTurnWithPool(
    turn: ParsedProtocolTurn,
    keyPool: UpstreamKeyPool,
    onExecMeta?: (meta: {
      slotId?: string;
      maskedKey: string;
      accountLabel?: string;
      accountGroup?: string;
      execMode: ExecutionModeTag;
      usedProxy?: boolean;
      contentFilterRecovered?: boolean;
      warmFallbackToCold?: boolean;
      accountFailoverCount?: number;
      usedDefaultSystemAgent?: boolean;
      agentMode?: string;
      thinkingEffort?: string;
      resolvedModel?: string;
      effectiveSystemPromptChars?: number;
      /**
       * Controls the SSE `flushEarly` 15s keepalive timer:
       * - `false`: disarm/cancel timer while uploading OOB attachments, dialing WS, or failing over;
       * - `true` (or omitted): arm/reset fresh 15s timer once upstream stream dispatch begins.
       */
      flushEarlyReady?: boolean;
    }) => void,
    poolOpts?: { accountGroup?: string | null },
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
    for (const img of currentTurnImages) {
      if ("url" in img && img.url && !img.url.startsWith("data:")) {
        checkedRemoteUrls.add(img.url);
      }
    }
    for (const f of currentTurnFiles) {
      if (f.url && !f.url.startsWith("data:")) {
        checkedRemoteUrls.add(f.url);
      }
    }
    if (checkedRemoteUrls.size > 0) {
      await Promise.all([...checkedRemoteUrls].map((u) => assertSafeRemoteImageUrl(u)));
    }

    const excluded = new Set<string>();
    const retriedAuthRefreshSlots = new Set<string>();
    const attachmentCache = new RequestAttachmentCache();
    let requiredAccountGroup = poolOpts?.accountGroup?.trim() || undefined;
    const unsubscribeGroupRename = requiredAccountGroup
      ? keyPool.subscribeGroupRename((oldName, newName) => {
        if (requiredAccountGroup === oldName) requiredAccountGroup = newName;
      })
      : undefined;
    const maxAttempts = Math.min(Math.max(1, keyPool.enabledKeyCount(requiredAccountGroup)), 10);
    let remainingWaitBudgetMs = 18_000;
    let retriedSameSlotConnLimit = false;
    let retriedTransientSameSlot = false;

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const waitStartedAt = Date.now();
        const lease = await keyPool.leaseKeyWithWait(
          turn.requestedModel,
          excluded.size > 0 ? excluded : undefined,
          turn.conversationKey,
          {
            signal: turn.signal,
            maxWaitMs: Math.max(0, Math.min(15_000, remainingWaitBudgetMs)),
            ...(requiredAccountGroup ? { accountGroup: requiredAccountGroup } : {}),
          },
        );
        remainingWaitBudgetMs = Math.max(0, remainingWaitBudgetMs - (Date.now() - waitStartedAt));
        // Capture warm-session generation BEFORE reading chatAgentId / awaiting async ops so any
        // concurrent hot-switch during ensure/resolveModel/rephrase prevents stale WS parking.
        let expectedWarmGeneration = this.warmPool.getSlotGeneration(lease.slotId);
        const poolSettings = keyPool.getSettings();
        const isIncognito = poolSettings.incognitoMode;
        const shouldAutoEnsure =
          poolSettings.autoEnsureCodingAgent !== undefined
            ? poolSettings.autoEnsureCodingAgent
            : this.autoEnsureCodingAgent;
        let effectiveChatAgentId =
          normalizeChatAgentShortId(lease.chatAgentId || poolSettings.chatAgentId || "") || undefined;
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
              if (effectiveChatAgentId) {
                effectiveChatAgentId = normalizeChatAgentShortId(effectiveChatAgentId) || undefined;
                const liveSlot = keyPool.statusSnapshot().find((s) => s.slotId === lease.slotId);
                const liveAgentId = normalizeChatAgentShortId(liveSlot?.chatAgentId || "") || undefined;
                const liveProxy = keyPool.proxyUrlForKey(lease.apiKey) || "";
                if (
                  liveSlot &&
                  liveSlot.enabled &&
                  (!requiredAccountGroup || liveSlot.group === requiredAccountGroup) &&
                  (!liveAgentId || liveAgentId === effectiveChatAgentId) &&
                  liveProxy === (lease.proxyUrl || "")
                ) {
                  expectedWarmGeneration = this.warmPool.getSlotGeneration(lease.slotId);
                }
              }
            }
          }
          if (turn.signal?.aborted) {
            throw new GatewayError("Request aborted before starting upstream turn.", 499, "client_aborted");
          }
          const initialLeaseOpts = {
            attachmentCache,
            expectedWarmGeneration,
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
            if (
              ev.type === "text" ||
              ev.type === "tool_calls" ||
              ev.type === "tool_call_start" ||
              ev.type === "tool_call_delta" ||
              ev.type === "tool_call_end"
            ) {
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
          if (!isInternalCall) {
            this.scheduleStandbyWarmup(keyPool, lease.slotId, 300, { ignoreBackoff: true });
          }
          return;
        } catch (err) {
          // Immediately disarm any armed 15s `flushEarly` timer before rephrase/warm-fallback/failover
          // so slow retries or next-account OOB errors never prematurely commit HTTP 200 keepalive.
          wrappedMeta({
            slotId: lease.slotId,
            maskedKey: lease.maskedKey,
            accountLabel: lease.label,
            execMode: lastExecMode || (isIncognito ? "incognito" : "cloud"),
            flushEarlyReady: false,
          });
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
                    handoffErrListener: undefined as (() => void) | undefined,
                  }
                  : undefined;
              if (editBranch && capturedFilterCtx) {
                const keepSafeErr = () => { };
                editBranch.ws.on("error", keepSafeErr);
                editBranch.handoffErrListener = keepSafeErr;
                if (capturedFilterCtx.onIdleErr) {
                  editBranch.ws.off("error", capturedFilterCtx.onIdleErr);
                  capturedFilterCtx.onIdleErr = undefined;
                }
                capturedFilterCtx.ws = undefined;
              } else {
                closeCapturedFilterWs();
              }
              try {
                if (!turn.stream && (hasEmittedClientText || hasEmittedThinking)) {
                  yield { type: "reset" };
                  yieldedOutput = false;
                  hasEmittedClientText = false;
                  hasEmittedThinking = false;
                } else if (turn.stream && hasEmittedThinking) {
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
                    expectedWarmGeneration,
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
                if (!isInternalCall) {
                  this.scheduleStandbyWarmup(keyPool, lease.slotId, 300, { ignoreBackoff: true });
                }
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
          // Never double-hang on 504 timeouts (already waited full timeout budget).
          if (
            lastExecMode === "warm_incremental" &&
            !yieldedOutput &&
            !turn.signal?.aborted &&
            gwErr.status !== 504 &&
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
                { attachmentCache, expectedWarmGeneration, warmFallbackToCold: true, forceColdReplay: true },
              )) {
                if (
                  ev.type === "text" ||
                  ev.type === "thinking" ||
                  ev.type === "tool_calls" ||
                  ev.type === "tool_call_start" ||
                  ev.type === "tool_call_delta" ||
                  ev.type === "tool_call_end"
                ) {
                  yieldedOutput = true;
                }
                yield ev;
              }
              lease.markSuccess();
              if (!isInternalCall) {
                this.scheduleStandbyWarmup(keyPool, lease.slotId, 300, { ignoreBackoff: true });
              }
              return;
            } catch (fallbackErr) {
              err = fallbackErr;
            }
          }
          let finalErr = mapSdkError(err);
          let msg = finalErr.message || "";
          let {
            isConnLimitErr,
            isPayloadOrContextSizeErr,
            isSessionLifecycleErr,
            isQuotaErr,
            isRateLimitErr,
            isAuthErr,
            isProxyOrConnErr,
          } = classifyUpstreamError(finalErr);

          // Oversized payloads/contexts are client-side 400s: fail fast without burning the account pool.
          if (isPayloadOrContextSizeErr && !yieldedOutput) {
            throw new GatewayError(finalErr.message, 400, "invalid_request_error");
          }

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
                ({
                  isConnLimitErr,
                  isPayloadOrContextSizeErr,
                  isSessionLifecycleErr,
                  isQuotaErr,
                  isRateLimitErr,
                  isAuthErr,
                  isProxyOrConnErr,
                } = classifyUpstreamError(finalErr));
              }
            }
          }

          const evictedParked = isConnLimitErr
            ? this.warmPool.evictParkedWsForSlot(lease.slotId, Number.POSITIVE_INFINITY)
            : 0;

          // Retry once on the same slot after evicting idle/standby WS (or waiting ~450ms for AWS's
          // backend to finish reaping a recently closed WS even when no local parked WS existed).
          if (
            isConnLimitErr &&
            !retriedSameSlotConnLimit &&
            !yieldedOutput &&
            !turn.signal?.aborted
          ) {
            retriedSameSlotConnLimit = true;
            const waitMs = evictedParked > 0 ? 250 : 450 + Math.floor(Math.random() * 200);
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                clearTimeout(t);
                resolve();
              };
              const t = setTimeout(() => {
                turn.signal?.removeEventListener("abort", onAbort);
                resolve();
              }, waitMs);
              turn.signal?.addEventListener("abort", onAbort, { once: true });
            });
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
            // Evict ONLY this failed conversation's sticky binding (leaving all other healthy
            // conversations on this account untouched) so retries never stay stuck on a busy/broken slot.
            if (turn.conversationKey) {
              keyPool.affinityTable.evictConversation(turn.conversationKey);
            }
          } else if (isAuthErr) {
            keyPool.reportAuthFailure(lease.apiKey, msg);
          }

          const isModelNotAvailable = finalErr.code === "model_not_available";
          const canFailover =
            (!yieldedOutput || !turn.stream) &&
            !turn.signal?.aborted &&
            finalErr.status !== 504 &&
            (isQuotaErr ||
              isConnLimitErr ||
              isRateLimitErr ||
              isAuthErr ||
              isProxyOrConnErr ||
              isSessionLifecycleErr ||
              isModelNotAvailable) &&
            attempt + 1 < maxAttempts;

          if (canFailover) {
            excluded.add(lease.apiKey);
            const hasUntriedEnabledKey = keyPool
              .allManagedKeys()
              .some(
                (k) =>
                  k.enabled &&
                  (!requiredAccountGroup || k.group === requiredAccountGroup) &&
                  !excluded.has(k.rawKey),
              );
            if (hasUntriedEnabledKey) {
              if (yieldedOutput && !turn.stream) {
                yield { type: "reset" };
              }
              continue;
            }
          }

          // Single-account / exhausted-pool self-healing: retry transient socket/proxy/session hiccups
          // once on the same slot with a short jittered backoff before surfacing 502 to the caller.
          if (
            !retriedTransientSameSlot &&
            (!yieldedOutput || !turn.stream) &&
            !turn.signal?.aborted &&
            finalErr.status !== 504 &&
            (isProxyOrConnErr || isSessionLifecycleErr)
          ) {
            retriedTransientSameSlot = true;
            excluded.delete(lease.apiKey);
            const waitMs = 400 + Math.floor(Math.random() * 250);
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                clearTimeout(t);
                resolve();
              };
              const t = setTimeout(() => {
                turn.signal?.removeEventListener("abort", onAbort);
                resolve();
              }, waitMs);
              turn.signal?.addEventListener("abort", onAbort, { once: true });
            });
            if (!turn.signal?.aborted) {
              if (yieldedOutput && !turn.stream) {
                yield { type: "reset" };
              }
              attempt -= 1;
              continue;
            }
          }

          // Never leak internal HTTP 402 (unretriable by Anthropic/OpenAI SDKs), upstream 401/403
          // (which tricks clients into thinking their own gateway API key is invalid), or raw 502
          // for rate-limit/connection-limit/quota rejections to callers.
          if (finalErr.status === 402 && finalErr.code === "quota_exhausted") {
            throw new GatewayError(finalErr.message, 429, "rate_limit_exceeded", undefined, 30);
          }
          if ((isConnLimitErr || isRateLimitErr || isQuotaErr) && finalErr.status !== 429) {
            throw new GatewayError(
              finalErr.message,
              429,
              "rate_limit_exceeded",
              undefined,
              isQuotaErr ? 30 : 5,
            );
          }
          if ((finalErr.status === 401 || finalErr.status === 403) && finalErr.code === "upstream_auth_error") {
            throw new GatewayError(finalErr.message, 502, "upstream_auth_error");
          }
          throw finalErr;
        } finally {
          closeCapturedFilterWs();
          lease.release();
        }
      }
    } finally {
      unsubscribeGroupRename?.();
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
      accountGroup?: string;
      execMode: ExecutionModeTag;
      usedProxy?: boolean;
      contentFilterRecovered?: boolean;
      warmFallbackToCold?: boolean;
      accountFailoverCount?: number;
      usedDefaultSystemAgent?: boolean;
      agentMode?: string;
      thinkingEffort?: string;
      resolvedModel?: string;
      effectiveSystemPromptChars?: number;
      /**
       * Controls the SSE `flushEarly` 15s keepalive timer:
       * - `false`: disarm/cancel timer while uploading OOB attachments, dialing WS, or failing over;
       * - `true` (or omitted): arm/reset fresh 15s timer once upstream stream dispatch begins.
       */
      flushEarlyReady?: boolean;
    }) => void,
    chatAgentId?: string,
    keyPool?: UpstreamKeyPool,
    turnOpts?: {
      attachmentCache?: RequestAttachmentCache;
      expectedWarmGeneration?: number;
      overridePromptText?: string;
      forceColdReplay?: boolean;
      isRephraseRetry?: boolean;
      warmFallbackToCold?: boolean;
      editBranch?: {
        ws?: WebSocket;
        outpostId: string;
        originalMessageId: string;
        rootSessionId: string;
        threadId: string;
        handoffErrListener?: () => void;
      };
      onContentFilterCapture?: (ctx: ContentFilterCaptureContext) => void;
    },
  ): AsyncGenerator<GatewayStreamEvent, void, unknown> {
    const normalizedChatAgentId = chatAgentId ? normalizeChatAgentShortId(chatAgentId) || undefined : undefined;
    const warmGeneration =
      turnOpts?.expectedWarmGeneration ?? this.warmPool.getSlotGeneration(lease.slotId);
    const { selection } = await this.resolveModel(lease.apiKey, turn.requestedModel, turn.rawBody);

    const hasCustomAgent = Boolean(normalizedChatAgentId);
    const toolBridgePrompt = buildToolBridgePrompt(turn.tools, turn.toolChoice, {
      compactForCustomAgent: hasCustomAgent,
      preferClientToolsOverWorkspace: true,
    });
    const sanitizeMode = parseSanitizeClientSystemPromptMode(
      keyPool ? keyPool.getSettings().sanitizeClientSystemPrompt : this.config.sanitizeClientSystemPrompt,
    );
    const customPromptParts: string[] = [];
    let effectiveSystemPromptChars = 0;
    if (sanitizeMode === "strip") {
      // Strip mode: drop client-supplied systemPrompt completely, preserving ONLY gateway-bridged JSON constraints + tool schemas.
      if (turn.structuredOutputPrompt?.trim()) {
        const jsonRule = turn.structuredOutputPrompt.trim();
        effectiveSystemPromptChars = jsonRule.length;
        customPromptParts.push(jsonRule);
      }
    } else if (turn.systemPrompt?.trim()) {
      const rawSys = turn.systemPrompt.trim();
      const deepSanitizeEnabled = sanitizeMode === "true" || Boolean(turnOpts?.isRephraseRetry);
      const sysText = deepSanitizeEnabled
        ? deepSanitizeClientSystemPrompt(rawSys)
        : toolBridgePrompt
          ? sanitizeClientSystemPromptForQuick(stripHighRiskClientHeaders(rawSys), true)
          : stripHighRiskClientHeaders(rawSys);
      if (sysText) {
        effectiveSystemPromptChars = sysText.length;
        customPromptParts.push(sysText);
      }
    }
    if (toolBridgePrompt) customPromptParts.push(toolBridgePrompt);
    const customPrompt = customPromptParts.length > 0 ? customPromptParts.join("\n\n") : null;

    let activeEditBranch = turnOpts?.editBranch;
    const warmHit =
      !activeEditBranch &&
        !turnOpts?.forceColdReplay &&
        turn.priorPrefixHash &&
        turn.incrementalUserText !== undefined
        ? this.warmPool.lookup(
          turn.scope,
          turn.conversationKey,
          lease.slotId,
          isIncognito,
          turn.priorPrefixHash,
          normalizedChatAgentId,
        )
        : undefined;
    if (!activeEditBranch && warmHit?.editOriginalMessageId) {
      activeEditBranch = {
        ...(warmHit.reusedWs ? { ws: warmHit.reusedWs } : {}),
        outpostId: warmHit.reusedOutpostId || "web0",
        originalMessageId: warmHit.editOriginalMessageId,
        rootSessionId: warmHit.rootThreadId,
        threadId: warmHit.threadId,
      };
    }
    let warmThreadId = activeEditBranch ? activeEditBranch.threadId : warmHit?.threadId;
    const rootThreadId = activeEditBranch ? activeEditBranch.rootSessionId : warmHit?.rootThreadId;
    let reusedWs = activeEditBranch ? activeEditBranch.ws : warmHit?.reusedWs;
    let isWarmIncremental = Boolean(activeEditBranch || warmThreadId);

    let tempReusedDead = false;
    let reusedWsTrackedActive = false;
    const onTempReusedDead = () => {
      tempReusedDead = true;
    };
    if (reusedWs) {
      this.warmPool.trackActiveWsStart(lease.slotId);
      reusedWsTrackedActive = true;
      reusedWs.on("error", onTempReusedDead);
      reusedWs.on("close", onTempReusedDead);
      if (activeEditBranch?.handoffErrListener) {
        reusedWs.off("error", activeEditBranch.handoffErrListener);
        activeEditBranch.handoffErrListener = undefined;
      }
    }
    const safeCloseReusedWs = () => {
      if (reusedWsTrackedActive) {
        reusedWsTrackedActive = false;
        this.warmPool.trackActiveWsEnd(lease.slotId);
      }
      if (!reusedWs) return;
      const dead = reusedWs;
      reusedWs = undefined;
      dead.off("error", onTempReusedDead);
      dead.off("close", onTempReusedDead);
      if (!tempReusedDead && dead.readyState === WebSocket.OPEN && this.warmPool.releaseUntouchedWs(lease.slotId, dead)) {
        return;
      }
      dead.on("error", () => { });
      try {
        dead.close();
      } catch { }
    };

    const cred = parseQuickCredential(lease.apiKey);
    const isWeb = cred.mode === "web" && Boolean(cred.web);
    const isOAuthAccount = cred.mode === "oauth" && Boolean(cred.oauth);
    // Pass only the explicit per-credential proxy; let `fetchViaOptionalProxy` resolve ambient env
    // proxies per target URL so `NO_PROXY` and loopback bypasses are always respected.
    const effectiveProxy = lease.proxyUrl;
    const proxyTargetHintUrl = isWeb
      ? "https://quick.aws.com/"
      : cred.oauth?.wsHost
        ? `https://${cred.oauth.wsHost}/`
        : cred.wsHost
          ? `https://${cred.wsHost}/`
          : undefined;
    const isInternalHelperCall = Boolean(turn.rawBody?.__internalRephrase);
    let workingSessionId = isInternalHelperCall
      ? crypto.randomUUID()
      : this.workingSessionIds.get(lease.slotId);
    if (!workingSessionId) {
      workingSessionId = crypto.randomUUID();
      this.workingSessionIds.set(lease.slotId, workingSessionId);
    }

    if (reusedWs && (tempReusedDead || reusedWs.readyState !== WebSocket.OPEN)) {
      safeCloseReusedWs();
      if (isIncognito) {
        activeEditBranch = undefined;
        warmThreadId = undefined;
        isWarmIncremental = false;
      } else if (activeEditBranch) {
        activeEditBranch.ws = undefined;
      }
    }
    let threadId = warmThreadId || crypto.randomUUID();
    let effectiveRootThreadId = rootThreadId || threadId;
    const reqAttCache = turnOpts?.attachmentCache;

    const ensureHeadroomBeforeDial = async () => {
      if (turn.signal?.aborted) {
        throw new GatewayError("Request aborted before dialing upstream WebSocket.", 499, "client_aborted");
      }
      const activeForSlot = Math.max(
        this.warmPool.getActiveWsCount(lease.slotId),
        keyPool ? keyPool.activeInflightForSlot(lease.slotId) : 0,
      );
      const pendingStandby = this.warmPool.hasPendingStandbyDial(lease.slotId) ? 1 : 0;
      const idleForSlot = this.warmPool.countIdleWsForSlot(lease.slotId);
      if (activeForSlot + idleForSlot + pendingStandby > 4 && pendingStandby > 0) {
        this.warmPool.cancelPendingStandbyDial(lease.slotId);
      }
      const overflow = activeForSlot + this.warmPool.countIdleWsForSlot(lease.slotId) - 4;
      if (overflow > 0) {
        this.warmPool.evictParkedWsForSlot(lease.slotId, overflow);
      }
      // Only wait for AWS's brief WS-reap settling window when the slot is actually near the 5-WS cap.
      const postEvictTotal = activeForSlot + this.warmPool.countIdleWsForSlot(lease.slotId);
      const settleMs = postEvictTotal >= 4 ? this.warmPool.getEvictSettlingRemainingMs(lease.slotId) : 0;
      if (settleMs > 0 && !turn.signal?.aborted) {
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            clearTimeout(t);
            resolve();
          };
          const t = setTimeout(() => {
            turn.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, settleMs);
          turn.signal?.addEventListener("abort", onAbort, { once: true });
          if (turn.signal?.aborted) onAbort();
        });
      }
      if (turn.signal?.aborted) {
        throw new GatewayError("Request aborted before dialing upstream WebSocket.", 499, "client_aborted");
      }
    };

    // Instant cold-turn acceleration: pop a pre-warmed `session_established` standby WS if available
    // (saves ~1.9s on direct connections and ~7.1s on residential SOCKS5 proxies!).
    let standbyHit = !reusedWs && !turn.signal?.aborted
      ? this.warmPool.takeStandby(lease.slotId, isIncognito)
      : undefined;
    let tempStandbyDead = false;
    let standbyTrackedActive = false;
    const onTempStandbyDead = () => {
      tempStandbyDead = true;
    };
    if (standbyHit) {
      this.warmPool.trackActiveWsStart(lease.slotId);
      standbyTrackedActive = true;
      standbyHit.ws.on("error", onTempStandbyDead);
      standbyHit.ws.on("close", onTempStandbyDead);
      // Early non-blocking WS ping: surfaces half-open residential proxy RST during OOB upload
      // instead of waiting 10s on `standbyLivenessTimer` afterward.
      try {
        standbyHit.ws.ping();
      } catch { }
    }
    const safeCloseStandbyWs = () => {
      if (standbyTrackedActive) {
        standbyTrackedActive = false;
        this.warmPool.trackActiveWsEnd(lease.slotId);
      }
      if (!standbyHit) return;
      const stale = standbyHit.ws;
      standbyHit = undefined;
      stale.off("error", onTempStandbyDead);
      stale.off("close", onTempStandbyDead);
      if (!tempStandbyDead && stale.readyState === WebSocket.OPEN && this.warmPool.releaseUntouchedWs(lease.slotId, stale)) {
        return;
      }
      stale.on("error", () => { });
      try {
        stale.close();
      } catch { }
    };

    // Speculative parallel WS dial + `session_connect` handshake during OOB attachment/text uploads.
    // Overlaps the ~900-1000ms WS connect+handshake RTT behind OOB upload without risking leaks on abort/error.
    interface SpeculativeDialState {
      dialed: DialedQuickWs;
      handshakeEstablished: boolean;
      sessionConnectSent: boolean;
      dead: boolean;
      trackedActive: boolean;
      bufferedFrames: Buffer[];
      detach: () => void;
    }
    let specCancelled = false;
    let specPromise: Promise<SpeculativeDialState | null> | null = null;
    const cancelSpeculativeDial = () => {
      specCancelled = true;
      if (specPromise) {
        void specPromise.then((st) => {
          if (!st) return;
          st.detach();
          if (st.trackedActive) {
            st.trackedActive = false;
            this.warmPool.trackActiveWsEnd(lease.slotId);
          }
          st.dialed.ws.on("error", () => { });
          try {
            st.dialed.ws.close();
          } catch { }
        });
        specPromise = null;
      }
    };

    const rawSourceFiles = isWarmIncremental ? (turn.incrementalFiles ?? []) : (turn.files ?? []);
    const rawSourceImages = isWarmIncremental ? (turn.incrementalImages ?? []) : turn.images;
    const rawPromptEst =
      turnOpts?.overridePromptText !== undefined
        ? turnOpts.overridePromptText
        : isWarmIncremental
          ? turn.incrementalUserText
          : turn.fullTranscriptText;
    const willLikelyUseOob =
      !reusedWs &&
      !standbyHit &&
      !turn.signal?.aborted &&
      ((isOAuthAccount && Boolean(cred.oauth)) || (isWeb && Boolean(cred.web))) &&
      (rawSourceFiles.length > 0 ||
        rawSourceImages.length > 0 ||
        jsonStringUtf8Bytes(rawPromptEst || "") + jsonStringUtf8Bytes(customPrompt || "") > 44_000);

    if (willLikelyUseOob) {
      const oauthClientIdForSpec = cred.mode === "oauth" ? cred.oauth?.clientId : undefined;
      specPromise = (async (): Promise<SpeculativeDialState | null> => {
        try {
          const dialed = await dialQuickWebSocket({
            apiKey: lease.apiKey,
            workingSessionId,
            proxyUrl: lease.proxyUrl,
            webSocketFactory: this.webSocketFactory,
            beforeDial: ensureHeadroomBeforeDial,
          });
          if (specCancelled || turn.signal?.aborted) {
            dialed.ws.on("error", () => { });
            try {
              dialed.ws.close();
            } catch { }
            return null;
          }
          this.warmPool.trackActiveWsStart(lease.slotId);
          const state: SpeculativeDialState = {
            dialed,
            handshakeEstablished: false,
            sessionConnectSent: false,
            dead: false,
            trackedActive: true,
            bufferedFrames: [],
            detach: () => { },
          };
          let specRecvBuf = Buffer.alloc(0);
          const onSpecDead = () => {
            state.dead = true;
          };
          const onSpecOpen = () => {
            if (specCancelled || state.dead || dialed.ws.readyState !== WebSocket.OPEN) return;
            try {
              dialed.ws.send(
                dialed.encodeFrame({
                  type: "session_connect",
                  payload: {
                    ...(dialed.actorArn ? { actor_id: dialed.actorArn } : {}),
                    surfaceType: dialed.surfaceType,
                    outpostId: dialed.outpostId,
                    appVersion: dialed.appVersion,
                    ...DESKTOP_CAPABILITIES,
                    ...(isIncognito ? { incognito: true } : {}),
                  },
                }),
              );
              if (!dialed.isWeb) {
                dialed.ws.send(dialed.encodeFrame({ type: "federate_status", payload: {} }));
              }
              state.sessionConnectSent = true;
            } catch {
              state.dead = true;
            }
          };
          const onSpecMessage = (data: Buffer) => {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
            if (!state.handshakeEstablished) {
              try {
                specRecvBuf = Buffer.concat([specRecvBuf, chunk]);
                const drained = drainEventStream(specRecvBuf, 0);
                if (drained.consumed > 0) specRecvBuf = specRecvBuf.subarray(drained.consumed);
                for (const esMsg of drained.messages) {
                  const dec = dialed.decodeFrame(esMsg);
                  if (dec?.type === "event" && dec.data && typeof dec.data === "object") {
                    const evObj = dec.data as { type?: unknown; payload?: Record<string, unknown> };
                    const evT = String(evObj.type || "");
                    if (evT === "session_established" || evT === "connected") {
                      state.handshakeEstablished = true;
                      if (evT === "connected" && oauthClientIdForSpec) {
                        const u = evObj.payload?.user as Record<string, unknown> | undefined;
                        if (u && typeof u === "object") {
                          cacheOAuthUserIdentity(oauthClientIdForSpec, {
                            ...(typeof u.email === "string" ? { email: u.email } : {}),
                            ...(typeof u.name === "string" ? { name: u.name } : {}),
                            ...(typeof u.aws_account_id === "string" ? { accountId: u.aws_account_id } : {}),
                          });
                        }
                      }
                    }
                  }
                }
              } catch {
                // Non-fatal: let runTurnStream handle or fail cleanly
              }
            } else {
              state.bufferedFrames.push(chunk);
            }
          };
          state.detach = () => {
            dialed.ws.off("open", onSpecOpen);
            dialed.ws.off("message", onSpecMessage);
            dialed.ws.off("error", onSpecDead);
            dialed.ws.off("close", onSpecDead);
            if (specRecvBuf.length > 0) {
              state.bufferedFrames.unshift(specRecvBuf);
              specRecvBuf = Buffer.alloc(0);
            }
          };
          dialed.ws.on("error", onSpecDead);
          dialed.ws.on("close", onSpecDead);
          dialed.ws.on("message", onSpecMessage);
          if (dialed.ws.readyState === WebSocket.OPEN) {
            onSpecOpen();
          } else {
            dialed.ws.once("open", onSpecOpen);
          }
          return state;
        } catch {
          return null;
        }
      })();
    }

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
        safeCloseReusedWs();
        if (isIncognito) {
          activeEditBranch = undefined;
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
        } else if (activeEditBranch) {
          activeEditBranch.ws = undefined;
        }
      }
    } catch (prepErr) {
      safeCloseReusedWs();
      safeCloseStandbyWs();
      cancelSpeculativeDial();
      throw prepErr;
    }

    let execMode: ExecutionModeTag = isWarmIncremental
      ? "warm_incremental"
      : isIncognito
        ? "incognito"
        : "cloud";

    const buildBaseExecMeta = () => ({
      slotId: lease.slotId,
      maskedKey: lease.maskedKey,
      accountLabel: lease.label,
      ...(lease.group ? { accountGroup: lease.group } : {}),
      execMode,
      usedProxy: Boolean(resolveEffectiveProxyUrl(lease.proxyUrl, proxyTargetHintUrl)),
      agentMode: selection.agentMode,
      thinkingEffort: selection.thinkingEffort,
      effectiveSystemPromptChars,
      ...(turnOpts?.isRephraseRetry ? { contentFilterRecovered: true } : {}),
      ...(turnOpts?.warmFallbackToCold ? { warmFallbackToCold: true } : {}),
      ...(!normalizedChatAgentId && !isInternalHelperCall ? { usedDefaultSystemAgent: true } : {}),
    });

    // Bind execution metadata for tracing/ledger immediately, while explicitly keeping `flushEarly`
    // disarmed (`flushEarlyReady: false`) until OOB `.txt` upload + WS dial complete (and cancelling
    // any previous attempt's 15s timer on failover so 400/429/502 errors stay real HTTP statuses).
    onExecMeta?.({ ...buildBaseExecMeta(), flushEarlyReady: false });

    if (turn.signal?.aborted) {
      safeCloseReusedWs();
      safeCloseStandbyWs();
      cancelSpeculativeDial();
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
        isWeb,
        webCred: cred.web,
        effectiveProxy,
        reqAttCache,
      });
      chunks = prepared.chunks;
      effectiveCustomPrompt = prepared.effectiveCustomPrompt;
      attachments = prepared.attachments;
      rawPromptForRephrase = prepared.rawPromptForRephrase;
      rephrasePreservePrefix = prepared.rephrasePreservePrefix;

      // Native `edit_message` only accepts a single user message frame; if a non-OAuth >46KB edit
      // split into multiple chunks, cleanly rebuild as a full cold replay on a fresh thread instead
      // of appending chunk 0 onto the pre-edit branch.
      if (activeEditBranch && chunks.length > 1) {
        safeCloseReusedWs();
        activeEditBranch = undefined;
        warmThreadId = undefined;
        isWarmIncremental = false;
        threadId = crypto.randomUUID();
        effectiveRootThreadId = threadId;
        execMode = isIncognito ? "incognito" : "cloud";
        onExecMeta?.({ ...buildBaseExecMeta(), flushEarlyReady: false });
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
        const coldPrepared = await finalizePromptChunksAndOutOfBandText({
          turn,
          slotId: lease.slotId,
          threadId,
          isWarmIncremental: false,
          overridePromptText: turnOpts?.overridePromptText,
          prompt: coldBuilt.promptText,
          customPrompt,
          attachments: coldBuilt.attachments,
          isOAuthAccount,
          oauthCred: cred.oauth,
          isWeb,
          webCred: cred.web,
          effectiveProxy,
          reqAttCache,
        });
        chunks = coldPrepared.chunks;
        effectiveCustomPrompt = coldPrepared.effectiveCustomPrompt;
        attachments = coldPrepared.attachments;
        rawPromptForRephrase = coldPrepared.rawPromptForRephrase;
        rephrasePreservePrefix = coldPrepared.rephrasePreservePrefix;
      }

      // If reusedWs died during a long OOB `.txt` upload under INCOGNITO=true, never dial a fresh WS
      // with the old pod-local incognito threadId — cleanly rebuild as cold replay on a fresh threadId.
      if (reusedWs && (tempReusedDead || reusedWs.readyState !== WebSocket.OPEN)) {
        safeCloseReusedWs();
        if (isIncognito) activeEditBranch = undefined;
        else if (activeEditBranch) activeEditBranch.ws = undefined;
        if (isIncognito && isWarmIncremental) {
          warmThreadId = undefined;
          isWarmIncremental = false;
          threadId = crypto.randomUUID();
          effectiveRootThreadId = threadId;
          execMode = "incognito";
          onExecMeta?.({ ...buildBaseExecMeta(), flushEarlyReady: false });
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
          const coldPrepared = await finalizePromptChunksAndOutOfBandText({
            turn,
            slotId: lease.slotId,
            threadId,
            isWarmIncremental: false,
            overridePromptText: turnOpts?.overridePromptText,
            prompt: coldBuilt.promptText,
            customPrompt,
            attachments: coldBuilt.attachments,
            isOAuthAccount,
            oauthCred: cred.oauth,
            isWeb,
            webCred: cred.web,
            effectiveProxy,
            reqAttCache,
          });
          chunks = coldPrepared.chunks;
          effectiveCustomPrompt = coldPrepared.effectiveCustomPrompt;
          attachments = coldPrepared.attachments;
          rawPromptForRephrase = coldPrepared.rawPromptForRephrase;
          rephrasePreservePrefix = coldPrepared.rephrasePreservePrefix;
        }
      }
    } catch (chunkErr) {
      safeCloseReusedWs();
      safeCloseStandbyWs();
      cancelSpeculativeDial();
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

    const forcedToolName =
      typeof turn.toolChoice === "object" && turn.toolChoice.type === "tool" && turn.toolChoice.name
        ? turn.toolChoice.name.trim()
        : "";
    const allowedToolNames = new Set<string>();
    const customToolNames = new Set<string>();
    for (const t of turn.tools) {
      const matchesForced = !forcedToolName || t.name === forcedToolName || t.wireName === forcedToolName;
      if (matchesForced) {
        if (t.name) allowedToolNames.add(t.name);
        if (t.wireName) allowedToolNames.add(t.wireName);
      }
      if (t.toolKind === "custom") {
        if (t.name) customToolNames.add(t.name);
        if (t.wireName) customToolNames.add(t.wireName);
      }
    }
    if (forcedToolName && allowedToolNames.size === 0) {
      allowedToolNames.add(forcedToolName);
    }
    const toolFilter = toolBridgePrompt
      ? new StreamingToolCallFilter(allowedToolNames, customToolNames.size > 0 ? customToolNames : undefined)
      : null;
    const uiTagSanitizer = new StreamingUiTagSanitizer();

    let encodeFrame: QuickFrameEncoder = isWeb ? encodeGatewayJsonFrame : encodeCloudInputFrame;
    let decodeFrame: QuickFrameDecoder = isWeb ? decodeGatewayFrame : decodeCloudOutputFrame;
    let surfaceType = isWeb ? "WEB_EXPERIENCE" : SURFACE_TYPE;
    let appVersion = isWeb ? "qbiz-web-bridge" : APP_VERSION;
    let surfaceName: "web" | "desktop" = isWeb ? "web" : "desktop";
    let ws: WebSocket;
    let actorArn: string | undefined;
    let outpostId = activeEditBranch?.outpostId || warmHit?.reusedOutpostId || "web0";
    let isReusedOpenWs = false;
    let isStandbyWs = false;
    let alreadyTrackedActive = false;
    let preSessionConnectSent = false;
    let preBufferedFrames: Buffer[] | undefined;

    if (reusedWs && !tempReusedDead && reusedWs.readyState === WebSocket.OPEN) {
      reusedWs.off("error", onTempReusedDead);
      reusedWs.off("close", onTempReusedDead);
      ws = reusedWs;
      isReusedOpenWs = true;
      alreadyTrackedActive = reusedWsTrackedActive;
      reusedWsTrackedActive = false;
      safeCloseStandbyWs();
      cancelSpeculativeDial();
    } else if (standbyHit && !tempStandbyDead && standbyHit.ws.readyState === WebSocket.OPEN) {
      safeCloseReusedWs();
      cancelSpeculativeDial();
      const adoptedStandby = standbyHit;
      standbyHit = undefined;
      adoptedStandby.ws.off("error", onTempStandbyDead);
      adoptedStandby.ws.off("close", onTempStandbyDead);
      ws = adoptedStandby.ws;
      encodeFrame = adoptedStandby.encodeFrame;
      decodeFrame = adoptedStandby.decodeFrame;
      surfaceType = adoptedStandby.surfaceType;
      appVersion = adoptedStandby.appVersion;
      surfaceName = adoptedStandby.surfaceName;
      outpostId = adoptedStandby.outpostId;
      actorArn = adoptedStandby.actorArn;
      isReusedOpenWs = true;
      isStandbyWs = true;
      alreadyTrackedActive = standbyTrackedActive;
      standbyTrackedActive = false;
      // Overlap replacement standby dial ONLY when the slot no longer has a live primary/standby WS
      // (a borrowed Primary Shared WS returns to idle automatically when this turn completes).
      if (!isInternalHelperCall && keyPool && !this.warmPool.hasLivePrimaryOrStandby(lease.slotId, isIncognito)) {
        const activeNow = Math.max(this.warmPool.getActiveWsCount(lease.slotId), keyPool.activeInflightForSlot(lease.slotId));
        if (activeNow + this.warmPool.countIdleWsForSlot(lease.slotId) <= 2) {
          this.scheduleStandbyWarmup(keyPool, lease.slotId, 200, { ignoreBackoff: true });
        }
      }
    } else {
      safeCloseReusedWs();
      safeCloseStandbyWs();
      let adoptedSpec: SpeculativeDialState | null = null;
      if (specPromise) {
        const candidate = await specPromise;
        specPromise = null;
        if (candidate) {
          candidate.detach();
          if (candidate.trackedActive) {
            candidate.trackedActive = false;
            this.warmPool.trackActiveWsEnd(lease.slotId);
          }
          if (
            !candidate.dead &&
            (candidate.dialed.ws.readyState === WebSocket.OPEN ||
              candidate.dialed.ws.readyState === WebSocket.CONNECTING)
          ) {
            adoptedSpec = candidate;
          } else {
            candidate.dialed.ws.on("error", () => { });
            try {
              candidate.dialed.ws.close();
            } catch { }
          }
        }
      }

      if (adoptedSpec) {
        const { dialed } = adoptedSpec;
        ws = dialed.ws;
        encodeFrame = dialed.encodeFrame;
        decodeFrame = dialed.decodeFrame;
        surfaceType = dialed.surfaceType;
        appVersion = dialed.appVersion;
        surfaceName = dialed.surfaceName;
        outpostId = dialed.outpostId;
        actorArn = dialed.actorArn;
        isReusedOpenWs = adoptedSpec.handshakeEstablished && ws.readyState === WebSocket.OPEN;
        preSessionConnectSent =
          !isReusedOpenWs && adoptedSpec.sessionConnectSent && ws.readyState === WebSocket.OPEN;
        if (adoptedSpec.bufferedFrames.length > 0) {
          preBufferedFrames = adoptedSpec.bufferedFrames;
        }
      } else {
        // Late standby fallback (e.g. if `reusedWs` died during a long OOB upload) before cold-dialing.
        const lateStandby = !turn.signal?.aborted
          ? this.warmPool.takeStandby(lease.slotId, isIncognito)
          : undefined;
        if (lateStandby && lateStandby.ws.readyState === WebSocket.OPEN) {
          ws = lateStandby.ws;
          encodeFrame = lateStandby.encodeFrame;
          decodeFrame = lateStandby.decodeFrame;
          surfaceType = lateStandby.surfaceType;
          appVersion = lateStandby.appVersion;
          surfaceName = lateStandby.surfaceName;
          outpostId = lateStandby.outpostId;
          actorArn = lateStandby.actorArn;
          isReusedOpenWs = true;
          isStandbyWs = true;
        } else {
          if (lateStandby) {
            lateStandby.ws.on("error", () => { });
            try { lateStandby.ws.close(); } catch { }
          }
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
      }
    }

    // OOB `.txt` upload and upstream WS dial succeeded — arm (or reset) the 15s `flushEarly` keepalive timer now.
    onExecMeta?.({ ...buildBaseExecMeta(), flushEarlyReady: true });

    yield* runTurnStream({
      ws,
      isReusedOpenWs,
      isStandbyWs,
      alreadyTrackedActive,
      preSessionConnectSent,
      preBufferedFrames,
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
      chatAgentId: normalizedChatAgentId,
      warmGeneration,
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
      editBranch: activeEditBranch,
      onContentFilterCapture: turnOpts?.onContentFilterCapture,
      runMaxTimeoutMs: this.config.runMaxTimeoutMs,
      runIdleTimeoutMs: this.config.runIdleTimeoutMs,
      showRoutedModelInThinking: keyPool
        ? keyPool.getSettings().showRoutedModelInThinking
        : this.showRoutedModelInThinking,
      observedModelHint: this.getObservedModelHint(lease.slotId, selection.agentMode),
      onResolvedModel: (modelId) => {
        this.recordObservedModel(lease.slotId, selection.agentMode, modelId);
        onExecMeta?.({ ...buildBaseExecMeta(), resolvedModel: modelId });
      },
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

    // Code-level single-turn isolation: only send the final `[USER]:` turn to the helper model
    // so multi-turn history is never echoed, truncated, or mutated by `quick-fast`.
    const { prefix, lastUser, hasMarkers } = splitTrailingUserTurn(trimmedInput);
    const targetText = lastUser || trimmedInput;
    if (!targetText || targetText.length > 20_000) return undefined;

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
      targetText,
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
      const checked = validateRephrasedPrompt(targetText, out, { inputHadMarkers: false });
      if (!checked.ok || !checked.cleaned) return undefined;
      return hasMarkers ? `${prefix}${checked.cleaned}` : checked.cleaned;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }
}
