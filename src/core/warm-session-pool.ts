import WebSocket from "ws";
import { resolveOAuthAccessToken } from "../aws-quick/oauth-client.js";
import { parseQuickCredential } from "../aws-quick/outpost-singleton.js";
import type { QuickFrameDecoder, QuickFrameEncoder } from "../aws-quick/ws-transport.js";

const WARM_THREAD_TTL_MS = 60 * 60 * 1000;
// Official AWS Quick desktop (`sncsWsProxy.js`) keeps a single WS alive indefinitely using 25s pings
// + `token_refresh` (Gateway IdleStateHandler only reaps at 120s ALL_IDLE). Default parked WS idle TTL
// to 60m (matching `SESSION_AFFINITY_TTL_MS` and configurable via `PARKED_WS_IDLE_TTL_MS`) for direct OAuth
// accounts, while auto-capping proxied or non-OAuth (`web:` / `local-outpost`) sockets to 25m to avoid
// residential-proxy TCP churn and stale non-refreshed Web cookies.
const DEFAULT_PARKED_WS_IDLE_TTL_MS = 60 * 60 * 1000;
export const PROXIED_OR_NON_OAUTH_PARKED_WS_CAP_MS = 25 * 60 * 1000;
const STANDBY_WS_IDLE_TTL_MS = 10 * 60 * 1000;
const PARKED_WS_TOKEN_REFRESH_MS = 12 * 60 * 1000;
const MAX_WARM_THREADS = 256;
const MIN_PARKED_WS = 64;
const MAX_STANDBY_WS_GLOBAL = 16;
// AWS Quick enforces a hard limit of 5 active WebSockets per account (`LimitExceededException`).
// With Single-WS Serial Borrow/Return Multiplexing, each account keeps 1 primary shared WebSocket
// that holds up to 16 warm conversations (strictly exclusive borrow/return -> zero frame interleaving
// or cross-talk!) plus at most 2 auxiliary dedicated parked sockets under concurrent bursts.
export const MAX_PARKED_WS_PER_SLOT = 3;
export const MAX_THREADS_PER_SHARED_WS = 16;
const MAX_AUX_PARKED_WS_WHEN_PRIMARY_WARM = 2;

export type StandbyRemovalReason = "expired" | "closed" | "error" | "pong_timeout" | "token_refresh_failed";

export interface StandbyWsHandle {
  ws: WebSocket;
  outpostId: string;
  encodeFrame: QuickFrameEncoder;
  decodeFrame: QuickFrameDecoder;
  surfaceType: string;
  appVersion: string;
  surfaceName: "web" | "desktop";
  actorArn?: string;
}

export interface SharedHandleMeta {
  decodeFrame: QuickFrameDecoder;
  surfaceType: string;
  appVersion: string;
  surfaceName: "web" | "desktop";
  actorArn?: string;
}

interface InternalStandbyEntry extends StandbyWsHandle {
  slotId: string;
  isIncognito: boolean;
  parked: ParkedWsHandle;
  deadHandled: boolean;
}

interface SharedSlotWs {
  wsId: number;
  slotId: string;
  isIncognito: boolean;
  borrowed: boolean;
  handle: StandbyWsHandle;
  apiKey?: string;
  proxyUrl?: string;
  lastAckSeq?: string;
  idle?: ParkedWsHandle;
  onBorrowedClose?: () => void;
  onBorrowedError?: () => void;
  deadHandled: boolean;
}

interface ParkedWsHandle {
  ws: WebSocket;
  outpostId: string;
  pingTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  tokenRefreshTimer?: NodeJS.Timeout;
  onIdleClose: () => void;
  onIdleError: () => void;
  onIdleMessage: () => void;
  onIdlePong: () => void;
}

interface WarmThreadEntry {
  slotId: string;
  threadId: string;
  rootThreadId: string;
  isIncognito: boolean;
  expiresAt: number;
  /** Priority hint (1 = tiny 1-turn helper, 2+ = multi-turn/heavy coding session) used during per-slot eviction. */
  priority: number;
  /** Dedicated per-conversation parked WS (used for auxiliary burst turns). */
  parkedWs?: ParkedWsHandle;
  /** ID of the slot's Primary Shared WS (`SharedSlotWs.wsId`) backing this warm thread. */
  sharedWsId?: number;
  siblingKeys: string[];
  /** Optional prefix key matching the state BEFORE the last user turn, enabling native `edit_message` on Retry/Edit. */
  editKey?: string;
  /** The `message_id` of the last user turn sent on this thread (passed as `original_message_id` when `editKey` hits). */
  lastUserMessageId?: string;
}

export interface WarmLookupResult {
  threadId: string;
  rootThreadId: string;
  reusedWs?: WebSocket;
  reusedOutpostId?: string;
  /** Set when `prefixHash` matched the prior turn's `editKey` (client Retry / Edit of last user prompt). */
  editOriginalMessageId?: string;
}

/**
 * Manages warm AWS Quick threads, per-account Single-WS Serial Borrow/Return Multiplexing
 * (1 primary shared WS holding up to 16 isolated `thread_id`s with exclusive borrow lock),
 * auxiliary burst parked sockets, liveness watchdogs, `ping.ack`, OAuth 12m `token_refresh`,
 * and exact per-account active WebSocket accounting.
 */
export class WarmSessionPool {
  private readonly maxWarmSessions: number;
  private readonly maxParkedWs: number;
  private readonly warmSessionTtlMs: number;
  private readonly parkedWsIdleTtlMs: number;
  private readonly proxiedOrNonOAuthCapMs: number;
  private readonly standbyTtlMs: number;
  private readonly onStandbyRemoved?: (slotId: string, reason: StandbyRemovalReason) => void;
  private readonly warmThreads = new Map<string, WarmThreadEntry>();
  /** Primary shared borrow/return WS per slot (serves BOTH cold starts and up to 16 warm threads). */
  private readonly primaryBySlot = new Map<string, SharedSlotWs>();
  /** Optional overflow standby WS per slot (used only when primary is already active/busy). */
  private readonly standbyBySlot = new Map<string, InternalStandbyEntry>();
  private readonly standbyPendingSlots = new Set<string>();
  private readonly standbyPendingCancels = new Map<string, () => void>();
  private readonly activeWsBySlot = new Map<string, number>();
  private readonly evictSettlingUntilBySlot = new Map<string, number>();
  private readonly slotGeneration = new Map<string, number>();
  private globalGeneration = 0;
  private nextWsId = 0;

  constructor(opts: {
    maxWarmSessions?: number;
    warmSessionTtlMs?: number;
    parkedWsIdleTtlMs?: number;
    proxiedOrNonOAuthCapMs?: number;
    standbyTtlMs?: number;
    onStandbyRemoved?: (slotId: string, reason: StandbyRemovalReason) => void;
  }) {
    this.maxWarmSessions = opts.maxWarmSessions || MAX_WARM_THREADS;
    this.maxParkedWs = Math.max(MIN_PARKED_WS, Math.floor(this.maxWarmSessions / 2));
    this.warmSessionTtlMs = opts.warmSessionTtlMs || WARM_THREAD_TTL_MS;
    this.parkedWsIdleTtlMs =
      opts.parkedWsIdleTtlMs && opts.parkedWsIdleTtlMs > 0
        ? opts.parkedWsIdleTtlMs
        : DEFAULT_PARKED_WS_IDLE_TTL_MS;
    this.proxiedOrNonOAuthCapMs =
      opts.proxiedOrNonOAuthCapMs && opts.proxiedOrNonOAuthCapMs > 0
        ? opts.proxiedOrNonOAuthCapMs
        : PROXIED_OR_NON_OAUTH_PARKED_WS_CAP_MS;
    this.standbyTtlMs = opts.standbyTtlMs && opts.standbyTtlMs > 0 ? opts.standbyTtlMs : STANDBY_WS_IDLE_TTL_MS;
    this.onStandbyRemoved = opts.onStandbyRemoved;
  }

