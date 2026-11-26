import WebSocket from "ws";
import { resolveOAuthAccessToken } from "../aws-quick/oauth-client.js";
import { parseQuickCredential } from "../aws-quick/outpost-singleton.js";
import type { QuickFrameEncoder } from "../aws-quick/ws-transport.js";

const WARM_THREAD_TTL_MS = 30 * 60 * 1000;
const PARKED_WS_IDLE_TTL_MS = 15 * 60 * 1000;
const PARKED_WS_TOKEN_REFRESH_MS = 12 * 60 * 1000;
const MAX_WARM_THREADS = 256;
const MIN_PARKED_WS = 64;
// AWS Quick enforces a hard limit of 5 active WebSockets per account (`LimitExceededException`).
// Keep at most 2 idle parked sockets per slot so burst concurrency + retries always have headroom.
export const MAX_PARKED_WS_PER_SLOT = 2;

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
  parkedWs?: ParkedWsHandle;
  siblingKeys: string[];
}

export interface WarmLookupResult {
  threadId: string;
  rootThreadId: string;
  reusedWs?: WebSocket;
  reusedOutpostId?: string;
}

/**
 * Manages dedicated warm AWS Quick threads, parked idle WebSockets (with liveness watchdog,
 * `ping.ack`, and OAuth 12m `token_refresh`), and per-account active WebSocket accounting.
 */
export class WarmSessionPool {
  private readonly maxWarmSessions: number;
  private readonly maxParkedWs: number;
  private readonly warmSessionTtlMs: number;
  private readonly warmThreads = new Map<string, WarmThreadEntry>();
  private readonly activeWsBySlot = new Map<string, number>();
  private readonly evictSettlingUntilBySlot = new Map<string, number>();
  private readonly slotGeneration = new Map<string, number>();
  private globalGeneration = 0;

  constructor(opts: { maxWarmSessions?: number; warmSessionTtlMs?: number }) {
    this.maxWarmSessions = opts.maxWarmSessions || MAX_WARM_THREADS;
    this.maxParkedWs = Math.max(MIN_PARKED_WS, Math.floor(this.maxWarmSessions / 2));
    this.warmSessionTtlMs = opts.warmSessionTtlMs || WARM_THREAD_TTL_MS;
  }

  /**
   * Returns a monotonic generation token for `slotId`. Any change to the slot's
   * `chatAgentId`, published agent instructions, proxy, or global agent/incognito settings
   * bumps this generation so in-flight turns finishing with stale settings refuse to park.
   */
  getSlotGeneration(slotId: string): number {
    return this.globalGeneration + (this.slotGeneration.get(slotId) || 0);
  }

