import crypto from "node:crypto";
import { normalizeSystemPromptForHash } from "../utils/hash.js";

export interface AffinityBindingView {
  conversationKey: string;
  slotId: string;
  maskedKey: string;
  hitCount: number;
  boundAt: string;
  lastHitAt: string;
  expiresInSeconds: number;
}

interface InternalAffinityRecord {
  conversationKey: string;
  rawKey: string;
  slotId: string;
  maskedKey: string;
  hitCount: number;
  boundAtMs: number;
  lastHitAtMs: number;
  expiresAtMs: number;
}

function shortHash(prefix: string, raw: string): string {
  const hex = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `${prefix}_${hex}`;
}

/**
 * Derive a deterministic conversation key for CPA-style sticky session affinity:
 *  1. Explicit client session header (`x-session-id`, `session-id`, `x-session-affinity`, etc.)
 *  2. Explicit body cache/session field (`prompt_cache_key`, `metadata.session_id`, Claude Code `metadata.user_id`)
 *  3. Implicit anchor hash of `systemPrompt + firstUserTurnText` (keeps multi-turn chats pinned to 1 account even when client sends no session headers!)
 */
export function deriveConversationAffinityKey(params: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Record<string, unknown>;
  systemPrompt?: string;
  firstUserText?: string;
}): string | undefined {
  const { headers, rawBody, systemPrompt, firstUserText } = params;

  const headerCandidates = [
    "x-session-id",
    "session-id",
    "session_id",
    "x-session-affinity",
    "x-conversation-id",
    "openai-conversation-id"
  ];
  for (const h of headerCandidates) {
    const val = headers[h];
    const str = Array.isArray(val) ? val[0] : val;
    if (typeof str === "string" && str.trim()) {
      return shortHash("hdr", str.trim());
    }
  }

  if (typeof rawBody.prompt_cache_key === "string" && rawBody.prompt_cache_key.trim()) {
    return shortHash("pck", rawBody.prompt_cache_key.trim());
  }

  if (rawBody.metadata && typeof rawBody.metadata === "object" && !Array.isArray(rawBody.metadata)) {
    const meta = rawBody.metadata as Record<string, unknown>;
    for (const k of ["session_id", "conversation_id"]) {
      if (typeof meta[k] === "string" && (meta[k] as string).trim()) {
        return shortHash("meta", (meta[k] as string).trim());
      }
    }
    if (typeof meta.user_id === "string" && meta.user_id.trim()) {
      // Combine `metadata.user_id` with the first user turn anchor (stripping Claude Code
      // `<system-reminder>` wrappers and omitting volatile systemPrompt) so multi-turn chats
      // keep 100% warm_incremental stickiness while separate windows and parallel subagents rotate.
      const rawFirst = (firstUserText || "").trim();
      const strippedFirst = rawFirst.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
      const effectiveFirst = strippedFirst || rawFirst;
      if (effectiveFirst) {
        return shortHash("meta", `${meta.user_id.trim()}\0${effectiveFirst.slice(0, 1024)}`);
      }
      return shortHash("meta", meta.user_id.trim());
    }
  }

  if (typeof rawBody.user === "string" && rawBody.user.trim()) {
    // Combine `user` + first message anchor so one user's separate chat windows don't collide unnecessarily,
    // while keeping the same chat window 100% sticky even when clients mutate dynamic system prompts.
    const trimmedFirst = (firstUserText || "").trim();
    const sysAnchor = trimmedFirst.length >= 16 ? "" : normalizeSystemPromptForHash(systemPrompt || "").slice(0, 512);
    const anchor = `${rawBody.user.trim()}\0${sysAnchor}\0${trimmedFirst.slice(0, 1024)}`;
    return shortHash("usr", anchor);
  }

  const trimmedFirst = (firstUserText || "").trim();
  if (trimmedFirst) {
    // When the first user message is substantive (>= 16 chars), anchor on it alone so dynamic
    // system prompt edits (timestamps, memory lists, todo states in Witan/Agent clients)
    // never break account stickiness or warm thread reuse.
    const sysAnchor = trimmedFirst.length >= 16 ? "" : normalizeSystemPromptForHash(systemPrompt || "").slice(0, 512);
    const anchor = `${sysAnchor}\0${trimmedFirst.slice(0, 1024)}`;
    return shortHash("anc", anchor);
  }

  return undefined;
}

export class SessionAffinityTable {
  private readonly map = new Map<string, InternalAffinityRecord>();
  private readonly maxEntries: number;

  constructor(maxEntries = 2048) {
    this.maxEntries = maxEntries;
  }

  get size(): number {
    this.pruneExpired();
    return this.map.size;
  }

  lookup(conversationKey: string | undefined, ttlMs: number): string | null {
    if (!conversationKey) return null;
    const rec = this.map.get(conversationKey);
    if (!rec) return null;
    const now = Date.now();
    if (rec.expiresAtMs <= now) {
      this.map.delete(conversationKey);
      return null;
    }
    // Refresh sliding TTL and LRU position
    rec.hitCount += 1;
    rec.lastHitAtMs = now;
    rec.expiresAtMs = now + ttlMs;
    this.map.delete(conversationKey);
    this.map.set(conversationKey, rec);
    return rec.rawKey;
  }

  bind(params: {
    conversationKey: string | undefined;
    rawKey: string;
    slotId: string;
    maskedKey: string;
    ttlMs: number;
  }): void {
    const { conversationKey, rawKey, slotId, maskedKey, ttlMs } = params;
    if (!conversationKey) return;
    const now = Date.now();
    const existing = this.map.get(conversationKey);

    if (existing && existing.rawKey === rawKey) {
      existing.lastHitAtMs = now;
      existing.expiresAtMs = now + ttlMs;
      this.map.delete(conversationKey);
      this.map.set(conversationKey, existing);
      return;
    }

    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (!oldest) break;
      this.map.delete(oldest);
    }

    this.map.set(conversationKey, {
      conversationKey,
      rawKey,
      slotId,
      maskedKey,
      hitCount: 1,
      boundAtMs: now,
      lastHitAtMs: now,
      expiresAtMs: now + ttlMs
    });
  }

  evictConversation(conversationKey: string | undefined): void {
    if (conversationKey) this.map.delete(conversationKey);
  }

  evictAllForKey(rawKey: string): number {
    let removed = 0;
    for (const [ck, rec] of this.map.entries()) {
      if (rec.rawKey === rawKey) {
        this.map.delete(ck);
        removed += 1;
      }
    }
    return removed;
  }

  clearAll(): void {
    this.map.clear();
  }

  countBySlot(): Map<string, number> {
    this.pruneExpired();
    const counts = new Map<string, number>();
    for (const rec of this.map.values()) {
      counts.set(rec.slotId, (counts.get(rec.slotId) ?? 0) + 1);
    }
    return counts;
  }

  snapshot(limit = 50): AffinityBindingView[] {
    this.pruneExpired();
    const now = Date.now();
    return [...this.map.values()]
      .reverse()
      .slice(0, limit)
      .map((r) => ({
        conversationKey: r.conversationKey,
        slotId: r.slotId,
        maskedKey: r.maskedKey,
        hitCount: r.hitCount,
        boundAt: new Date(r.boundAtMs).toISOString(),
        lastHitAt: new Date(r.lastHitAtMs).toISOString(),
        expiresInSeconds: Math.max(0, Math.round((r.expiresAtMs - now) / 1000))
      }));
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [k, rec] of this.map.entries()) {
      if (rec.expiresAtMs <= now) this.map.delete(k);
    }
  }
}