  /**
   * Resolves the effective parked-WS idle TTL for a slot:
   * - Direct OAuth accounts (`oauth:` with no outbound `proxyUrl`) get the full configured TTL (default 60m).
   * - Proxied accounts or non-OAuth channels (`web:` / `local-outpost` / static token without `token_refresh`)
   *   are automatically capped at `proxiedOrNonOAuthCapMs` (default 25m) to prevent residential-proxy TCP churn
   *   and stale Web session sockets.
   */
  computeParkedWsIdleTtlMs(apiKey?: string, proxyUrl?: string): number {
    const baseTtl = Math.min(this.warmSessionTtlMs, this.parkedWsIdleTtlMs);
    const hasProxy = Boolean(proxyUrl?.trim());
    let isDirectOAuth = !apiKey;
    if (apiKey) {
      try {
        const parsed = parseQuickCredential(apiKey);
        isDirectOAuth = parsed.mode === "oauth" && Boolean(parsed.oauth);
      } catch {
        isDirectOAuth = false;
      }
    }
    if (hasProxy || !isDirectOAuth) {
      return Math.min(baseTtl, this.proxiedOrNonOAuthCapMs);
    }
    return baseTtl;
  }

  /**
   * Returns a monotonic generation token for `slotId`. Any change to the slot's
   * `chatAgentId`, published agent instructions, proxy, or global agent/incognito settings
   * bumps this generation so in-flight turns finishing with stale settings refuse to park.
   */
  getSlotGeneration(slotId: string): number {
    return this.globalGeneration + (this.slotGeneration.get(slotId) || 0);
  }