  /**
   * Immediately closes all parked WebSockets and drops all warm threads for `slotId`,
   * bumping its generation so in-flight turns started before this change will not park stale sockets.
   */
  invalidateSlot(slotId: string): number {
    this.slotGeneration.set(slotId, (this.slotGeneration.get(slotId) || 0) + 1);
    let invalidated = 0;
    let closedParked = 0;
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.slotId !== slotId) continue;
      if (entry.parkedWs) closedParked += 1;
      this.removeEntry(entry, true);
      invalidated += 1;
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
   * `chatAgentId` or `incognitoMode` changes).
   */
  invalidateAll(): number {
    this.globalGeneration += 1;
    let invalidated = 0;
    const closedSlots = new Set<string>();
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.parkedWs) closedSlots.add(entry.slotId);
      this.removeEntry(entry, true);
      invalidated += 1;
    }
    const settleUntil = Date.now() + 150;
    for (const sid of closedSlots) {
      this.evictSettlingUntilBySlot.set(sid, Math.max(this.evictSettlingUntilBySlot.get(sid) || 0, settleUntil));
    }
    return invalidated;
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

  evictParkedWsForSlot(slotId: string, maxEvict = 1): number {
    let evicted = 0;
    for (const existing of new Set(this.warmThreads.values())) {
      if (evicted >= maxEvict) break;
      if (existing.slotId !== slotId || !existing.parkedWs) continue;
      const oldHandle = existing.parkedWs;
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

    // Atomically consume this entry + any alias keys so concurrent duplicate requests can never share a WS.
    for (const k of hit.siblingKeys) {
      if (this.warmThreads.get(k) === hit) this.warmThreads.delete(k);
    }

    if (Date.now() > hit.expiresAt) {
      if (hit.parkedWs) {
        this.detachParkedWs(hit.parkedWs, true);
        hit.parkedWs = undefined;
      }
      return undefined;
    }

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
        };
      }
      this.detachParkedWs(h, true);
    }

    // In incognito mode, AWS Quick only keeps the thread in backend-pod RAM: if the dedicated WS died,
    // never risk silent amnesia on a different pod — fall back cleanly to full cold replay.
    if (isIncognito) {
      return undefined;
    }
    // In cloud mode, AWS persists the thread in DB, so reconnecting a fresh WS resumes cleanly.
    return { threadId: hit.threadId, rootThreadId: hit.rootThreadId || hit.threadId };
  }

  park(params: {
    scope: string | undefined;
    conversationKey: string | undefined;
    slotId: string;
    isIncognito: boolean;
    chatAgentId?: string;
    expectedGeneration?: number;
    prefixHashes: readonly string[];
    threadId: string;
    rootThreadId?: string;
    ws?: WebSocket;
    outpostId?: string;
    encodeFrame?: QuickFrameEncoder;
    apiKey?: string;
    proxyUrl?: string;
    lastAckSeq?: string;
  }): boolean {
    const {
      scope,
      conversationKey,
      slotId,
      isIncognito,
      chatAgentId,
      expectedGeneration,
      prefixHashes,
      threadId,
      rootThreadId,
      ws,
      outpostId,
      encodeFrame,
      apiKey,
      proxyUrl,
      lastAckSeq,
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
    for (const k of keys) {
      const prev = this.warmThreads.get(k);
      if (prev) this.removeEntry(prev, true);
    }

    const entry: WarmThreadEntry = {
      slotId,
      threadId,
      rootThreadId: rootThreadId || threadId,
      isIncognito,
      expiresAt: now + this.warmSessionTtlMs,
      siblingKeys: keys,
    };

    let parkedSocket = false;
    // Only park the live WS for reuse when the account has headroom below AWS's 5-WS hard limit.
    // Note: `activeWsBySlot` still includes the current finishing WS until `finally` decrements it.
    const activeOnSlot = this.activeWsBySlot.get(slotId) || 0;
    const allowParkUnderLoad = activeOnSlot + this.countParkedWsForSlot(slotId) <= 4;
    if (ws && ws.readyState === WebSocket.OPEN && encodeFrame && allowParkUnderLoad) {
      while (this.countParkedWsForSlot(slotId) >= MAX_PARKED_WS_PER_SLOT) {
        if (this.evictParkedWsForSlot(slotId, 1) === 0) break;
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

      const idleTtl = Math.min(this.warmSessionTtlMs, PARKED_WS_IDLE_TTL_MS);
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

    // In incognito mode, only cache an entry if we actually have a live dedicated WS backing it.
    if (isIncognito && !parkedSocket) {
      return false;
    }

    for (const k of keys) {
      this.warmThreads.set(k, entry);
    }
    return parkedSocket;
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.expiresAt <= now) this.removeEntry(entry, true);
    }
  }

  disposeAll(): void {
    for (const entry of new Set(this.warmThreads.values())) {
      this.removeEntry(entry, true);
    }
  }

  stats(): { warmIncrementalSessions: number; warmIdleSessions: number } {
    return {
      warmIncrementalSessions: new Set(this.warmThreads.values()).size,
      warmIdleSessions: this.countParkedWs(),
    };
  }
}