  private countWarmEntriesForSharedWs(wsId: number): number {
    const seen = new Set<WarmThreadEntry>();
    let n = 0;
    for (const entry of this.warmThreads.values()) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      if (entry.sharedWsId === wsId) n += 1;
    }
    return n;
  }

  private purgeIncognitoEntriesForSharedWs(wsId: number): void {
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.sharedWsId !== wsId) continue;
      if (entry.isIncognito) {
        this.removeEntry(entry, false);
      } else {
        entry.sharedWsId = undefined;
      }
    }
  }

  private detachBorrowedListeners(shared: SharedSlotWs): void {
    if (shared.onBorrowedClose) {
      shared.handle.ws.off("close", shared.onBorrowedClose);
      shared.onBorrowedClose = undefined;
    }
    if (shared.onBorrowedError) {
      shared.handle.ws.off("error", shared.onBorrowedError);
      shared.onBorrowedError = undefined;
    }
  }

  private handlePrimaryDead(shared: SharedSlotWs, reason: StandbyRemovalReason, notifyReplenish: boolean): void {
    if (shared.deadHandled) return;
    shared.deadHandled = true;
    const activeSlotId = shared.slotId;
    const wasActivePrimary = this.primaryBySlot.get(activeSlotId) === shared;
    if (wasActivePrimary) {
      this.primaryBySlot.delete(activeSlotId);
    }
    this.detachBorrowedListeners(shared);
    if (shared.idle) {
      const h = shared.idle;
      shared.idle = undefined;
      this.detachParkedWs(h, true);
    } else {
      shared.handle.ws.on("error", () => {});
      try {
        shared.handle.ws.close();
      } catch { }
    }
    this.purgeIncognitoEntriesForSharedWs(shared.wsId);
    if (wasActivePrimary && notifyReplenish) {
      this.onStandbyRemoved?.(activeSlotId, reason);
    }
  }

  private attachPrimaryIdleWatchdog(shared: SharedSlotWs): void {
    if (shared.idle) {
      const prev = shared.idle;
      shared.idle = undefined;
      this.detachParkedWs(prev, false);
    }
    this.detachBorrowedListeners(shared);
    shared.borrowed = false;

    const { ws, outpostId, encodeFrame } = shared.handle;
    if (ws.readyState !== WebSocket.OPEN) {
      this.handlePrimaryDead(shared, "closed", true);
      return;
    }

    const onIdleClose = () => this.handlePrimaryDead(shared, "closed", true);
    const onIdleError = () => this.handlePrimaryDead(shared, "error", true);
    let missedPongs = 0;
    const onIdleMessage = () => {
      missedPongs = 0;
    };
    const onIdlePong = () => {
      missedPongs = 0;
    };

    const hasWarmThreads = this.countWarmEntriesForSharedWs(shared.wsId) > 0;
    const pingIntervalMs = hasWarmThreads ? 25_000 : 15_000;
    const pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || shared.borrowed || shared.deadHandled) {
        if (ws.readyState !== WebSocket.OPEN) this.handlePrimaryDead(shared, "closed", true);
        return;
      }
      if (missedPongs >= 2) {
        try {
          ws.terminate();
        } catch { }
        this.handlePrimaryDead(shared, "pong_timeout", true);
        return;
      }
      missedPongs += 1;
      try {
        ws.ping();
        ws.send(
          encodeFrame({
            type: "ping",
            payload: { timestamp: Date.now(), ...(shared.lastAckSeq ? { ack: shared.lastAckSeq } : {}) },
          }),
        );
      } catch {
        this.handlePrimaryDead(shared, "error", true);
      }
    }, pingIntervalMs);
    pingTimer.unref?.();

    let tokenRefreshTimer: NodeJS.Timeout | undefined;
    const parsedForRefresh = shared.apiKey ? parseQuickCredential(shared.apiKey) : undefined;
    if (parsedForRefresh?.mode === "oauth" && parsedForRefresh.oauth) {
      const oauthCred = parsedForRefresh.oauth;
      tokenRefreshTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || shared.borrowed || shared.deadHandled) {
          if (ws.readyState !== WebSocket.OPEN) this.handlePrimaryDead(shared, "closed", true);
          return;
        }
        void resolveOAuthAccessToken(oauthCred, false, shared.proxyUrl)
          .then(({ accessToken }) => {
            if (ws.readyState === WebSocket.OPEN && !shared.borrowed && !shared.deadHandled) {
              // Live-verified on Cloud OAuth `/streaming/quickwork-chat-bidirectional-stream`:
              // MUST use `encodeFrame` (`rawInputEvent`), as raw JSON text immediately closes the Cloud WS (1000).
              ws.send(encodeFrame({ type: "token_refresh", token: accessToken }));
            }
          })
          .catch(() => {
            this.handlePrimaryDead(shared, "token_refresh_failed", true);
          });
      }, PARKED_WS_TOKEN_REFRESH_MS);
      tokenRefreshTimer.unref?.();
    }

    const idleTtl = hasWarmThreads
      ? this.computeParkedWsIdleTtlMs(shared.apiKey, shared.proxyUrl)
      : this.standbyTtlMs;
    const idleTimer = setTimeout(() => this.handlePrimaryDead(shared, "expired", true), idleTtl);
    idleTimer.unref?.();

    ws.on("close", onIdleClose);
    ws.on("error", onIdleError);
    ws.on("message", onIdleMessage);
    ws.on("pong", onIdlePong);

    shared.idle = {
      ws,
      outpostId,
      pingTimer,
      idleTimer,
      tokenRefreshTimer,
      onIdleClose,
      onIdleError,
      onIdleMessage,
      onIdlePong,
    };
  }

  private borrowSharedWs(shared: SharedSlotWs): StandbyWsHandle {
    if (shared.idle) {
      const h = shared.idle;
      shared.idle = undefined;
      this.detachParkedWs(h, false);
    }
    this.detachBorrowedListeners(shared);
    shared.borrowed = true;
    const onBorrowedClose = () => this.handlePrimaryDead(shared, "closed", true);
    const onBorrowedError = () => this.handlePrimaryDead(shared, "error", true);
    shared.onBorrowedClose = onBorrowedClose;
    shared.onBorrowedError = onBorrowedError;
    shared.handle.ws.on("close", onBorrowedClose);
    shared.handle.ws.on("error", onBorrowedError);
    return shared.handle;
  }

  /**
   * Immediately closes parked WebSockets and drops warm threads for `slotId`,
   * bumping its generation so in-flight turns started before this change will not park stale sockets.
   * When `opts.keepStandby` is true (e.g. only `chatAgentId` or agent instructions changed),
   * healthy primary/standby sockets are preserved because `session_connect` does not bind `chat_agent_id`.
   */
  invalidateSlot(slotId: string, opts?: { keepStandby?: boolean }): number {
    this.slotGeneration.set(slotId, (this.slotGeneration.get(slotId) || 0) + 1);
    let invalidated = 0;
    let closedParked = 0;
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.slotId !== slotId) continue;
      if (entry.parkedWs) closedParked += 1;
      this.removeEntry(entry, true);
      invalidated += 1;
    }
    if (opts?.keepStandby) {
      // Primary shared WS stays open as a clean standby (its old warm entries were just purged above).
      const primary = this.primaryBySlot.get(slotId);
      if (primary && !primary.borrowed && primary.handle.ws.readyState === WebSocket.OPEN) {
        this.attachPrimaryIdleWatchdog(primary);
      }
    } else {
      this.cancelPendingStandbyDial(slotId);
      const primary = this.primaryBySlot.get(slotId);
      if (primary) {
        if (primary.borrowed) {
          // Never kill an active in-flight streaming WebSocket: detach it so the live turn finishes
          // cleanly and refuses to park via `slotGeneration`.
          primary.deadHandled = true;
          this.primaryBySlot.delete(slotId);
          this.detachBorrowedListeners(primary);
          this.purgeIncognitoEntriesForSharedWs(primary.wsId);
        } else {
          this.handlePrimaryDead(primary, "closed", false);
          closedParked += 1;
        }
        invalidated += 1;
      }
      if (this.evictOverflowStandbyForSlot(slotId) > 0) {
        closedParked += 1;
        invalidated += 1;
      }
    }
    if (closedParked > 0) {
      this.evictSettlingUntilBySlot.set(
        slotId,
        Math.max(this.evictSettlingUntilBySlot.get(slotId) || 0, Date.now() + 150),
      );
    }
    return invalidated;
  }

  /**
   * Invalidates warm threads and parked WebSockets across all slots (e.g. when global
   * `chatAgentId`, `sanitizeClientSystemPrompt`, or `incognitoMode` changes).
   * When `opts.keepStandby` is true, healthy primary/standby sockets are kept open as clean
   * standbys (with all old warm thread entries purged) so cold-start latency stays 0ms.
   */
  invalidateAll(opts?: { keepStandby?: boolean }): number {
    this.globalGeneration += 1;
    let invalidated = 0;
    const closedSlots = new Set<string>();
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.parkedWs) closedSlots.add(entry.slotId);
      this.removeEntry(entry, true);
      invalidated += 1;
    }
    if (opts?.keepStandby) {
      for (const primary of this.primaryBySlot.values()) {
        if (!primary.borrowed && primary.handle.ws.readyState === WebSocket.OPEN) {
          this.attachPrimaryIdleWatchdog(primary);
        }
      }
    } else {
      for (const [sid, primary] of Array.from(this.primaryBySlot.entries())) {
        if (primary.borrowed) {
          primary.deadHandled = true;
          this.primaryBySlot.delete(sid);
          this.detachBorrowedListeners(primary);
          this.purgeIncognitoEntriesForSharedWs(primary.wsId);
        } else {
          this.handlePrimaryDead(primary, "closed", false);
          closedSlots.add(sid);
        }
        invalidated += 1;
      }
      for (const [sid, st] of this.standbyBySlot.entries()) {
        st.deadHandled = true;
        this.standbyBySlot.delete(sid);
        this.detachParkedWs(st.parked, true);
        closedSlots.add(sid);
        invalidated += 1;
      }
    }
    const settleUntil = Date.now() + 150;
    for (const sid of closedSlots) {
      this.evictSettlingUntilBySlot.set(sid, Math.max(this.evictSettlingUntilBySlot.get(sid) || 0, settleUntil));
    }
    return invalidated;
  }

  /**
   * Migrates warm threads, primary shared sockets, standby sockets, and active WS accounting when an
   * OAuth account's single-use refresh token rotates (same account, new `slotId`).
   */
  rekeySlot(oldSlotId: string, newSlotId: string): void {
    if (!oldSlotId || !newSlotId || oldSlotId === newSlotId) return;
    const oldMarker = `|${oldSlotId}|`;
    const newMarker = `|${newSlotId}|`;
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.slotId !== oldSlotId) continue;
      for (const k of entry.siblingKeys) {
        if (this.warmThreads.get(k) === entry) this.warmThreads.delete(k);
      }
      entry.slotId = newSlotId;
      entry.siblingKeys = entry.siblingKeys.map((k) => k.replace(oldMarker, newMarker));
      if (entry.editKey) {
        entry.editKey = entry.editKey.replace(oldMarker, newMarker);
      }
      for (const k of entry.siblingKeys) {
        this.warmThreads.set(k, entry);
      }
    }
    const primary = this.primaryBySlot.get(oldSlotId);
    if (primary) {
      this.primaryBySlot.delete(oldSlotId);
      const prevNew = this.primaryBySlot.get(newSlotId);
      if (prevNew) this.handlePrimaryDead(prevNew, "closed", false);
      primary.slotId = newSlotId;
      this.primaryBySlot.set(newSlotId, primary);
    }
    const standby = this.standbyBySlot.get(oldSlotId);
    if (standby) {
      this.standbyBySlot.delete(oldSlotId);
      const prevNew = this.standbyBySlot.get(newSlotId);
      if (prevNew) {
        prevNew.deadHandled = true;
        this.detachParkedWs(prevNew.parked, true);
      }
      standby.slotId = newSlotId;
      this.standbyBySlot.set(newSlotId, standby);
    }
    if (this.standbyPendingSlots.delete(oldSlotId)) {
      this.standbyPendingSlots.add(newSlotId);
    }
    const cancelFn = this.standbyPendingCancels.get(oldSlotId);
    if (cancelFn) {
      this.standbyPendingCancels.delete(oldSlotId);
      if (!this.standbyPendingCancels.has(newSlotId)) {
        this.standbyPendingCancels.set(newSlotId, cancelFn);
      }
    }
    const active = this.activeWsBySlot.get(oldSlotId);
    if (active) {
      this.activeWsBySlot.delete(oldSlotId);
      this.activeWsBySlot.set(newSlotId, (this.activeWsBySlot.get(newSlotId) || 0) + active);
    }
    const settle = this.evictSettlingUntilBySlot.get(oldSlotId);
    if (settle) {
      this.evictSettlingUntilBySlot.delete(oldSlotId);
      this.evictSettlingUntilBySlot.set(newSlotId, Math.max(this.evictSettlingUntilBySlot.get(newSlotId) || 0, settle));
    }
    const gen = this.slotGeneration.get(oldSlotId);
    if (gen !== undefined) {
      this.slotGeneration.delete(oldSlotId);
      this.slotGeneration.set(newSlotId, Math.max(this.slotGeneration.get(newSlotId) || 0, gen));
    }
  }

  private warmKey(
    scope: string | undefined,
    conversationKey: string | undefined,
    slotId: string,
    isIncognito: boolean,
    prefixHash: string,
    chatAgentId?: string,
  ): string {
    const rawAgent = (chatAgentId || "").trim();
    const slash = rawAgent.lastIndexOf("/");
    const normAgent = slash >= 0 && slash < rawAgent.length - 1 ? rawAgent.slice(slash + 1) : rawAgent;
    return `${scope || "default"}|${conversationKey || "-"}|${slotId}|${isIncognito ? "inc" : "cld"}|${normAgent || "-"}|${prefixHash}`;
  }

  private detachParkedWs(handle: ParkedWsHandle, closeSocket: boolean): void {
    clearInterval(handle.pingTimer);
    clearTimeout(handle.idleTimer);
    if (handle.tokenRefreshTimer) clearInterval(handle.tokenRefreshTimer);
    handle.ws.off("close", handle.onIdleClose);
    handle.ws.off("error", handle.onIdleError);
    handle.ws.off("message", handle.onIdleMessage);
    handle.ws.off("pong", handle.onIdlePong);
    if (closeSocket) {
      handle.ws.on("error", () => {});
      try {
        handle.ws.close();
      } catch { }
    }
  }

  private removeEntry(entry: WarmThreadEntry, closeSocket: boolean): void {
    for (const k of entry.siblingKeys) {
      if (this.warmThreads.get(k) === entry) {
        this.warmThreads.delete(k);
      }
    }
    if (entry.parkedWs) {
      const h = entry.parkedWs;
      entry.parkedWs = undefined;
      this.detachParkedWs(h, closeSocket);
    }
  }

  trackActiveWsStart(slotId: string): void {
    this.activeWsBySlot.set(slotId, (this.activeWsBySlot.get(slotId) || 0) + 1);
  }

  trackActiveWsEnd(slotId: string): void {
    const nextActive = (this.activeWsBySlot.get(slotId) || 1) - 1;
    if (nextActive <= 0) this.activeWsBySlot.delete(slotId);
    else this.activeWsBySlot.set(slotId, nextActive);
  }

  getActiveWsCount(slotId: string): number {
    return this.activeWsBySlot.get(slotId) || 0;
  }

  /** Counts dedicated per-conversation parked WebSockets (excluding Primary Shared WS). */
  countParkedWs(): number {
    const seen = new Set<WarmThreadEntry>();
    let n = 0;
    for (const entry of this.warmThreads.values()) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      if (entry.parkedWs && entry.parkedWs.ws.readyState === WebSocket.OPEN) n += 1;
    }
    return n;
  }

  /** Counts dedicated per-conversation parked WebSockets for `slotId`. */
  countParkedWsForSlot(slotId: string): number {
    const seen = new Set<WarmThreadEntry>();
    let n = 0;
    for (const entry of this.warmThreads.values()) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      if (entry.slotId === slotId && entry.parkedWs && entry.parkedWs.ws.readyState === WebSocket.OPEN) {
        n += 1;
      }
    }
    return n;
  }

  /**
   * Counts logical warm conversations currently backed by an OPEN WebSocket (either a Primary Shared WS
   * or a dedicated auxiliary parked WS).
   */
  countWarmBackedSessions(): number {
    const seen = new Set<WarmThreadEntry>();
    let n = 0;
    for (const entry of this.warmThreads.values()) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      if (entry.parkedWs && entry.parkedWs.ws.readyState === WebSocket.OPEN) {
        n += 1;
      } else if (entry.sharedWsId !== undefined) {
        const p = this.primaryBySlot.get(entry.slotId);
        if (p && p.wsId === entry.sharedWsId && p.handle.ws.readyState === WebSocket.OPEN) {
          n += 1;
        }
      }
    }
    return n;
  }

  private hasOpenOverflowStandby(slotId: string, isIncognito?: boolean): boolean {
    const entry = this.standbyBySlot.get(slotId);
    if (!entry) return false;
    if (entry.ws.readyState !== WebSocket.OPEN) return false;
    if (isIncognito !== undefined && entry.isIncognito !== isIncognito) return false;
    return true;
  }

  private hasIdlePrimary(slotId: string, isIncognito?: boolean): boolean {
    const p = this.primaryBySlot.get(slotId);
    if (!p || p.borrowed || p.deadHandled) return false;
    if (p.handle.ws.readyState !== WebSocket.OPEN) return false;
    if (isIncognito !== undefined && p.isIncognito !== isIncognito) return false;
    return true;
  }

  /** True when `slotId` has an immediately borrowable open WS (idle Primary Shared WS or overflow Standby WS). */
  hasOpenStandby(slotId: string, isIncognito?: boolean): boolean {
    return this.hasIdlePrimary(slotId, isIncognito) || this.hasOpenOverflowStandby(slotId, isIncognito);
  }

  /**
   * True when `slotId` already owns a live open Primary Shared WS (even while momentarily borrowed by an
   * in-flight turn) or an open overflow Standby WS. Used to avoid dialing redundant duplicate standby WS
   * while the slot's Primary Shared WS is about to return to idle in ~1.5s.
   */
  hasLivePrimaryOrStandby(slotId: string, isIncognito?: boolean): boolean {
    if (this.hasOpenOverflowStandby(slotId, isIncognito)) return true;
    const p = this.primaryBySlot.get(slotId);
    if (!p || p.deadHandled) return false;
    if (p.handle.ws.readyState !== WebSocket.OPEN) return false;
    if (isIncognito !== undefined && p.isIncognito !== isIncognito) return false;
    return true;
  }

  countStandbyWs(): number {
    const readySlots = new Set<string>();
    for (const [sid, p] of this.primaryBySlot.entries()) {
      if (!p.borrowed && !p.deadHandled && p.handle.ws.readyState === WebSocket.OPEN) {
        readySlots.add(sid);
      }
    }
    for (const [sid, st] of this.standbyBySlot.entries()) {
      if (!st.deadHandled && st.ws.readyState === WebSocket.OPEN) {
        readySlots.add(sid);
      }
    }
    return readySlots.size;
  }

  /** Exact count of physical OPEN idle WebSockets held for `slotId` (for strict AWS 5-WS headroom). */
  countIdleWsForSlot(slotId: string): number {
    return (
      this.countParkedWsForSlot(slotId) +
      (this.hasIdlePrimary(slotId) ? 1 : 0) +
      (this.hasOpenOverflowStandby(slotId) ? 1 : 0)
    );
  }

  tryClaimStandbyDial(slotId: string): boolean {
    if (this.standbyPendingSlots.has(slotId)) return false;
    this.standbyPendingSlots.add(slotId);
    return true;
  }

  hasPendingStandbyDial(slotId: string): boolean {
    return this.standbyPendingSlots.has(slotId);
  }

  registerStandbyCancel(slotId: string, cancelFn: () => void): void {
    this.standbyPendingCancels.set(slotId, cancelFn);
  }

  cancelPendingStandbyDial(slotId: string): boolean {
    const cancelFn = this.standbyPendingCancels.get(slotId);
    if (!cancelFn) return false;
    this.standbyPendingCancels.delete(slotId);
    try {
      cancelFn();
    } catch { }
    return true;
  }

  releaseStandbyDial(slotId: string): void {
    this.standbyPendingSlots.delete(slotId);
    this.standbyPendingCancels.delete(slotId);
  }

  private evictOverflowStandbyForSlot(slotId: string): number {
    const entry = this.standbyBySlot.get(slotId);
    if (!entry) return 0;
    entry.deadHandled = true;
    this.standbyBySlot.delete(slotId);
    this.detachParkedWs(entry.parked, true);
    this.evictSettlingUntilBySlot.set(
      slotId,
      Math.max(this.evictSettlingUntilBySlot.get(slotId) || 0, Date.now() + 150),
    );
    return 1;
  }

  evictStandbyWsForSlot(slotId: string): number {
    const overflowEvicted = this.evictOverflowStandbyForSlot(slotId);
    if (overflowEvicted > 0) return overflowEvicted;
    const primary = this.primaryBySlot.get(slotId);
    // Only treat an idle primary with 0 warm threads as a plain disposable standby here.
    if (primary && !primary.borrowed && this.countWarmEntriesForSharedWs(primary.wsId) === 0) {
      this.handlePrimaryDead(primary, "closed", false);
      this.evictSettlingUntilBySlot.set(
        slotId,
        Math.max(this.evictSettlingUntilBySlot.get(slotId) || 0, Date.now() + 150),
      );
      return 1;
    }
    return 0;
  }

  /**
   * Stores a pre-warmed, `session_established` WebSocket ready for instant cold-turn adoption
   * (becoming the slot's Primary Shared WS if none exists yet, or an overflow Standby WS otherwise).
   */
  storeStandby(params: {
    slotId: string;
    isIncognito: boolean;
    expectedGeneration?: number;
    activeInflightOverride?: number;
    handle: StandbyWsHandle;
    apiKey?: string;
    proxyUrl?: string;
  }): boolean {
    const { slotId, isIncognito, expectedGeneration, activeInflightOverride, handle, apiKey, proxyUrl } = params;
    const { ws, outpostId, encodeFrame } = handle;
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (expectedGeneration !== undefined && expectedGeneration !== this.getSlotGeneration(slotId)) {
      return false;
    }
    const effectiveActive = Math.max(this.getActiveWsCount(slotId), activeInflightOverride || 0);
    if (effectiveActive + this.countIdleWsForSlot(slotId) > 3) {
      return false;
    }

    // Prefer populating the slot's Primary Shared WS slot first.
    const existingPrimary = this.primaryBySlot.get(slotId);
    if (!existingPrimary || existingPrimary.deadHandled || existingPrimary.handle.ws.readyState !== WebSocket.OPEN) {
      if (existingPrimary) this.handlePrimaryDead(existingPrimary, "closed", false);
      while (this.countStandbyWs() >= MAX_STANDBY_WS_GLOBAL) {
        let evictedGlobal = false;
        for (const p of this.primaryBySlot.values()) {
          if (!p.borrowed && this.countWarmEntriesForSharedWs(p.wsId) === 0) {
            this.handlePrimaryDead(p, "closed", false);
            evictedGlobal = true;
            break;
          }
        }
        if (!evictedGlobal) {
          const oldestOverflow = this.standbyBySlot.keys().next().value;
          if (!oldestOverflow) break;
          this.evictOverflowStandbyForSlot(oldestOverflow);
        }
      }
      const shared: SharedSlotWs = {
        wsId: ++this.nextWsId,
        slotId,
        isIncognito,
        borrowed: false,
        handle,
        apiKey,
        proxyUrl,
        deadHandled: false,
      };
      this.primaryBySlot.set(slotId, shared);
      this.attachPrimaryIdleWatchdog(shared);
      return true;
    }

    // Slot already has a live primary (e.g. currently borrowed); store as overflow standby.
    const existing = this.standbyBySlot.get(slotId);
    if (existing) {
      existing.deadHandled = true;
      this.standbyBySlot.delete(slotId);
      this.detachParkedWs(existing.parked, true);
    }
    while (this.countStandbyWs() >= MAX_STANDBY_WS_GLOBAL) {
      const oldestSid = this.standbyBySlot.keys().next().value;
      if (!oldestSid) break;
      this.evictOverflowStandbyForSlot(oldestSid);
    }

    let entryRef: InternalStandbyEntry | undefined;
    const handleDeadStandby = (reason: StandbyRemovalReason) => {
      if (!entryRef || entryRef.deadHandled) return;
      entryRef.deadHandled = true;
      const activeSlotId = entryRef.slotId;
      const wasActive = this.standbyBySlot.get(activeSlotId) === entryRef;
      if (wasActive) {
        this.standbyBySlot.delete(activeSlotId);
      }
      this.detachParkedWs(entryRef.parked, true);
      if (wasActive && !this.hasLivePrimaryOrStandby(activeSlotId, entryRef.isIncognito)) {
        this.onStandbyRemoved?.(activeSlotId, reason);
      }
    };
    const onIdleClose = () => handleDeadStandby("closed");
    const onIdleError = () => handleDeadStandby("error");
    let missedPongs = 0;
    const onIdleMessage = () => {
      missedPongs = 0;
    };
    const onIdlePong = () => {
      missedPongs = 0;
    };

    const pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        handleDeadStandby("closed");
        return;
      }
      if (missedPongs >= 2) {
        try {
          ws.terminate();
        } catch { }
        handleDeadStandby("pong_timeout");
        return;
      }
      missedPongs += 1;
      try {
        ws.ping();
        ws.send(encodeFrame({ type: "ping", payload: { timestamp: Date.now() } }));
      } catch {
        handleDeadStandby("error");
      }
    }, 15_000);
    pingTimer.unref?.();

    let tokenRefreshTimer: NodeJS.Timeout | undefined;
    const parsedForRefresh = apiKey ? parseQuickCredential(apiKey) : undefined;
    if (parsedForRefresh?.mode === "oauth" && parsedForRefresh.oauth) {
      const oauthCred = parsedForRefresh.oauth;
      tokenRefreshTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || !entryRef || this.standbyBySlot.get(entryRef.slotId) !== entryRef) {
          handleDeadStandby("closed");
          return;
        }
        void resolveOAuthAccessToken(oauthCred, false, proxyUrl)
          .then(({ accessToken }) => {
            if (ws.readyState === WebSocket.OPEN && entryRef && this.standbyBySlot.get(entryRef.slotId) === entryRef) {
              ws.send(encodeFrame({ type: "token_refresh", token: accessToken }));
            }
          })
          .catch(() => {
            handleDeadStandby("token_refresh_failed");
          });
      }, PARKED_WS_TOKEN_REFRESH_MS);
      tokenRefreshTimer.unref?.();
    }

    const idleTimer = setTimeout(() => handleDeadStandby("expired"), this.standbyTtlMs);
    idleTimer.unref?.();

    ws.on("close", onIdleClose);
    ws.on("error", onIdleError);
    ws.on("message", onIdleMessage);
    ws.on("pong", onIdlePong);

    entryRef = {
      ...handle,
      slotId,
      isIncognito,
      deadHandled: false,
      parked: {
        ws,
        outpostId,
        pingTimer,
        idleTimer,
        tokenRefreshTimer,
        onIdleClose,
        onIdleError,
        onIdleMessage,
        onIdlePong,
      },
    };
    this.standbyBySlot.set(slotId, entryRef);
    return true;
  }

  /**
   * Borrows an open pre-warmed WebSocket for a cold turn (preferring overflow standby if present,
   * otherwise borrowing the slot's Primary Shared WS in 0ms while keeping all its warm threads intact!).
   */
  takeStandby(slotId: string, isIncognito: boolean): StandbyWsHandle | undefined {
    const overflow = this.standbyBySlot.get(slotId);
    if (overflow && overflow.isIncognito === isIncognito) {
      overflow.deadHandled = true;
      this.standbyBySlot.delete(slotId);
      if (overflow.ws.readyState === WebSocket.OPEN) {
        this.detachParkedWs(overflow.parked, false);
        const { slotId: _s, isIncognito: _i, parked: _p, deadHandled: _d, ...handle } = overflow;
        return handle;
      }
      this.detachParkedWs(overflow.parked, true);
    }

    const primary = this.primaryBySlot.get(slotId);
    if (!primary || primary.deadHandled || primary.borrowed || primary.isIncognito !== isIncognito) {
      return undefined;
    }
    if (primary.handle.ws.readyState !== WebSocket.OPEN) {
      this.handlePrimaryDead(primary, "closed", true);
      return undefined;
    }
    return this.borrowSharedWs(primary);
  }

  /**
   * Returns `true` if `ws` is currently the slot's active Primary Shared WS.
   */
  isPrimarySharedWs(slotId: string, ws: WebSocket): boolean {
    const primary = this.primaryBySlot.get(slotId);
    return Boolean(primary && !primary.deadHandled && primary.handle.ws === ws);
  }

  /**
   * Returns an untouched borrowed Primary Shared WS back to idle when a request aborts or fails
   * during pre-send setup (e.g., OOB upload error) BEFORE any frame was written to the socket,
   * or after an in-flight turn cleanly finishes/aborts on the server.
   * Returns `true` if reclaimed (caller MUST NOT close `ws`), or `false` if caller should close `ws`.
   */
  releaseUntouchedWs(slotId: string, ws: WebSocket): boolean {
    const primary = this.primaryBySlot.get(slotId);
    if (!primary || primary.deadHandled || !primary.borrowed || primary.handle.ws !== ws) {
      return false;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      this.handlePrimaryDead(primary, "closed", true);
      return false;
    }
    this.attachPrimaryIdleWatchdog(primary);
    return true;
  }

  /**
   * Evicts up to `maxEvict` dedicated conversation-bound parked WebSockets for `slotId`
   * (NEVER touching `primaryBySlot` or `standbyBySlot`).
   * Prioritizes evicting lower-priority sessions (e.g. tiny 1-turn helpers) before heavy multi-turn sessions.
   */
  private evictConversationParkedWsForSlot(slotId: string, maxEvict = 1): number {
    let evicted = 0;
    const candidates: WarmThreadEntry[] = [];
    const seen = new Set<WarmThreadEntry>();
    for (const existing of this.warmThreads.values()) {
      if (seen.has(existing)) continue;
      seen.add(existing);
      if (existing.slotId === slotId && existing.parkedWs) {
        candidates.push(existing);
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    for (const existing of candidates) {
      if (evicted >= maxEvict) break;
      const oldHandle = existing.parkedWs;
      if (!oldHandle) continue;
      existing.parkedWs = undefined;
      this.detachParkedWs(oldHandle, true);
      if (existing.isIncognito) this.removeEntry(existing, false);
      evicted += 1;
    }
    if (evicted > 0) {
      this.evictSettlingUntilBySlot.set(slotId, Math.max(this.evictSettlingUntilBySlot.get(slotId) || 0, Date.now() + 150));
    }
    return evicted;
  }

  evictParkedWsForSlot(slotId: string, maxEvict = 1): number {
    let evicted = 0;
    // 1. Evict pure standby sockets FIRST (overflow standby, or idle primary with 0 warm threads)
    if (evicted < maxEvict) {
      evicted += this.evictStandbyWsForSlot(slotId);
    }
    // 2. Evict dedicated auxiliary parked sockets (lowest priority first)
    if (evicted < maxEvict) {
      evicted += this.evictConversationParkedWsForSlot(slotId, maxEvict - evicted);
    }
    // 3. Last resort (only when active streams really need the 5th slot): evict idle primary shared WS
    if (evicted < maxEvict) {
      const primary = this.primaryBySlot.get(slotId);
      if (primary && !primary.borrowed) {
        this.handlePrimaryDead(primary, "closed", false);
        this.evictSettlingUntilBySlot.set(slotId, Math.max(this.evictSettlingUntilBySlot.get(slotId) || 0, Date.now() + 150));
        evicted += 1;
      }
    }
    return evicted;
  }

  getEvictSettlingRemainingMs(slotId: string): number {
    const until = this.evictSettlingUntilBySlot.get(slotId) || 0;
    const rem = until - Date.now();
    if (rem <= 0) {
      this.evictSettlingUntilBySlot.delete(slotId);
      return 0;
    }
    return rem;
  }

  lookup(
    scope: string | undefined,
    conversationKey: string | undefined,
    slotId: string,
    isIncognito: boolean,
    prefixHash: string,
    chatAgentId?: string,
  ): WarmLookupResult | undefined {
    const key = this.warmKey(scope, conversationKey, slotId, isIncognito, prefixHash, chatAgentId);
    const hit = this.warmThreads.get(key);
    if (!hit) return undefined;

    const isEditMatch = Boolean(hit.editKey && hit.editKey === key && hit.lastUserMessageId);

    if (Date.now() > hit.expiresAt) {
      for (const k of hit.siblingKeys) {
        if (this.warmThreads.get(k) === hit) this.warmThreads.delete(k);
      }
      if (hit.parkedWs) {
        this.detachParkedWs(hit.parkedWs, true);
        hit.parkedWs = undefined;
      }
      return undefined;
    }

    // Path A: Backed by the slot's Primary Shared WS (Single-WS Serial Borrow/Return)
    if (hit.sharedWsId !== undefined) {
      const primary = this.primaryBySlot.get(hit.slotId);
      if (primary && primary.wsId === hit.sharedWsId && !primary.deadHandled) {
        if (primary.handle.ws.readyState !== WebSocket.OPEN) {
          for (const k of hit.siblingKeys) {
            if (this.warmThreads.get(k) === hit) this.warmThreads.delete(k);
          }
          this.handlePrimaryDead(primary, "closed", true);
        } else if (primary.borrowed) {
          // Primary WS is momentarily borrowed by another concurrent turn on this slot.
          // CRITICAL: Do NOT delete `hit.siblingKeys` — preserve the warm entry so the next
          // non-colliding turn can still hit warm once the primary WS is returned!
          if (isIncognito) {
            return undefined;
          }
          return {
            threadId: hit.threadId,
            rootThreadId: hit.rootThreadId || hit.threadId,
            ...(isEditMatch ? { editOriginalMessageId: hit.lastUserMessageId } : {}),
          };
        } else {
          // Atomically consume this entry + any alias keys before borrowing the primary WS.
          for (const k of hit.siblingKeys) {
            if (this.warmThreads.get(k) === hit) this.warmThreads.delete(k);
          }
          const borrowed = this.borrowSharedWs(primary);
          return {
            threadId: hit.threadId,
            rootThreadId: hit.rootThreadId || hit.threadId,
            reusedWs: borrowed.ws,
            reusedOutpostId: borrowed.outpostId,
            ...(isEditMatch ? { editOriginalMessageId: hit.lastUserMessageId } : {}),
          };
        }
      } else {
        for (const k of hit.siblingKeys) {
          if (this.warmThreads.get(k) === hit) this.warmThreads.delete(k);
        }
      }
      if (isIncognito) {
        return undefined;
      }
      return {
        threadId: hit.threadId,
        rootThreadId: hit.rootThreadId || hit.threadId,
        ...(isEditMatch ? { editOriginalMessageId: hit.lastUserMessageId } : {}),
      };
    }

    // Atomically consume this entry + any alias keys so concurrent duplicate requests can never share a dedicated WS.
    for (const k of hit.siblingKeys) {
      if (this.warmThreads.get(k) === hit) this.warmThreads.delete(k);
    }

    // Path B: Backed by a dedicated auxiliary parked WS
    if (hit.parkedWs) {
      const h = hit.parkedWs;
      hit.parkedWs = undefined;
      if (h.ws.readyState === WebSocket.OPEN) {
        this.detachParkedWs(h, false);
        return {
          threadId: hit.threadId,
          rootThreadId: hit.rootThreadId || hit.threadId,
          reusedWs: h.ws,
          reusedOutpostId: h.outpostId,
          ...(isEditMatch ? { editOriginalMessageId: hit.lastUserMessageId } : {}),
        };
      }
      this.detachParkedWs(h, true);
    }

    if (isIncognito) {
      return undefined;
    }
    return {
      threadId: hit.threadId,
      rootThreadId: hit.rootThreadId || hit.threadId,
      ...(isEditMatch ? { editOriginalMessageId: hit.lastUserMessageId } : {}),
    };
  }

  private enforceSharedWsThreadCap(wsId: number): void {
    const entries: WarmThreadEntry[] = [];
    const seen = new Set<WarmThreadEntry>();
    for (const e of this.warmThreads.values()) {
      if (seen.has(e)) continue;
      seen.add(e);
      if (e.sharedWsId === wsId) entries.push(e);
    }
    if (entries.length < MAX_THREADS_PER_SHARED_WS) return;
    // Evict lowest-priority oldest metadata entries first (ZERO sockets closed!).
    entries.sort((a, b) => a.priority - b.priority || a.expiresAt - b.expiresAt);
    const excess = entries.length - MAX_THREADS_PER_SHARED_WS + 1;
    for (let i = 0; i < excess; i += 1) {
      this.removeEntry(entries[i]!, false);
    }
  }

  park(params: {
    scope: string | undefined;
    conversationKey: string | undefined;
    slotId: string;
    isIncognito: boolean;
    chatAgentId?: string;
    expectedGeneration?: number;
    prefixHashes: readonly string[];
    editPrefixHash?: string;
    lastUserMessageId?: string;
    threadId: string;
    rootThreadId?: string;
    ws?: WebSocket;
    outpostId?: string;
    encodeFrame?: QuickFrameEncoder;
    sharedHandleMeta?: SharedHandleMeta;
    apiKey?: string;
    proxyUrl?: string;
    lastAckSeq?: string;
    priority?: number;
  }): boolean {
    const {
      scope,
      conversationKey,
      slotId,
      isIncognito,
      chatAgentId,
      expectedGeneration,
      prefixHashes,
      editPrefixHash,
      lastUserMessageId,
      threadId,
      rootThreadId,
      ws,
      outpostId,
      encodeFrame,
      sharedHandleMeta,
      apiKey,
      proxyUrl,
      lastAckSeq,
      priority,
    } = params;
    // Race guard: if the slot's agent/settings were hot-updated while this turn was in flight,
    // refuse to park the stale-agent thread or WebSocket so the caller closes it cleanly.
    if (expectedGeneration !== undefined && expectedGeneration !== this.getSlotGeneration(slotId)) {
      return false;
    }
    const keys = Array.from(
      new Set(prefixHashes.filter(Boolean).map((h) => this.warmKey(scope, conversationKey, slotId, isIncognito, h, chatAgentId))),
    );
    if (keys.length === 0) return false;
    const rawEditKey =
      editPrefixHash && lastUserMessageId
        ? this.warmKey(scope, conversationKey, slotId, isIncognito, editPrefixHash, chatAgentId)
        : undefined;
    const uniqueEditKey = rawEditKey && !keys.includes(rawEditKey) ? rawEditKey : undefined;
    const allKeys = uniqueEditKey ? [...keys, uniqueEditKey] : keys;

    const now = Date.now();

    // Evict expired entries first, then oldest entries if over capacity.
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.expiresAt <= now) this.removeEntry(entry, true);
    }
    while (this.warmThreads.size >= this.maxWarmSessions) {
      const oldestKey = this.warmThreads.keys().next().value;
      if (!oldestKey) break;
      const oldestEntry = this.warmThreads.get(oldestKey);
      if (oldestEntry) this.removeEntry(oldestEntry, true);
      else this.warmThreads.delete(oldestKey);
    }

    // Replace any existing entry on these keys cleanly
    for (const k of allKeys) {
      const prev = this.warmThreads.get(k);
      if (prev) this.removeEntry(prev, true);
    }

    const entry: WarmThreadEntry = {
      slotId,
      threadId,
      rootThreadId: rootThreadId || threadId,
      isIncognito,
      expiresAt: now + this.warmSessionTtlMs,
      priority: priority ?? 1,
      siblingKeys: allKeys,
      ...(uniqueEditKey && lastUserMessageId ? { editKey: uniqueEditKey, lastUserMessageId } : {}),
    };

    const existingPrimary = this.primaryBySlot.get(slotId);

    // Case 1: Returning this slot's borrowed Primary Shared WS!
    // Adds ZERO new physical WebSockets and keeps all sibling warm threads on this WS alive.
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      existingPrimary &&
      !existingPrimary.deadHandled &&
      existingPrimary.handle.ws === ws
    ) {
      this.enforceSharedWsThreadCap(existingPrimary.wsId);
      entry.sharedWsId = existingPrimary.wsId;
      for (const k of allKeys) {
        this.warmThreads.set(k, entry);
      }
      if (lastAckSeq) existingPrimary.lastAckSeq = lastAckSeq;
      if (apiKey) existingPrimary.apiKey = apiKey;
      if (proxyUrl !== undefined) existingPrimary.proxyUrl = proxyUrl;
      this.attachPrimaryIdleWatchdog(existingPrimary);
      return true;
    }

    const activeOnSlot = this.activeWsBySlot.get(slotId) || 0;

    // Case 2: Promoting a newly dialed live WS into the slot's Primary Shared WS (when none exists yet).
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      encodeFrame &&
      sharedHandleMeta &&
      (!existingPrimary || existingPrimary.deadHandled || existingPrimary.handle.ws.readyState !== WebSocket.OPEN) &&
      activeOnSlot + this.countIdleWsForSlot(slotId) <= 4
    ) {
      if (existingPrimary) this.handlePrimaryDead(existingPrimary, "closed", false);
      const shared: SharedSlotWs = {
        wsId: ++this.nextWsId,
        slotId,
        isIncognito,
        borrowed: false,
        handle: {
          ws,
          outpostId: outpostId || "web0",
          encodeFrame,
          decodeFrame: sharedHandleMeta.decodeFrame,
          surfaceType: sharedHandleMeta.surfaceType,
          appVersion: sharedHandleMeta.appVersion,
          surfaceName: sharedHandleMeta.surfaceName,
          ...(sharedHandleMeta.actorArn ? { actorArn: sharedHandleMeta.actorArn } : {}),
        },
        apiKey,
        proxyUrl,
        lastAckSeq,
        deadHandled: false,
      };
      this.primaryBySlot.set(slotId, shared);
      entry.sharedWsId = shared.wsId;
      for (const k of allKeys) {
        this.warmThreads.set(k, entry);
      }
      this.attachPrimaryIdleWatchdog(shared);
      return true;
    }

    // Case 3: Dedicated auxiliary parked socket (e.g., concurrent burst turn while Primary Shared WS was busy).
    let parkedSocket = false;
    if (ws && ws.readyState === WebSocket.OPEN && encodeFrame && activeOnSlot + this.countIdleWsForSlot(slotId) > 4) {
      this.evictOverflowStandbyForSlot(slotId);
    }
    const primaryHoldsWarmThreads = Boolean(
      existingPrimary && !existingPrimary.deadHandled && this.countWarmEntriesForSharedWs(existingPrimary.wsId) > 0,
    );
    const auxCap = primaryHoldsWarmThreads ? MAX_AUX_PARKED_WS_WHEN_PRIMARY_WARM : MAX_PARKED_WS_PER_SLOT;
    const allowParkUnderLoad = activeOnSlot + this.countIdleWsForSlot(slotId) <= 4;
    if (ws && ws.readyState === WebSocket.OPEN && encodeFrame && allowParkUnderLoad) {
      while (this.countParkedWsForSlot(slotId) >= auxCap) {
        if (this.evictConversationParkedWsForSlot(slotId, 1) === 0) break;
      }
      while (this.countParkedWs() >= this.maxParkedWs) {
        let evicted = false;
        for (const existing of new Set(this.warmThreads.values())) {
          if (existing.parkedWs) {
            const oldHandle = existing.parkedWs;
            existing.parkedWs = undefined;
            this.detachParkedWs(oldHandle, true);
            if (existing.isIncognito) this.removeEntry(existing, false);
            evicted = true;
            break;
          }
        }
        if (!evicted) break;
      }

      const handleDeadIdleWs = () => {
        if (!entry.parkedWs) return;
        const h = entry.parkedWs;
        entry.parkedWs = undefined;
        this.detachParkedWs(h, true);
        if (entry.isIncognito) {
          this.removeEntry(entry, false);
        }
      };

      const onIdleClose = () => handleDeadIdleWs();
      const onIdleError = () => handleDeadIdleWs();
      let missedPongs = 0;
      const onIdleMessage = () => {
        missedPongs = 0;
      };
      const onIdlePong = () => {
        missedPongs = 0;
      };

      const pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          handleDeadIdleWs();
          return;
        }
        if (missedPongs >= 2) {
          try {
            ws.terminate();
          } catch { }
          handleDeadIdleWs();
          return;
        }
        missedPongs += 1;
        try {
          ws.ping();
          ws.send(
            encodeFrame({
              type: "ping",
              payload: { timestamp: Date.now(), ...(lastAckSeq ? { ack: lastAckSeq } : {}) },
            }),
          );
        } catch {
          handleDeadIdleWs();
        }
      }, 25_000);
      pingTimer.unref?.();

      let tokenRefreshTimer: NodeJS.Timeout | undefined;
      const parsedForRefresh = apiKey ? parseQuickCredential(apiKey) : undefined;
      if (parsedForRefresh?.mode === "oauth" && parsedForRefresh.oauth) {
        const oauthCred = parsedForRefresh.oauth;
        tokenRefreshTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN || !entry.parkedWs) {
            handleDeadIdleWs();
            return;
          }
          void resolveOAuthAccessToken(oauthCred, false, proxyUrl)
            .then(({ accessToken }) => {
              if (ws.readyState === WebSocket.OPEN && entry.parkedWs) {
                ws.send(encodeFrame({ type: "token_refresh", token: accessToken }));
              }
            })
            .catch(() => {
              handleDeadIdleWs();
            });
        }, PARKED_WS_TOKEN_REFRESH_MS);
        tokenRefreshTimer.unref?.();
      }

      const idleTtl = this.computeParkedWsIdleTtlMs(apiKey, proxyUrl);
      const idleTimer = setTimeout(() => handleDeadIdleWs(), idleTtl);
      idleTimer.unref?.();

      ws.on("close", onIdleClose);
      ws.on("error", onIdleError);
      ws.on("message", onIdleMessage);
      ws.on("pong", onIdlePong);

      entry.parkedWs = {
        ws,
        outpostId: outpostId || "web0",
        pingTimer,
        idleTimer,
        tokenRefreshTimer,
        onIdleClose,
        onIdleError,
        onIdleMessage,
        onIdlePong,
      };
      parkedSocket = true;
    }

    if (isIncognito && !parkedSocket) {
      return false;
    }

    for (const k of allKeys) {
      this.warmThreads.set(k, entry);
    }
    return parkedSocket;
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.expiresAt <= now) this.removeEntry(entry, true);
    }
    for (const primary of Array.from(this.primaryBySlot.values())) {
      if (primary.handle.ws.readyState !== WebSocket.OPEN) {
        this.handlePrimaryDead(primary, "closed", true);
      }
    }
    for (const [sid, st] of this.standbyBySlot.entries()) {
      if (st.ws.readyState !== WebSocket.OPEN) {
        st.deadHandled = true;
        this.standbyBySlot.delete(sid);
        this.detachParkedWs(st.parked, true);
      }
    }
  }

  disposeAll(): void {
    for (const entry of new Set(this.warmThreads.values())) {
      this.removeEntry(entry, true);
    }
    for (const primary of Array.from(this.primaryBySlot.values())) {
      this.handlePrimaryDead(primary, "closed", false);
    }
    for (const [sid, st] of this.standbyBySlot.entries()) {
      st.deadHandled = true;
      this.standbyBySlot.delete(sid);
      this.detachParkedWs(st.parked, true);
    }
    for (const cancelFn of this.standbyPendingCancels.values()) {
      try {
        cancelFn();
      } catch { }
    }
    this.standbyPendingCancels.clear();
    this.standbyPendingSlots.clear();
  }

  stats(): { warmIncrementalSessions: number; warmIdleSessions: number; standbyWs: number } {
    return {
      warmIncrementalSessions: new Set(this.warmThreads.values()).size,
      warmIdleSessions: this.countWarmBackedSessions(),
      standbyWs: this.countStandbyWs(),
    };
  }
}
