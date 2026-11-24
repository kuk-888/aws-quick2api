import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import sharp from "sharp";
import WebSocket from "ws";
import {
  decodeCloudOutputFrame,
  decodeGatewayFrame,
  drainEventStream,
  encodeCloudInputFrame,
  encodeGatewayJsonFrame,
} from "../aws-quick/event-stream-cbor.js";
import {
  cacheOAuthUserIdentity,
  deriveStableOutpostId,
  QUICK_APP_VERSION,
  QUICK_DESKTOP_USER_AGENT,
  resolveOAuthAccessToken,
} from "../aws-quick/oauth-client.js";
import {
  getSharedOutpost,
  parseQuickCredential,
  stopSharedOutpost,
} from "../aws-quick/outpost-singleton.js";
import { buildWebWsConnection } from "../aws-quick/web-client.js";
import type { SDKModel } from "../aws-quick/types.js";
import { listLiveModels, resolveModelSelection } from "../services/model-catalog.js";
import type { ExecutionModeTag, UsageTracker } from "../services/usage-tracker.js";
import { extendHashWithAssistantTurn, redactSecrets } from "../utils/hash.js";
import { getProxyAgent } from "../utils/proxy-agent.js";
import type { UpstreamKeyPool } from "./key-pool.js";
import {
  buildToolBridgePrompt,
  sanitizeClientSystemPromptForQuick,
  StreamingToolCallFilter,
} from "./tool-bridge.js";
import { StreamingUiTagSanitizer } from "./ui-tag-sanitizer.js";
import {
  GatewayError,
  type GatewayConfig,
  type GatewayStreamEvent,
  type NormalizedImage,
  type ParsedProtocolTurn,
} from "./types.js";

export type AgentFactory = unknown;

export interface QuickImageAttachment {
  type: "image";
  name: string;
  size: number;
  mimeType: string;
  contentSha256: string;
  data: string;
}

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
// AWS Quick WebSocket `user_message` enforces a hard 50,000-byte single-frame ceiling.
// Keep total inline image base64 payload <= 40,000 chars (~30 KB raw) so text + JSON envelope always fit safely.
const MAX_TOTAL_IMAGE_BASE64_CHARS = 40_000;

async function compressImageForQuickFrame(
  buf: Buffer,
  mimeType: string,
  maxBase64Chars: number,
): Promise<{ buf: Buffer; mimeType: string; base64: string }> {
  const origBase64 = buf.toString("base64");
  if (origBase64.length <= maxBase64Chars) {
    return { buf, mimeType, base64: origBase64 };
  }

  // Progressive downscale + JPEG re-encode ladder (fast ~15-30ms via sharp/libvips)
  const steps: Array<[number, number]> = [
    [1280, 72],
    [1024, 64],
    [840, 56],
    [680, 48],
    [540, 40],
    [420, 34],
    [320, 28],
  ];

  let smallest: Buffer | null = null;
  for (const [maxDim, quality] of steps) {
    try {
      const candidate = await sharp(buf, { failOn: "none" })
        .rotate()
        .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (!smallest || candidate.byteLength < smallest.byteLength) {
        smallest = candidate;
      }
      const b64 = candidate.toString("base64");
      if (b64.length <= maxBase64Chars) {
        return { buf: candidate, mimeType: "image/jpeg", base64: b64 };
      }
    } catch {
      break;
    }
  }

  if (smallest && smallest.toString("base64").length <= maxBase64Chars + 4_000) {
    return { buf: smallest, mimeType: "image/jpeg", base64: smallest.toString("base64") };
  }

  throw new GatewayError(
    "Image exceeds AWS Quick 50KB single-frame limit and could not be compressed small enough.",
    400,
    "image_too_large",
  );
}

function extForImageMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "png";
}

/**
 * Convert OpenAI/Anthropic NormalizedImage entries into AWS Quick `user_message.payload.attachments`.
 * Supports inline base64, `data:image/...;base64,...` URIs, and remote `http(s)://` image URLs.
 */
export async function buildQuickImageAttachments(
  images: readonly NormalizedImage[] | undefined,
  signal?: AbortSignal,
  totalBase64Budget = MAX_TOTAL_IMAGE_BASE64_CHARS,
): Promise<QuickImageAttachment[]> {
  if (!images || images.length === 0) return [];
  const out: QuickImageAttachment[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    let mimeType = "image/png";
    let rawBase64 = "";

    if ("data" in img) {
      mimeType = img.mimeType?.trim() || "image/png";
      const match = /^data:([^;]+);base64,(.*)$/s.exec(img.data.trim());
      if (match) {
        mimeType = match[1] || mimeType;
        rawBase64 = match[2] || "";
      } else {
        rawBase64 = img.data.trim();
      }
    } else if ("url" in img && img.url) {
      const url = img.url.trim();
      const dataMatch = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (dataMatch) {
        mimeType = dataMatch[1] || "image/png";
        rawBase64 = dataMatch[2] || "";
      } else if (/^https?:\/\//i.test(url)) {
        const { res } = await fetchSafeRemoteImage(url, signal);
        const ct = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (!ct || !ct.startsWith("image/")) {
          throw new GatewayError("Remote image URL did not return an image/* Content-Type.", 400, "invalid_image_type");
        }
        mimeType = ct;
        const arr = Buffer.from(await res.arrayBuffer());
        if (arr.byteLength > MAX_REMOTE_IMAGE_BYTES) {
          throw new GatewayError("Remote image exceeds 10 MB limit.", 400, "image_too_large");
        }
        rawBase64 = arr.toString("base64");
      } else {
        continue;
      }
    }

    if (!rawBase64) continue;
    const effectiveTotalBudget = Math.max(12_000, Math.min(MAX_TOTAL_IMAGE_BASE64_CHARS, totalBase64Budget));
    const perImageBudget = Math.max(8_000, Math.floor(effectiveTotalBudget / images.length));
    const rawBuf = Buffer.from(rawBase64, "base64");
    const fitted = await compressImageForQuickFrame(rawBuf, mimeType, perImageBudget);
    const contentSha256 = crypto.createHash("sha256").update(fitted.buf).digest("hex");
    const ext = extForImageMime(fitted.mimeType);
    out.push({
      type: "image",
      name: `user_image_${String(out.length + 1).padStart(3, "0")}.${ext}`,
      size: fitted.buf.byteLength,
      mimeType: fitted.mimeType,
      contentSha256,
      data: `data:${fitted.mimeType};base64,${fitted.base64}`,
    });
  }

  return out;
}

const MAX_REMOTE_IMAGE_REDIRECTS = 3;

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((s) => Number(s));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local & cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateOrReservedIp(raw: string): boolean {
  const ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(ip)) return isPrivateOrReservedIpv4(ip);
  if (net.isIPv6(ip)) {
    if (ip === "::" || ip === "::1") return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(ip)) return true; // link-local fe80::/10
    if (ip.startsWith("ff")) return true; // multicast
    const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (v4Mapped) return isPrivateOrReservedIpv4(v4Mapped[1]!);
    return false;
  }
  return true;
}

async function assertSafeRemoteImageUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GatewayError("Invalid image URL.", 400, "invalid_image_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GatewayError("Image URL must use http or https.", 400, "invalid_image_url");
  }
  if (parsed.username || parsed.password) {
    throw new GatewayError("Image URL must not embed credentials.", 400, "invalid_image_url");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new GatewayError("Blocked private/internal image URL host.", 400, "ssrf_blocked");
  }
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new GatewayError("Blocked private/internal image URL IP.", 400, "ssrf_blocked");
    }
    return parsed;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new GatewayError("Failed to resolve image URL hostname.", 400, "invalid_image_url");
  }
  if (!addrs.length || addrs.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new GatewayError("Blocked image URL resolving to private/internal IP.", 400, "ssrf_blocked");
  }
  return parsed;
}

async function fetchSafeRemoteImage(initialUrl: string, signal?: AbortSignal): Promise<{ res: Response }> {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REMOTE_IMAGE_REDIRECTS; hop++) {
    const parsed = await assertSafeRemoteImageUrl(current);
    const res = await fetch(parsed.toString(), {
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop === MAX_REMOTE_IMAGE_REDIRECTS) {
        throw new GatewayError("Too many or invalid redirects for image URL.", 400, "invalid_image_url");
      }
      current = new URL(loc, parsed).toString();
      continue;
    }
    if (!res.ok) {
      throw new GatewayError(`Failed to fetch image URL (${res.status}).`, 400, "invalid_image_url");
    }
    return { res };
  }
  throw new GatewayError("Too many redirects for image URL.", 400, "invalid_image_url");
}

const SURFACE_TYPE =
  process.platform === "win32" ? "QUICK_WORK_DESKTOP_WINDOWS" : "QUICK_WORK_DESKTOP_MAC";
const APP_VERSION = QUICK_APP_VERSION;
const DESKTOP_CAPABILITIES = {
  acp_first_text: 1,
  user_notification: 1,
  subtask_progress: 1,
  external_agent_sign_in: 1,
  recents_promotion: 1,
} as const;

export function mapSdkError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  const msg = redactSecrets(err instanceof Error ? err.message : String(err));
  return new GatewayError(msg || "Unexpected AWS Quick gateway error.", 502, "upstream_error");
}

const MAX_WS_PAYLOAD_UTF8_BYTES = 50_000;
const WS_FRAME_ENVELOPE_MARGIN_BYTES = 3_500;
const MAX_INLINE_CUSTOM_PROMPT_BYTES = 36_000;
const DEFAULT_OVERFLOW_COMPACT_TOKENS = 850_000;

/**
 * Fast bilingual token estimator (~3.8 chars/token for ASCII, ~1.5 chars/token for CJK/non-ASCII).
 * Used strictly as a safety net when an API caller forgets to compact near the 1M token ceiling.
 */
export function estimatePromptTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 3.8 + nonAscii / 1.5);
}

/**
 * Gateway-level overflow protection: untouched below `maxTokens`; above `maxTokens`, preserves
 * the opening context (head ~15%) and most recent turns (tail ~75%) on clean newline boundaries,
 * replacing the oversized middle with either a `quick-fast` summary or a clean omission marker.
 */
export function compactOversizedPrompt(
  prompt: string,
  customPrompt: string | null,
  maxTokens = DEFAULT_OVERFLOW_COMPACT_TOKENS,
  middleSummary?: string,
): {
  prompt: string;
  compacted: boolean;
  originalTokens: number;
  compactedTokens: number;
  middleSample?: string;
} {
  const customTokens = customPrompt ? estimatePromptTokens(customPrompt) : 0;
  const promptTokens = estimatePromptTokens(prompt);
  const totalTokens = customTokens + promptTokens;
  if (maxTokens <= 0 || totalTokens <= maxTokens) {
    return { prompt, compacted: false, originalTokens: totalTokens, compactedTokens: totalTokens };
  }

  const targetPromptTokens = Math.max(8_000, maxTokens - customTokens - 4_000);
  const ratio = Math.min(0.95, targetPromptTokens / Math.max(1, promptTokens));
  const targetChars = Math.max(16_000, Math.floor(prompt.length * ratio));
  let headEnd = Math.floor(targetChars * 0.16);
  let tailStart = Math.max(headEnd + 1, prompt.length - Math.floor(targetChars * 0.80));

  // Snap to nearby newline boundaries so we never chop mid-line or mid-surrogate-pair
  const headNl = prompt.lastIndexOf("\n", headEnd);
  if (headNl > Math.floor(headEnd * 0.7)) headEnd = headNl + 1;
  const tailNl = prompt.indexOf("\n", tailStart);
  if (tailNl !== -1 && tailNl < tailStart + Math.floor(targetChars * 0.05)) tailStart = tailNl + 1;

  const head = prompt.slice(0, headEnd).trimEnd();
  const middle = prompt.slice(headEnd, tailStart);
  const tail = prompt.slice(tailStart).trimStart();
  const omittedTokens = estimatePromptTokens(middle);

  // Build a bounded <=36KB digest of the omitted middle for optional fast summarization
  let middleSample: string | undefined;
  if (middle.length > 200) {
    const half = 16_000;
    middleSample =
      middle.length <= half * 2
        ? middle
        : `${middle.slice(0, half)}\n\n[... ${middle.length - half * 2} chars omitted ...]\n\n${middle.slice(middle.length - half)}`;
  }

  const bridge = middleSummary?.trim()
    ? `\n\n[Gateway Auto-Compacted Summary of Earlier Context (~${omittedTokens.toLocaleString()} tokens compressed)]\n${middleSummary.trim()}\n[End of Summary]\n\n`
    : `\n\n[Gateway Auto-Compacted: earlier middle context (~${omittedTokens.toLocaleString()} tokens) omitted to stay safely within the 1M token window]\n\n`;

  const compactedPrompt = `${head}${bridge}${tail}`;
  return {
    prompt: compactedPrompt,
    compacted: true,
    originalTokens: totalTokens,
    compactedTokens: customTokens + estimatePromptTokens(compactedPrompt),
    ...(middleSample ? { middleSample } : {}),
  };
}

/**
 * Splits a UTF-8 string into chunks that strictly fit AWS Quick's 50KB single-frame ceiling
 * (leaving margin for JSON/CBOR envelope, chunk header, and client-tool reminder),
 * preferring newline boundaries and never splitting UTF-16 surrogate pairs.
 *
 * Intermediate chunks do NOT carry `custom_prompt` or `attachments`, so they can use the full
 * ~46.5KB budget; only the final chunk reserves space for `effectiveCustomPrompt` + `attachments`.
 */
function jsonStringUtf8Bytes(s: string): number {
  if (!s) return 0;
  return Buffer.byteLength(JSON.stringify(s), "utf8");
}

export function splitPromptIntoSafeChunks(
  prompt: string,
  customPrompt: string | null,
  maxFrameBytes = MAX_WS_PAYLOAD_UTF8_BYTES,
): { chunks: string[]; effectiveCustomPrompt: string | null } {
  const customBytes = customPrompt ? jsonStringUtf8Bytes(customPrompt) : 0;
  const promptBytes = jsonStringUtf8Bytes(prompt);
  const safeFinalTotal = Math.max(4_096, maxFrameBytes - WS_FRAME_ENVELOPE_MARGIN_BYTES);

  if (promptBytes + customBytes <= safeFinalTotal) {
    return { chunks: [prompt], effectiveCustomPrompt: customPrompt };
  }

  let effectiveCustomPrompt = customPrompt;
  let fullText = prompt;
  if (customPrompt && customBytes > Math.min(MAX_INLINE_CUSTOM_PROMPT_BYTES, Math.max(4_096, safeFinalTotal - 4_096))) {
    // Keep the tail (including any tool-bridge instructions) inside native `custom_prompt`
    // so AWS Quick does not treat system/tool instructions as untrusted user-message prompt injection.
    const keepBudget = Math.min(MAX_INLINE_CUSTOM_PROMPT_BYTES, Math.max(4_096, safeFinalTotal - 6_144));
    let keepStart = customPrompt.length;
    let keptBytes = 0;
    while (keepStart > 0) {
      const prevIdx = keepStart - 1;
      const chBytes = jsonStringUtf8Bytes(customPrompt[prevIdx]!) - 2; // exclude surrounding JSON quotes
      if (keptBytes + chBytes > keepBudget) break;
      keptBytes += chBytes;
      keepStart = prevIdx;
    }
    // Avoid splitting UTF-16 surrogate pairs and snap to a nearby newline boundary
    if (keepStart > 0 && keepStart < customPrompt.length) {
      const code = customPrompt.charCodeAt(keepStart);
      if (code >= 0xdc00 && code <= 0xdfff) keepStart += 1;
      const nl = customPrompt.indexOf("\n", keepStart);
      if (nl !== -1 && nl - keepStart < 512) keepStart = nl + 1;
    }
    const overflowHead = customPrompt.slice(0, keepStart).trim();
    const keptTail = customPrompt.slice(keepStart).trim();
    effectiveCustomPrompt = keptTail || null;
    if (overflowHead) {
      fullText = `[Reference Context]\n${overflowHead}\n\n${prompt}`;
    }
  }

  const reserved = effectiveCustomPrompt ? jsonStringUtf8Bytes(effectiveCustomPrompt) : 0;
  const intermediateLimit = Math.max(8_192, MAX_WS_PAYLOAD_UTF8_BYTES - WS_FRAME_ENVELOPE_MARGIN_BYTES);
  const rawFinalRoom = safeFinalTotal - reserved;
  const finalLimit = Math.max(1_024, Math.min(intermediateLimit, rawFinalRoom));

  const chunks: string[] = [];
  let offset = 0;
  const len = fullText.length;

  while (offset < len) {
    const remainingSlice = fullText.slice(offset);
    const remainingBytes = jsonStringUtf8Bytes(remainingSlice);
    if (remainingBytes <= finalLimit) {
      chunks.push(remainingSlice);
      break;
    }

    // If remaining text fits in an intermediate chunk but not in `finalLimit`, peel off just enough
    // so the final chunk comfortably fits `finalLimit` (avoiding tiny 1-byte trailing chunks).
    const targetBytes =
      remainingBytes <= intermediateLimit
        ? Math.max(1_024, remainingBytes - Math.floor(finalLimit * 0.8))
        : intermediateLimit;

    let lo = offset + 1;
    let hi = Math.min(len, offset + targetBytes);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (jsonStringUtf8Bytes(fullText.slice(offset, mid)) <= targetBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    let end = lo;

    if (end > offset && end < len) {
      const code = fullText.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }

    const minBreak = offset + Math.floor((end - offset) * 0.8);
    const nl = fullText.lastIndexOf("\n", end - 1);
    if (nl >= minBreak) {
      end = nl + 1;
    }

    if (end <= offset) end = Math.min(len, offset + 1);
    chunks.push(fullText.slice(offset, end));
    offset = end;
  }

  return { chunks, effectiveCustomPrompt };
}

/**
 * AWS Quick bidirectional WebSocket execution engine.
 */
const WARM_THREAD_TTL_MS = 30 * 60 * 1000;
const PARKED_WS_IDLE_TTL_MS = 15 * 60 * 1000;
const MAX_WARM_THREADS = 256;
const MAX_PARKED_WS = 32;
// AWS Quick enforces a hard ceiling of 5 active WebSocket connections per account.
// Keep at most 2 parked idle sockets per account so concurrent requests never hit LimitExceededException.
export const MAX_PARKED_WS_PER_SLOT = 2;

export function classifyUpstreamError(finalErr: GatewayError): {
  isConnLimitErr: boolean;
  isPayloadOrContextSizeErr: boolean;
  isSessionLifecycleErr: boolean;
  isQuotaErr: boolean;
  isRateLimitErr: boolean;
  isAuthErr: boolean;
  isProxyOrConnErr: boolean;
} {
  const msg = finalErr.message || "";
  const lower = msg.toLowerCase();
  const isConnLimitErr =
    /too.?many.?active.?connections|maximum.?allowed|connection.?limit|limitexceededexception/i.test(lower);
  const isPayloadOrContextSizeErr =
    /message.?size|payload.?size|frame.?limit|context.?limit|too.?large|too.?long|max.?length/i.test(lower);
  const isSessionLifecycleErr =
    /thread.?expired|session.?expired|conversation.?expired/i.test(lower);
  const isQuotaErr =
    !isPayloadOrContextSizeErr &&
    !isConnLimitErr &&
    (finalErr.code === "quota_exhausted" ||
      finalErr.status === 402 ||
      /quota|usage.?limit|credits?.?(?:exhausted|insufficient|exceeded)|limit.?exceeded|insufficient.?(?:quota|credits?|balance)|exhausted/i.test(lower));
  const isRateLimitErr =
    !isQuotaErr &&
    (isConnLimitErr || finalErr.status === 429 || /rate.?limit|too many requests|throttl/i.test(lower));
  const isAuthErr =
    finalErr.code !== "model_not_available" &&
    !isSessionLifecycleErr &&
    (finalErr.status === 401 ||
      finalErr.status === 403 ||
      /unauthorized|invalid.?grant|(?:token|oauth|cookie|credential).?expired|access.?denied|authentication|oauth token refresh failed|session cookie/i.test(lower));
  const isProxyOrConnErr =
    !isQuotaErr &&
    !isRateLimitErr &&
    !isAuthErr &&
    (finalErr.status === 502 ||
      finalErr.status === 503 ||
      /proxy connect failed|econnrefused|econnreset|etimedout|socket hang up|unexpected server response|websocket closed \(1006\)/i.test(lower));

  return {
    isConnLimitErr,
    isPayloadOrContextSizeErr,
    isSessionLifecycleErr,
    isQuotaErr,
    isRateLimitErr,
    isAuthErr,
    isProxyOrConnErr,
  };
}

interface ParkedWsHandle {
  ws: WebSocket;
  outpostId: string;
  pingTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  onIdleClose: () => void;
  onIdleError: () => void;
  onIdleMessage: () => void;
}

interface WarmThreadEntry {
  slotId: string;
  threadId: string;
  isIncognito: boolean;
  expiresAt: number;
  parkedWs?: ParkedWsHandle;
  siblingKeys: string[];
}

export interface QuickChatAgentInfo {
  agentId: string;
  shortId: string;
  name: string;
  description: string;
  systemPrompt: string;
  isSystem: boolean;
}

export const DEFAULT_CODING_AGENT_NAME = "Quick2API Bridge";
export const LEGACY_CODING_AGENT_NAMES = ["Quick2API Bridge", "Quick2API Coding Bridge"];
export const DEFAULT_CODING_AGENT_DESCRIPTION =
  "Minimal AI assistant configured for external API clients.";
export const DEFAULT_CODING_AGENT_INSTRUCTIONS =
  "You are a helpful AI assistant accessed via an external API client. Follow the user's instructions and any structured output or tool-request format specified by the client directly and concisely. When the client provides external tool schemas, emit the requested structured call as a proposal for the user's local client to review and execute.";

export class QuickExecutionEngine {
  private readonly config: GatewayConfig;
  private readonly usageTracker: UsageTracker;
  private readonly modelListFetcher?: (apiKey: string) => Promise<SDKModel[]>;
  private readonly incognito: boolean;
  private readonly autoDeleteSession: boolean;
  private readonly autoEnsureCodingAgent: boolean;
  private readonly showRoutedModelInThinking: boolean;
  private readonly suppressLateRoutedThinkingInStream: boolean;
  private readonly webSearchEnabled: boolean;
  private readonly sanitizeAwsUiTags: boolean;
  private readonly workingSessionIds = new Map<string, string>();
  private readonly warmThreads = new Map<string, WarmThreadEntry>();
  private readonly activeWsBySlot = new Map<string, number>();
  private readonly ensuringAgentBySlot = new Map<string, Promise<string | undefined>>();
  private readonly autoEnsureFailedSlots = new Map<string, number>();
  private readonly overflowSummaryCache = new Map<string, { summary: string; expiresAt: number }>();

  private warmKey(
    scope: string | undefined,
    conversationKey: string | undefined,
    slotId: string,
    isIncognito: boolean,
    prefixHash: string,
    chatAgentId?: string
  ): string {
    return `${scope || "default"}|${conversationKey || "-"}|${slotId}|${isIncognito ? "inc" : "cld"}|${chatAgentId || "-"}|${prefixHash}`;
  }

  private detachParkedWs(handle: ParkedWsHandle, closeSocket: boolean): void {
    clearInterval(handle.pingTimer);
    clearTimeout(handle.idleTimer);
    handle.ws.off("close", handle.onIdleClose);
    handle.ws.off("error", handle.onIdleError);
    handle.ws.off("message", handle.onIdleMessage);
    if (closeSocket) {
      try {
        handle.ws.close();
      } catch { }
    }
  }

  private removeWarmEntry(entry: WarmThreadEntry, closeSocket: boolean): void {
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

  private countParkedWs(): number {
    const seen = new Set<WarmThreadEntry>();
    let n = 0;
    for (const entry of this.warmThreads.values()) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      if (entry.parkedWs && entry.parkedWs.ws.readyState === WebSocket.OPEN) n += 1;
    }
    return n;
  }

  private countParkedWsForSlot(slotId: string): number {
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

  private evictParkedWsForSlot(slotId: string, maxEvict = 1): number {
    let evicted = 0;
    for (const existing of new Set(this.warmThreads.values())) {
      if (evicted >= maxEvict) break;
      if (existing.slotId !== slotId || !existing.parkedWs) continue;
      const oldHandle = existing.parkedWs;
      existing.parkedWs = undefined;
      this.detachParkedWs(oldHandle, true);
      if (existing.isIncognito) this.removeWarmEntry(existing, false);
      evicted += 1;
    }
    return evicted;
  }

  private lookupWarmThread(
    scope: string | undefined,
    conversationKey: string | undefined,
    slotId: string,
    isIncognito: boolean,
    prefixHash: string,
    chatAgentId?: string
  ): { threadId: string; reusedWs?: WebSocket; reusedOutpostId?: string } | undefined {
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
        return { threadId: hit.threadId, reusedWs: h.ws, reusedOutpostId: h.outpostId };
      }
      this.detachParkedWs(h, true);
    }

    // In incognito mode, AWS Quick only keeps the thread in backend-pod RAM: if the dedicated WS died,
    // never risk silent amnesia on a different pod — fall back cleanly to full cold replay.
    if (isIncognito) {
      return undefined;
    }
    // In cloud mode, AWS persists the thread in DB, so reconnecting a fresh WS resumes cleanly.
    return { threadId: hit.threadId };
  }

  private setWarmThread(params: {
    scope: string | undefined;
    conversationKey: string | undefined;
    slotId: string;
    isIncognito: boolean;
    chatAgentId?: string;
    prefixHashes: readonly string[];
    threadId: string;
    ws?: WebSocket;
    outpostId?: string;
    encodeFrame?: (frame: Record<string, unknown>) => Uint8Array | string;
  }): boolean {
    const { scope, conversationKey, slotId, isIncognito, chatAgentId, prefixHashes, threadId, ws, outpostId, encodeFrame } = params;
    const keys = Array.from(
      new Set(prefixHashes.filter(Boolean).map((h) => this.warmKey(scope, conversationKey, slotId, isIncognito, h, chatAgentId))),
    );
    if (keys.length === 0) return false;

    const now = Date.now();
    const maxWarm = this.config.maxWarmSessions || MAX_WARM_THREADS;
    const warmTtlMs = this.config.warmSessionTtlMs || WARM_THREAD_TTL_MS;

    // Evict expired entries first, then oldest entries if over capacity.
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.expiresAt <= now) this.removeWarmEntry(entry, true);
    }
    while (this.warmThreads.size >= maxWarm) {
      const oldestKey = this.warmThreads.keys().next().value;
      if (!oldestKey) break;
      const oldestEntry = this.warmThreads.get(oldestKey);
      if (oldestEntry) this.removeWarmEntry(oldestEntry, true);
      else this.warmThreads.delete(oldestKey);
    }

    // Replace any existing entry on these keys cleanly
    for (const k of keys) {
      const prev = this.warmThreads.get(k);
      if (prev) this.removeWarmEntry(prev, true);
    }

    const entry: WarmThreadEntry = {
      slotId,
      threadId,
      isIncognito,
      expiresAt: now + warmTtlMs,
      siblingKeys: keys,
    };

    let parkedSocket = false;
    if (ws && ws.readyState === WebSocket.OPEN && encodeFrame) {
      // Enforce per-account cap first (AWS Quick hard limit: 5 active WS connections per account).
      while (this.countParkedWsForSlot(slotId) >= MAX_PARKED_WS_PER_SLOT) {
        if (this.evictParkedWsForSlot(slotId, 1) === 0) break;
      }
      // Enforce global MAX_PARKED_WS by closing the oldest parked WS (in cloud mode we keep its threadId).
      while (this.countParkedWs() >= MAX_PARKED_WS) {
        let evicted = false;
        for (const existing of new Set(this.warmThreads.values())) {
          if (existing.parkedWs) {
            const oldHandle = existing.parkedWs;
            existing.parkedWs = undefined;
            this.detachParkedWs(oldHandle, true);
            if (existing.isIncognito) this.removeWarmEntry(existing, false);
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
          this.removeWarmEntry(entry, false);
        }
      };

      const onIdleClose = () => handleDeadIdleWs();
      const onIdleError = () => handleDeadIdleWs();
      const onIdleMessage = () => {
        // Ignore unsolicited trailing keepalive/status frames while parked.
      };
      const pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(encodeFrame({ type: "ping", payload: { timestamp: Date.now() } }));
          } catch {
            handleDeadIdleWs();
          }
        } else {
          handleDeadIdleWs();
        }
      }, 25_000);
      pingTimer.unref?.();

      const idleTtl = Math.min(warmTtlMs, PARKED_WS_IDLE_TTL_MS);
      const idleTimer = setTimeout(() => handleDeadIdleWs(), idleTtl);
      idleTimer.unref?.();

      ws.on("close", onIdleClose);
      ws.on("error", onIdleError);
      ws.on("message", onIdleMessage);

      entry.parkedWs = {
        ws,
        outpostId: outpostId || "web0",
        pingTimer,
        idleTimer,
        onIdleClose,
        onIdleError,
        onIdleMessage,
      };
      parkedSocket = true;
    }

    // In incognito mode, only retain the warm entry if we actually have a live parked WS.
    if (isIncognito && !parkedSocket) {
      return false;
    }

    for (const k of keys) {
      this.warmThreads.set(k, entry);
    }
    return parkedSocket;
  }

  constructor(options: {
    config: GatewayConfig;
    usageTracker: UsageTracker;
    agentFactory?: AgentFactory;
    modelListFetcher?: (apiKey: string) => Promise<SDKModel[]>;
  }) {
    this.config = options.config;
    this.usageTracker = options.usageTracker;
    this.modelListFetcher = options.modelListFetcher;
    this.incognito = process.env.INCOGNITO !== "false";
    this.autoDeleteSession = process.env.AUTO_DELETE_SESSION === "true";
    this.autoEnsureCodingAgent = process.env.AUTO_ENSURE_CODING_AGENT !== "false";
    this.showRoutedModelInThinking = process.env.SHOW_ROUTED_MODEL_IN_THINKING !== "false";
    this.suppressLateRoutedThinkingInStream =
      process.env.SUPPRESS_LATE_ROUTED_THINKING_IN_STREAM === "true";
    this.webSearchEnabled = process.env.WEB_SEARCH_ENABLED !== "false";
    this.sanitizeAwsUiTags = process.env.SANITIZE_AWS_UI_TAGS !== "false";
  }

  runtimeStats() {
    return {
      parkedToolSessions: 0,
      warmIncrementalSessions: new Set(this.warmThreads.values()).size,
      warmIdleSessions: this.countParkedWs(),
      memoryStore: { blobs: 0, totalBytes: 0 },
    };
  }

  async sweepStaleAssets(): Promise<void> {
    const now = Date.now();
    for (const entry of new Set(this.warmThreads.values())) {
      if (entry.expiresAt <= now) this.removeWarmEntry(entry, true);
    }
  }

  async disposeAll(): Promise<void> {
    for (const entry of new Set(this.warmThreads.values())) {
      this.removeWarmEntry(entry, true);
    }
    stopSharedOutpost();
  }

  async resolveModel(apiKey: string, requestedModel: string, body: Record<string, unknown>) {
    const models = await listLiveModels(apiKey, this.modelListFetcher);
    return resolveModelSelection(requestedModel, body, models.find((m) => m.id === requestedModel));
  }

  async deleteCloudSessionsForKey(apiKey: string, sessionIds: string[], proxyUrl?: string): Promise<string[]> {
    const targets = Array.from(new Set(sessionIds.map((s) => s.trim()).filter(Boolean)));
    if (targets.length === 0) return [];

    const cred = parseQuickCredential(apiKey);
    const isWeb = cred.mode === "web" && !!cred.web;
    const encodeFrame = isWeb ? encodeGatewayJsonFrame : encodeCloudInputFrame;
    const decodeFrame = isWeb ? decodeGatewayFrame : decodeCloudOutputFrame;
    const workingSessionId = crypto.randomUUID();
    const surfaceType = isWeb ? "WEB_EXPERIENCE" : SURFACE_TYPE;
    const appVersion = isWeb ? "qbiz-web-bridge" : APP_VERSION;
    const effectiveProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const wsAgent = getProxyAgent(effectiveProxy);

    let ws: WebSocket;
    let actorArn: string | undefined;
    let outpostId = "web0";

    if (isWeb && cred.web) {
      const conn = buildWebWsConnection(cred.web, workingSessionId);
      ws = new WebSocket(conn.url, conn.protocols, {
        headers: conn.headers,
        ...(wsAgent ? { agent: wsAgent } : {}),
      });
    } else if (cred.mode === "oauth" && cred.oauth) {
      const { accessToken } = await resolveOAuthAccessToken(cred.oauth, false, proxyUrl);
      outpostId = deriveStableOutpostId(cred.oauth.clientId);
      const wsUrl =
        `wss://${cred.oauth.wsHost}/streaming/quickwork-chat-bidirectional-stream` +
        `?surfaceType=${encodeURIComponent(SURFACE_TYPE)}` +
        `&token=${encodeURIComponent(accessToken)}` +
        `&outpostId=${encodeURIComponent(outpostId)}` +
        `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
        `&channel=prod`;
      ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": QUICK_DESKTOP_USER_AGENT,
          "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
          "X-Surface-Type": SURFACE_TYPE,
          "X-Outpost-Id": outpostId,
          "X-Agent-Service-Type": "UNIFIED_QUICK",
          "X-Working-Session-Id": workingSessionId,
        },
        ...(wsAgent ? { agent: wsAgent } : {}),
      });
    } else {
      const outpost = await getSharedOutpost();
      if (cred.mode === "token" && cred.jwt) {
        outpost.setImportedToken({ jwt: cred.jwt, wsHost: cred.wsHost, outpostId: cred.outpostId });
      } else {
        outpost.setImportedToken(null);
      }

      const [session, oid] = await Promise.all([
        outpost.getSncsSession(),
        outpost.getOutpostId(),
      ]);
      actorArn = session.actorArn;
      outpostId = oid;
      const wsPath = session.wsPath || "/streaming/quickwork-chat-bidirectional-stream";
      const wsUrl =
        `wss://${session.wsHost}${wsPath}` +
        `?surfaceType=${encodeURIComponent(SURFACE_TYPE)}` +
        `&token=${encodeURIComponent(session.jwt)}` +
        `&outpostId=${encodeURIComponent(outpostId)}` +
        `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
        `&channel=prod`;

      ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${session.jwt}`,
          "X-Surface-Type": SURFACE_TYPE,
          "X-Outpost-Id": outpostId,
          "X-Agent-Service-Type": "UNIFIED_QUICK",
          "X-Working-Session-Id": workingSessionId,
        },
        ...(wsAgent ? { agent: wsAgent } : {}),
      });
    }

    const deleted: string[] = [];
    let recvBuf = Buffer.alloc(0);

    return new Promise<string[]>((resolve, reject) => {
      let settled = false;
      let sendTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
        try {
          ws.close();
        } catch { }
        resolve(deleted);
      };
      const timer = setTimeout(done, 8_000);
      ws.once("close", done);

      ws.once("open", () => {
        ws.send(
          encodeFrame({
            type: "session_connect",
            payload: {
              ...(actorArn ? { actor_id: actorArn } : {}),
              surfaceType,
              outpostId,
              appVersion,
            },
          }),
        );
        sendTimer = setTimeout(() => {
          sendTimer = null;
          if (ws.readyState !== WebSocket.OPEN) return;
          for (const id of targets) {
            ws.send(encodeFrame({ type: "session_delete", payload: { session_id: id } }));
          }
        }, 250);
      });

      ws.on("message", (data: Buffer) => {
        recvBuf = Buffer.concat([recvBuf, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
        const { messages, consumed } = drainEventStream(recvBuf, 0);
        if (consumed > 0) recvBuf = recvBuf.subarray(consumed);
        for (const esMsg of messages) {
          let decoded;
          try {
            decoded = decodeFrame(esMsg);
          } catch {
            continue;
          }
          if (!decoded || decoded.type !== "event") continue;
          if (decoded.data.type === "session_deleted") {
            const p = (decoded.data.payload || {}) as { session_id?: string; success?: boolean };
            if (p.success && p.session_id) deleted.push(String(p.session_id));
            if (deleted.length >= targets.length) done();
          }
        }
      });

      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async openControlWs(
    apiKey: string,
    proxyUrl?: string,
  ): Promise<{
    ws: WebSocket;
    encodeFrame: (frame: Record<string, unknown>) => Uint8Array | string;
    decodeFrame: typeof decodeCloudOutputFrame;
  }> {
    const cred = parseQuickCredential(apiKey);
    const isWeb = cred.mode === "web" && !!cred.web;
    const encodeFrame = isWeb ? encodeGatewayJsonFrame : encodeCloudInputFrame;
    const decodeFrame = isWeb ? decodeGatewayFrame : decodeCloudOutputFrame;
    const workingSessionId = crypto.randomUUID();
    const effectiveProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const wsAgent = getProxyAgent(effectiveProxy);

    let ws: WebSocket;
    if (isWeb && cred.web) {
      const conn = buildWebWsConnection(cred.web, workingSessionId);
      ws = new WebSocket(conn.url, conn.protocols, {
        headers: conn.headers,
        ...(wsAgent ? { agent: wsAgent } : {}),
      });
    } else if (cred.mode === "oauth" && cred.oauth) {
      const { accessToken } = await resolveOAuthAccessToken(cred.oauth, false, proxyUrl);
      const outpostId = deriveStableOutpostId(cred.oauth.clientId);
      const wsUrl =
        `wss://${cred.oauth.wsHost}/streaming/quickwork-chat-bidirectional-stream` +
        `?surfaceType=${encodeURIComponent(SURFACE_TYPE)}` +
        `&token=${encodeURIComponent(accessToken)}` +
        `&outpostId=${encodeURIComponent(outpostId)}` +
        `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
        `&channel=prod`;
      ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": QUICK_DESKTOP_USER_AGENT,
          "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
          "X-Surface-Type": SURFACE_TYPE,
          "X-Outpost-Id": outpostId,
          "X-Agent-Service-Type": "UNIFIED_QUICK",
          "X-Working-Session-Id": workingSessionId,
        },
        ...(wsAgent ? { agent: wsAgent } : {}),
      });
    } else {
      const outpost = await getSharedOutpost();
      if (cred.mode === "token" && cred.jwt) {
        outpost.setImportedToken({ jwt: cred.jwt, wsHost: cred.wsHost, outpostId: cred.outpostId });
      } else {
        outpost.setImportedToken(null);
      }
      const [session, oid] = await Promise.all([outpost.getSncsSession(), outpost.getOutpostId()]);
      if (!session.jwt || !session.wsHost) {
        throw new GatewayError("AWS Quick session unavailable.", 502, "upstream_auth_error");
      }
      const wsPath = session.wsPath || "/streaming/quickwork-chat-bidirectional-stream";
      const wsUrl =
        `wss://${session.wsHost}${wsPath}` +
        `?surfaceType=${encodeURIComponent(SURFACE_TYPE)}` +
        `&token=${encodeURIComponent(session.jwt)}` +
        `&outpostId=${encodeURIComponent(oid)}` +
        `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
        `&channel=prod`;
      ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${session.jwt}`,
          "X-Surface-Type": SURFACE_TYPE,
          "X-Outpost-Id": oid,
          "X-Agent-Service-Type": "UNIFIED_QUICK",
          "X-Working-Session-Id": workingSessionId,
        },
        ...(wsAgent ? { agent: wsAgent } : {}),
      });
    }
    return { ws, encodeFrame, decodeFrame };
  }

  /**
   * Lists all AWS Quick chat agents (default SYSTEM + user custom agents) on the given account
   * using the native `get_chat_agents` -> `chat_agents_updated` WebSocket protocol.
   */
  async listChatAgentsForKey(apiKey: string, proxyUrl?: string): Promise<QuickChatAgentInfo[]> {
    const { ws, encodeFrame, decodeFrame } = await this.openControlWs(apiKey, proxyUrl);
    return new Promise<QuickChatAgentInfo[]>((resolve, reject) => {
      let recvBuf = Buffer.alloc(0);
      let settled = false;
      let sent = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { }
        fn();
      };
      const timer = setTimeout(() => {
        done(() => reject(new GatewayError("Timed out listing AWS Quick custom agents.", 504, "timeout_error")));
      }, 10_000);
      timer.unref?.();

      ws.on("message", (data: Buffer) => {
        recvBuf = Buffer.concat([recvBuf, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
        const { messages, consumed } = drainEventStream(recvBuf, 0);
        if (consumed > 0) recvBuf = recvBuf.subarray(consumed);
        for (const esMsg of messages) {
          let decoded;
          try { decoded = decodeFrame(esMsg); } catch { continue; }
          if (!decoded) continue;
          if (decoded.type === "error") {
            done(() => reject(new GatewayError(`[${decoded.code}] ${decoded.message}`, 502, "upstream_error")));
            return;
          }
          const evType = String(decoded.data?.type || "");
          const payload = (decoded.data?.payload && typeof decoded.data.payload === "object"
            ? decoded.data.payload
            : {}) as Record<string, unknown>;
          if ((evType === "session_established" || evType === "connected") && !sent) {
            sent = true;
            try { ws.send(encodeFrame({ type: "get_chat_agents", payload: {} })); } catch { }
          } else if (evType === "chat_agents_updated") {
            const rawAgents = Array.isArray(payload.agents) ? payload.agents : [];
            const agents: QuickChatAgentInfo[] = [];
            for (const item of rawAgents) {
              if (!item || typeof item !== "object") continue;
              const rec = item as Record<string, unknown>;
              const rawId = typeof rec.agentId === "string" ? rec.agentId.trim() : "";
              if (!rawId) continue;
              const shortId = rawId.includes("/") ? rawId.slice(rawId.lastIndexOf("/") + 1) : rawId;
              const isSystem =
                shortId.toUpperCase() === "SYSTEM" ||
                rawId.endsWith("/SYSTEM") ||
                rec.isSystemDefault === true;
              agents.push({
                agentId: rawId,
                shortId,
                name: typeof rec.name === "string" ? rec.name : shortId,
                description: typeof rec.description === "string" ? rec.description : "",
                systemPrompt: typeof rec.systemPrompt === "string" ? rec.systemPrompt : "",
                isSystem,
              });
            }
            done(() => resolve(agents));
            return;
          }
        }
      });

      ws.once("error", (err) => done(() => reject(err)));
      ws.once("close", () => done(() => resolve([])));
    });
  }

  /**
   * Creates and publishes a minimal coding custom agent on the given AWS Quick account via native WS frames:
   * `create_agent_draft` -> `update_chat_agent_config` -> `publish_agent_draft`.
   */
  async createAndPublishCodingAgentForKey(
    apiKey: string,
    opts?: { name?: string; description?: string; instructions?: string },
    proxyUrl?: string,
  ): Promise<{ agentId: string; name: string }> {
    const name = opts?.name?.trim() || DEFAULT_CODING_AGENT_NAME;
    const description = opts?.description?.trim() || DEFAULT_CODING_AGENT_DESCRIPTION;
    const instructions = opts?.instructions?.trim() || DEFAULT_CODING_AGENT_INSTRUCTIONS;
    const { ws, encodeFrame, decodeFrame } = await this.openControlWs(apiKey, proxyUrl);

    return new Promise<{ agentId: string; name: string }>((resolve, reject) => {
      let recvBuf = Buffer.alloc(0);
      let settled = false;
      let stage: "init" | "creating" | "updating" | "publishing" = "init";
      let draftAgentId = "";
      let publishFallbackTimer: NodeJS.Timeout | null = null;

      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (publishFallbackTimer) clearTimeout(publishFallbackTimer);
        try { ws.close(); } catch { }
        fn();
      };
      const timer = setTimeout(() => {
        done(() => reject(new GatewayError("Timed out creating AWS Quick custom agent.", 504, "timeout_error")));
      }, 15_000);
      timer.unref?.();

      const triggerPublish = () => {
        if (stage !== "updating" || !draftAgentId || settled) return;
        stage = "publishing";
        if (publishFallbackTimer) {
          clearTimeout(publishFallbackTimer);
          publishFallbackTimer = null;
        }
        try {
          ws.send(encodeFrame({ type: "publish_agent_draft", payload: { agent_id: draftAgentId } }));
        } catch (err) {
          done(() => reject(err));
        }
      };

      ws.on("message", (data: Buffer) => {
        recvBuf = Buffer.concat([recvBuf, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
        const { messages, consumed } = drainEventStream(recvBuf, 0);
        if (consumed > 0) recvBuf = recvBuf.subarray(consumed);
        for (const esMsg of messages) {
          let decoded;
          try { decoded = decodeFrame(esMsg); } catch { continue; }
          if (!decoded) continue;
          if (decoded.type === "error") {
            done(() => reject(new GatewayError(`[${decoded.code}] ${decoded.message}`, 502, "upstream_error")));
            return;
          }
          const evType = String(decoded.data?.type || "");
          const payload = (decoded.data?.payload && typeof decoded.data.payload === "object"
            ? decoded.data.payload
            : {}) as Record<string, unknown>;

          if ((evType === "session_established" || evType === "connected") && stage === "init") {
            stage = "creating";
            try { ws.send(encodeFrame({ type: "create_agent_draft", payload: { new_agent: true } })); } catch { }
          } else if (evType === "agent_draft_created" && stage === "creating") {
            const id = typeof payload.agent_id === "string" ? payload.agent_id.trim() : "";
            if (!id) {
              done(() => reject(new GatewayError("AWS Quick returned empty draft agent_id.", 502, "upstream_error")));
              return;
            }
            draftAgentId = id;
            stage = "updating";
            try {
              ws.send(
                encodeFrame({
                  type: "update_chat_agent_config",
                  payload: {
                    agent_id: draftAgentId,
                    target: "draft",
                    name,
                    description,
                    instructions,
                  },
                }),
              );
            } catch (err) {
              done(() => reject(err));
              return;
            }
            publishFallbackTimer = setTimeout(() => triggerPublish(), 1_500);
            publishFallbackTimer.unref?.();
          } else if (evType === "agent_draft_saved" && stage === "updating") {
            triggerPublish();
          } else if (evType === "publish_agent_draft_success") {
            const finalId =
              (typeof payload.agent_id === "string" && payload.agent_id.trim()) || draftAgentId;
            done(() => resolve({ agentId: finalId, name }));
            return;
          } else if (
            evType === "publish_agent_draft_error" ||
            evType === "update_chat_agent_config_error" ||
            evType === "error"
          ) {
            const errMsg = typeof payload.error === "string" ? payload.error : evType;
            done(() => reject(new GatewayError(`Failed to create custom agent: ${errMsg}`, 502, "upstream_error")));
            return;
          }
        }
      });

      ws.once("error", (err) => done(() => reject(err)));
      ws.once("close", () => {
        if (!settled) done(() => reject(new GatewayError("WebSocket closed before custom agent finished publishing.", 502, "upstream_error")));
      });
    });
  }

  /**
   * Updates an existing custom agent's instructions (and optional name/description) via native WS frames:
   * `create_agent_draft(agent_id)` -> `update_chat_agent_config` -> `publish_agent_draft`.
   */
  async updateAndPublishAgentForKey(
    apiKey: string,
    agentId: string,
    opts: { instructions: string; name?: string; description?: string },
    proxyUrl?: string,
  ): Promise<{ agentId: string }> {
    const cleanId = agentId.trim();
    if (!cleanId) throw new GatewayError("`agentId` is required.", 400, "invalid_request_error");
    const instructions = opts.instructions.trim();
    const { ws, encodeFrame, decodeFrame } = await this.openControlWs(apiKey, proxyUrl);

    return new Promise<{ agentId: string }>((resolve, reject) => {
      let recvBuf = Buffer.alloc(0);
      let settled = false;
      let stage: "init" | "drafting" | "updating" | "publishing" = "init";
      let publishFallbackTimer: NodeJS.Timeout | null = null;

      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (publishFallbackTimer) clearTimeout(publishFallbackTimer);
        try { ws.close(); } catch { }
        fn();
      };
      const timer = setTimeout(() => {
        done(() => reject(new GatewayError("Timed out updating AWS Quick custom agent.", 504, "timeout_error")));
      }, 15_000);
      timer.unref?.();

      const triggerPublish = () => {
        if (stage !== "updating" || settled) return;
        stage = "publishing";
        if (publishFallbackTimer) {
          clearTimeout(publishFallbackTimer);
          publishFallbackTimer = null;
        }
        try {
          ws.send(encodeFrame({ type: "publish_agent_draft", payload: { agent_id: cleanId } }));
        } catch (err) {
          done(() => reject(err));
        }
      };

      ws.on("message", (data: Buffer) => {
        recvBuf = Buffer.concat([recvBuf, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
        const { messages, consumed } = drainEventStream(recvBuf, 0);
        if (consumed > 0) recvBuf = recvBuf.subarray(consumed);
        for (const esMsg of messages) {
          let decoded;
          try { decoded = decodeFrame(esMsg); } catch { continue; }
          if (!decoded) continue;
          if (decoded.type === "error") {
            done(() => reject(new GatewayError(`[${decoded.code}] ${decoded.message}`, 502, "upstream_error")));
            return;
          }
          const evType = String(decoded.data?.type || "");
          const payload = (decoded.data?.payload && typeof decoded.data.payload === "object"
            ? decoded.data.payload
            : {}) as Record<string, unknown>;

          if ((evType === "session_established" || evType === "connected") && stage === "init") {
            stage = "drafting";
            try {
              ws.send(encodeFrame({ type: "create_agent_draft", payload: { agent_id: cleanId, ccp_files_supported: true } }));
            } catch { }
          } else if (evType === "agent_draft_created" && stage === "drafting") {
            stage = "updating";
            try {
              ws.send(
                encodeFrame({
                  type: "update_chat_agent_config",
                  payload: {
                    agent_id: cleanId,
                    target: "draft",
                    instructions,
                    ...(opts.name?.trim() ? { name: opts.name.trim() } : {}),
                    ...(typeof opts.description === "string" ? { description: opts.description.trim() } : {}),
                  },
                }),
              );
            } catch (err) {
              done(() => reject(err));
              return;
            }
            publishFallbackTimer = setTimeout(() => triggerPublish(), 1_500);
            publishFallbackTimer.unref?.();
          } else if (evType === "agent_draft_saved" && stage === "updating") {
            triggerPublish();
          } else if (evType === "publish_agent_draft_success") {
            done(() => resolve({ agentId: cleanId }));
            return;
          } else if (
            evType === "publish_agent_draft_error" ||
            evType === "update_chat_agent_config_error" ||
            evType === "error"
          ) {
            const errMsg = typeof payload.error === "string" ? payload.error : evType;
            done(() => reject(new GatewayError(`Failed to update custom agent: ${errMsg}`, 502, "upstream_error")));
            return;
          }
        }
      });

      ws.once("error", (err) => done(() => reject(err)));
      ws.once("close", () => {
        if (!settled) done(() => reject(new GatewayError("WebSocket closed before custom agent finished publishing.", 502, "upstream_error")));
      });
    });
  }

  /**
   * Finds an existing custom agent on the account (preferring `Quick2API Bridge`, otherwise
   * any existing non-SYSTEM custom agent) or creates & publishes one, then binds it to `slotId`.
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
            customAgents.find((a) => knownNames.has(a.name.trim().toLowerCase())) ||
            customAgents[0];
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
      } catch {
        this.autoEnsureFailedSlots.set(slotId, Date.now());
        return undefined;
      } finally {
        this.ensuringAgentBySlot.delete(slotId);
      }
    })();

    this.ensuringAgentBySlot.set(slotId, work);
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
    }) => void,
  ): AsyncGenerator<GatewayStreamEvent, void, unknown> {
    const excluded = new Set<string>();
    const maxAttempts = Math.min(Math.max(1, keyPool.enabledKeyCount()), 5);
    let retriedSameSlotConnLimit = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const lease = keyPool.leaseKey(turn.requestedModel, excluded.size > 0 ? excluded : undefined, turn.conversationKey);
      const poolSettings = keyPool.getSettings();
      const isIncognito = poolSettings.incognitoMode;
      const shouldAutoEnsure =
        poolSettings.autoEnsureCodingAgent !== undefined
          ? poolSettings.autoEnsureCodingAgent
          : this.autoEnsureCodingAgent;
      let effectiveChatAgentId = (lease.chatAgentId || poolSettings.chatAgentId || "").trim() || undefined;
      if (
        !effectiveChatAgentId &&
        shouldAutoEnsure &&
        !turn.rawBody?.__internalSummary &&
        !turn.signal?.aborted
      ) {
        const failedAt = this.autoEnsureFailedSlots.get(lease.slotId);
        if (!failedAt || Date.now() - failedAt > 10 * 60 * 1000) {
          effectiveChatAgentId = await this.ensureCodingAgentForKey(
            lease.apiKey,
            lease.slotId,
            keyPool,
            lease.proxyUrl,
          ).catch(() => undefined);
        }
      }
      let yieldedOutput = false;
      let lastExecMode: ExecutionModeTag | undefined;
      const wrappedMeta: typeof onExecMeta = (meta) => {
        lastExecMode = meta.execMode;
        onExecMeta?.(meta);
      };

      try {
        for await (const ev of this.executeTurnWithLease(turn, lease, isIncognito, wrappedMeta, effectiveChatAgentId)) {
          if (ev.type === "text" || ev.type === "thinking" || ev.type === "tool_calls") {
            yieldedOutput = true;
          }
          yield ev;
        }
        lease.markSuccess();
        return;
      } catch (err) {
        const gwErr = mapSdkError(err);
        // Fail-safe: if a warm_incremental thread was evicted/rejected by upstream before yielding any output,
        // transparently fall back once to a fresh full cold replay on the same account (lookupWarmThread already
        // evicted the stale entry, so the retry is guaranteed to run cold).
        if (
          lastExecMode === "warm_incremental" &&
          !yieldedOutput &&
          !turn.signal?.aborted &&
          gwErr.code !== "content_filter" &&
          gwErr.code !== "content_filtered"
        ) {
          try {
            for await (const ev of this.executeTurnWithLease(turn, lease, isIncognito, wrappedMeta, effectiveChatAgentId)) {
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
        const finalErr = mapSdkError(err);
        const msg = finalErr.message || "";
        const {
          isConnLimitErr,
          isQuotaErr,
          isRateLimitErr,
          isAuthErr,
          isProxyOrConnErr,
        } = classifyUpstreamError(finalErr);

        const evictedParked = isConnLimitErr
          ? this.evictParkedWsForSlot(lease.slotId, Number.POSITIVE_INFINITY)
          : 0;

        // If we hit AWS's 5-connection ceiling and just freed parked idle sockets on this slot,
        // wait 200ms for AWS to register the TCP close and retry the same slot once without
        // penalizing a healthy single-account pool with a 30s rate-limit cooldown.
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
        } else if (isRateLimitErr || isProxyOrConnErr) {
          keyPool.reportRateLimit(lease.apiKey);
        } else if (isAuthErr) {
          keyPool.reportAuthFailure(lease.apiKey, msg);
        }

        const canFailover =
          !yieldedOutput &&
          !turn.signal?.aborted &&
          (isQuotaErr || isRateLimitErr || isAuthErr || isProxyOrConnErr) &&
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
    }) => void,
    chatAgentId?: string,
  ): AsyncGenerator<GatewayStreamEvent, void, unknown> {
    // Resolve model BEFORE consuming any parked warm WS so there is no async vacuum window
    // where a parked WS has no error/close listeners or leaks if model resolution fails.
    const { selection } = await this.resolveModel(lease.apiKey, turn.requestedModel, turn.rawBody);

    const toolBridgePrompt = buildToolBridgePrompt(turn.tools, turn.toolChoice, {
      compactForCustomAgent: Boolean(chatAgentId),
    });
    const customPromptParts: string[] = [];
    if (turn.systemPrompt?.trim()) {
      customPromptParts.push(
        sanitizeClientSystemPromptForQuick(turn.systemPrompt.trim(), Boolean(toolBridgePrompt)),
      );
    }
    if (toolBridgePrompt) customPromptParts.push(toolBridgePrompt);
    const customPrompt = customPromptParts.length > 0 ? customPromptParts.join("\n\n") : null;

    const warmHit =
      !(isIncognito && this.autoDeleteSession) &&
        turn.priorPrefixHash &&
        turn.incrementalUserText !== undefined
        ? this.lookupWarmThread(turn.scope, turn.conversationKey, lease.slotId, isIncognito, turn.priorPrefixHash, chatAgentId)
        : undefined;
    let warmThreadId = warmHit?.threadId;
    let reusedWs = warmHit?.reusedWs;
    let isWarmIncremental = Boolean(warmThreadId);

    // Keep temporary error/close guards on reusedWs during async image preparation so it can never
    // emit an unhandled 'error' or leak as a zombie socket if image compression throws.
    let tempReusedDead = false;
    const onTempReusedDead = () => {
      tempReusedDead = true;
    };
    if (reusedWs) {
      reusedWs.on("error", onTempReusedDead);
      reusedWs.on("close", onTempReusedDead);
    }

    const buildPromptAndAttachments = async (incremental: boolean) => {
      const sourceImages = incremental ? (turn.incrementalImages ?? []) : turn.images;
      const rawPromptText = incremental ? turn.incrementalUserText : turn.fullTranscriptText;
      const approxTextBytes =
        jsonStringUtf8Bytes(rawPromptText || "") + jsonStringUtf8Bytes(customPrompt || "");
      const adaptiveImageBudget = Math.max(8_000, Math.min(38_000, 42_000 - approxTextBytes));
      const atts = await buildQuickImageAttachments(sourceImages, turn.signal, adaptiveImageBudget);
      const text = rawPromptText?.trim() || (atts.length > 0 ? "Please analyze the attached image(s)." : "");
      if (!text) {
        throw new GatewayError("Empty prompt", 400, "invalid_request_error");
      }
      return { promptText: text, attachments: atts };
    };

    let prompt: string;
    let attachments: QuickImageAttachment[];
    try {
      const built = await buildPromptAndAttachments(isWarmIncremental);
      prompt = built.promptText;
      attachments = built.attachments;

      // If our dedicated WS died during async image download/compression:
      // in incognito mode, NEVER send an incremental prompt to a new random pod (would silently lose memory);
      // transparently fall back to full cold replay right here!
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
          const coldBuilt = await buildPromptAndAttachments(false);
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
    });

    // Layer 2: Gateway overflow protection when caller forgets to compact near the 1M token limit.
    const overflowLimit = (() => {
      const raw = process.env.AUTO_COMPACT_OVERFLOW_TOKENS;
      if (raw === undefined || raw.trim() === "") return DEFAULT_OVERFLOW_COMPACT_TOKENS;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_OVERFLOW_COMPACT_TOKENS;
    })();
    if (!isWarmIncremental && overflowLimit > 0 && !(turn.rawBody as Record<string, unknown> | undefined)?.__internalSummary) {
      const initialCompact = compactOversizedPrompt(prompt, customPrompt, overflowLimit);
      if (initialCompact.compacted) {
        let middleSummary: string | undefined;
        if (process.env.AUTO_COMPACT_SUMMARY !== "false" && initialCompact.middleSample) {
          middleSummary = await this.summarizeOverflowMiddle(initialCompact.middleSample, lease, turn.signal, chatAgentId).catch(() => undefined);
        }
        prompt = middleSummary
          ? compactOversizedPrompt(prompt, customPrompt, overflowLimit, middleSummary).prompt
          : initialCompact.prompt;
      }
    }
    const allowedToolNames = new Set<string>();
    for (const t of turn.tools) {
      if (t.name) allowedToolNames.add(t.name);
      if (t.wireName) allowedToolNames.add(t.wireName);
    }
    const toolFilter = toolBridgePrompt ? new StreamingToolCallFilter(allowedToolNames) : null;
    const uiTagSanitizer = this.sanitizeAwsUiTags ? new StreamingUiTagSanitizer() : null;

    const cred = parseQuickCredential(lease.apiKey);
    const isWeb = cred.mode === "web" && !!cred.web;
    const encodeFrame = isWeb ? encodeGatewayJsonFrame : encodeCloudInputFrame;
    const decodeFrame = isWeb ? decodeGatewayFrame : decodeCloudOutputFrame;
    const surfaceType = isWeb ? "WEB_EXPERIENCE" : SURFACE_TYPE;
    const appVersion = isWeb ? "qbiz-web-bridge" : APP_VERSION;
    const surfaceName = isWeb ? "web" : "desktop";

    let workingSessionId = this.workingSessionIds.get(lease.slotId);
    if (!workingSessionId) {
      workingSessionId = crypto.randomUUID();
      this.workingSessionIds.set(lease.slotId, workingSessionId);
    }
    const threadId = warmThreadId || crypto.randomUUID();

    let ws: WebSocket;
    let actorArn: string | undefined;
    let outpostId = warmHit?.reusedOutpostId || "web0";
    const effectiveProxy = lease.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const wsAgent = getProxyAgent(effectiveProxy);

    if (reusedWs && reusedWs.readyState === WebSocket.OPEN) {
      ws = reusedWs;
    } else {
      // Proactively evict parked idle WS on this account if active + parked approaches AWS's 5-connection ceiling.
      const activeForSlot = this.activeWsBySlot.get(lease.slotId) || 0;
      const parkedForSlot = this.countParkedWsForSlot(lease.slotId);
      if (activeForSlot + parkedForSlot >= 4) {
        this.evictParkedWsForSlot(lease.slotId, activeForSlot + parkedForSlot - 3);
      }

      if (isWeb && cred.web) {
        const conn = buildWebWsConnection(cred.web, workingSessionId);
        ws = new WebSocket(conn.url, conn.protocols, {
          headers: conn.headers,
          ...(wsAgent ? { agent: wsAgent } : {}),
        });
      } else if (cred.mode === "oauth" && cred.oauth) {
        const { accessToken } = await resolveOAuthAccessToken(cred.oauth, false, lease.proxyUrl);
        outpostId = deriveStableOutpostId(cred.oauth.clientId);
        const wsUrl =
          `wss://${cred.oauth.wsHost}/streaming/quickwork-chat-bidirectional-stream` +
          `?surfaceType=${encodeURIComponent(SURFACE_TYPE)}` +
          `&token=${encodeURIComponent(accessToken)}` +
          `&outpostId=${encodeURIComponent(outpostId)}` +
          `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
          `&channel=prod`;
        ws = new WebSocket(wsUrl, {
          headers: {
            "User-Agent": QUICK_DESKTOP_USER_AGENT,
            Authorization: `Bearer ${accessToken}`,
            "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
            "X-Surface-Type": SURFACE_TYPE,
            "X-Outpost-Id": outpostId,
            "X-Agent-Service-Type": "UNIFIED_QUICK",
            "X-Working-Session-Id": workingSessionId,
          },
          ...(wsAgent ? { agent: wsAgent } : {}),
        });
      } else {
        const outpost = await getSharedOutpost();
        if (cred.mode === "token" && cred.jwt) {
          outpost.setImportedToken({ jwt: cred.jwt, wsHost: cred.wsHost, outpostId: cred.outpostId });
        } else {
          outpost.setImportedToken(null);
        }

        const [session, oid] = await Promise.all([
          outpost.getSncsSession(),
          outpost.getOutpostId(),
        ]);
        if (!session.jwt || !session.wsHost) {
          throw new GatewayError(
            "AWS Quick session unavailable. Please sign in to Amazon Quick.app or import a valid credential.",
            502,
            "upstream_auth_error",
          );
        }
        actorArn = session.actorArn;
        outpostId = oid;

        const replayContext = `v1;setup;${crypto.randomBytes(32).toString("base64url")}`;
        const wsPath = session.wsPath || "/streaming/quickwork-chat-bidirectional-stream";
        const wsUrl =
          `wss://${session.wsHost}${wsPath}` +
          `?surfaceType=${encodeURIComponent(SURFACE_TYPE)}` +
          `&token=${encodeURIComponent(session.jwt)}` +
          `&outpostId=${encodeURIComponent(outpostId)}` +
          `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
          `&replayContext=${encodeURIComponent(replayContext)}` +
          `&channel=prod`;

        ws = new WebSocket(wsUrl, {
          headers: {
            Authorization: `Bearer ${session.jwt}`,
            "X-Surface-Type": SURFACE_TYPE,
            "X-Outpost-Id": outpostId,
            "X-Agent-Service-Type": "UNIFIED_QUICK",
            "X-Working-Session-Id": workingSessionId,
          },
          ...(wsAgent ? { agent: wsAgent } : {}),
        });
      }
    }
    this.activeWsBySlot.set(lease.slotId, (this.activeWsBySlot.get(lease.slotId) || 0) + 1);

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

    const attachmentsBytes = attachments.length > 0 ? Buffer.byteLength(JSON.stringify(attachments), "utf8") : 0;
    const frameBudgetBytes = attachmentsBytes > 0
      ? Math.max(4_000, MAX_WS_PAYLOAD_UTF8_BYTES - attachmentsBytes)
      : MAX_WS_PAYLOAD_UTF8_BYTES;
    const { chunks, effectiveCustomPrompt } = splitPromptIntoSafeChunks(prompt, customPrompt, frameBudgetBytes);
    const totalChunks = chunks.length;
    let activeChunkIndex = 0;
    let advancingChunk = false;

    const timer = setTimeout(() => {
      if (!ended) {
        ended = true;
        push({ type: "__error", error: new GatewayError("AWS Quick stream timed out", 504, "timeout_error") });
        try {
          ws.close();
        } catch { }
      }
    }, (this.config.runMaxTimeoutMs || 120_000) + Math.max(0, totalChunks - 1) * 15_000);

    const onAbort = () => {
      if (!ended) {
        ended = true;
        try {
          ws.close();
        } catch { }
        push({ type: "done", stopReason: "stop" });
      }
    };
    turn.signal?.addEventListener("abort", onAbort, { once: true });

    let recvBuf = Buffer.alloc(0);
    let emittedRoutedModel = false;
    let hasEmittedText = false;
    let assistantOutputText = "";
    let resolvedModelId: string | undefined;
    let wsParked = false;
    let pingTimer: NodeJS.Timeout | null = null;
    const clearPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };
    let postUsageTimer: NodeJS.Timeout | null = null;
    let handshakeTimer: NodeJS.Timeout | null = null;
    let chunkAdvanceTimer: NodeJS.Timeout | null = null;
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
    const finalizeTurn = (realThreadId: string, allowParkWs = true) => {
      if (ended) return;
      clearPing();
      clearPostUsageTimer();
      clearAuxTimers();
      const shouldAutoDelete = isIncognito && this.autoDeleteSession;
      if (shouldAutoDelete && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(encodeFrame({ type: "session_delete", payload: { session_id: realThreadId } }));
        } catch { }
      }
      let stopReason: "stop" | "tool_calls" = "stop";
      let emittedToolCalls: Array<{ id: string; name: string }> = [];
      if (toolFilter) {
        const { remainingText, toolCalls } = toolFilter.flush();
        const cleanRem = remainingText && uiTagSanitizer ? uiTagSanitizer.feed(remainingText) : remainingText;
        if (cleanRem) {
          hasEmittedText = true;
          assistantOutputText += cleanRem;
          push({ type: "text", text: cleanRem });
        }
        if (toolCalls.length > 0) {
          emittedToolCalls = toolCalls.map((tc) => ({ id: tc.id, name: tc.name }));
          push({ type: "tool_calls", calls: toolCalls });
          stopReason = "tool_calls";
        }
      }
      if (uiTagSanitizer) {
        const tailText = uiTagSanitizer.flush();
        if (tailText) {
          hasEmittedText = true;
          assistantOutputText += tailText;
          push({ type: "text", text: tailText });
        }
      }
      let parkedForReuse = false;
      if (!shouldAutoDelete && turn.currentInputPrefixHash) {
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
          // Detach turn-scoped listeners BEFORE parking the live WebSocket so idle frames never trigger this turn.
          ws.off("message", onWsMessage);
          ws.off("error", onWsError);
          ws.off("close", onWsClose);
          parkedForReuse = this.setWarmThread({
            scope: turn.scope,
            conversationKey: turn.conversationKey,
            slotId: lease.slotId,
            isIncognito,
            ...(chatAgentId ? { chatAgentId } : {}),
            prefixHashes: nextHashes,
            threadId: realThreadId,
            // Never park a WS that finished via post-usage watchdog (late upstream frames could contaminate next turn).
            ...(allowParkWs ? { ws, outpostId, encodeFrame } : {}),
          });
        }
      }
      wsParked = parkedForReuse;
      ended = true;
      push({ type: "done", stopReason });
      if (parkedForReuse) {
        // Keep dedicated WebSocket open & pinged for next turn (mirrors official Quick desktop app).
      } else if (shouldAutoDelete) {
        const t = setTimeout(() => {
          try {
            ws.close();
          } catch { }
        }, 1000);
        t.unref?.();
      } else {
        try {
          ws.close();
        } catch { }
      }
    };

    const sendChunkMessage = (idx: number) => {
      if (ws.readyState !== WebSocket.OPEN || ended) return;
      const isFinal = idx >= totalChunks - 1;
      const baseChunkText =
        totalChunks === 1
          ? chunks[idx]!
          : isFinal
            ? `[Context Part ${idx + 1}/${totalChunks} — all context has now been provided; reply directly in the user's language without acknowledging or mentioning these context parts]\n\n${chunks[idx]!}`
            : `[Context Part ${idx + 1}/${totalChunks} — memorize silently for the upcoming final message and reply ONLY: OK]\n\n${chunks[idx]!}`;
      const chunkText =
        isFinal && toolBridgePrompt && selection.agentMode === "fast"
          ? `${baseChunkText}\n\n[Client runner note: If accessing a local file, running a command, or invoking an MCP/client tool is needed, output the corresponding <tool_call> JSON block from the available client tools instead of checking AWS Quick connected devices.]`
          : baseChunkText;
      ws.send(
        encodeFrame({
          type: "user_message",
          payload: {
            traceId: crypto.randomUUID(),
            send_origin: "user",
            had_physical_input: true,
            surfaceType,
            outpostId,
            appVersion,
            ...DESKTOP_CAPABILITIES,
            activityType: "chat",
            surface: surfaceName,
            clientVersion: appVersion,
            thread_id: threadId,
            text: chunkText,
            ...(isFinal && effectiveCustomPrompt ? { custom_prompt: effectiveCustomPrompt } : {}),
            ...(isFinal && attachments.length > 0 ? { attachments } : {}),
            message_id: crypto.randomUUID(),
            agent_mode: isFinal ? selection.agentMode : "fast",
            ...(chatAgentId ? { chat_agent_id: chatAgentId } : {}),
            ...(isFinal && selection.agentMode !== "fast" ? { thinking_effort: selection.thinkingEffort } : {}),
            auto_routing: isFinal && turn.requestedModel.trim().toLowerCase() === "auto",
            web_search_enabled: isFinal ? this.webSearchEnabled : false,
            voice_mode: false,
            ...(isIncognito ? { incognito: true } : {}),
            user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            user_locale: process.env.AWS_QUICK_LOCALE?.trim() || "en-US",
          },
        }),
      );
    };

    const startTurnPing = () => {
      clearPing();
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && !ended) {
          try {
            ws.send(encodeFrame({ type: "ping", payload: { timestamp: Date.now() } }));
          } catch { }
        }
      }, 25_000);
    };

    const onWsMessage = (data: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
      const { messages, consumed } = drainEventStream(recvBuf, 0);
      if (consumed > 0) recvBuf = recvBuf.subarray(consumed);

      for (const esMsg of messages) {
        let decoded;
        try {
          decoded = decodeFrame(esMsg);
        } catch {
          continue;
        }
        if (!decoded) continue;
        if (decoded.type === "error") {
          ended = true;
          push({
            type: "__error",
            error: new GatewayError(`[${decoded.code}] ${decoded.message}`, 502, "upstream_error"),
          });
          try {
            ws.close();
          } catch { }
          return;
        }

        const ev = decoded.data;
        const evType = String(ev.type || "");
        const payload = (ev.payload && typeof ev.payload === "object" ? ev.payload : {}) as Record<string, unknown>;

        // Intermediate context chunks (for >46.5KB prompts): advance on message_complete,
        // with an 8s post-turn_usage fallback in case AWS omits message_complete on a chunk.
        const advanceIntermediateChunk = () => {
          if (advancingChunk || ended || activeChunkIndex >= totalChunks - 1) return;
          clearPostUsageTimer();
          advancingChunk = true;
          chunkAdvanceTimer = setTimeout(() => {
            chunkAdvanceTimer = null;
            activeChunkIndex += 1;
            advancingChunk = false;
            sendChunkMessage(activeChunkIndex);
          }, 250);
        };
        if (advancingChunk) {
          if (evType !== "error" && evType !== "guardrail_blocked") continue;
        }
        if (activeChunkIndex < totalChunks - 1) {
          if (evType === "message_complete") {
            advanceIntermediateChunk();
            continue;
          } else if (evType === "turn_usage") {
            clearPostUsageTimer();
            postUsageTimer = setTimeout(() => advanceIntermediateChunk(), 8_000);
            continue;
          } else if (evType === "error" || evType === "guardrail_blocked") {
            // Fall through to normal error handling below
          } else {
            continue;
          }
        }

        const canEmitRoutedThinking = () =>
          this.showRoutedModelInThinking &&
          !emittedRoutedModel &&
          !(turn.stream && this.suppressLateRoutedThinkingInStream && hasEmittedText);

        if (evType === "connected" && cred.mode === "oauth" && cred.oauth) {
          const u = payload.user as Record<string, unknown> | undefined;
          if (u && typeof u === "object") {
            cacheOAuthUserIdentity(cred.oauth.clientId, {
              ...(typeof u.email === "string" ? { email: u.email } : {}),
              ...(typeof u.name === "string" ? { name: u.name } : {}),
              ...(typeof u.aws_account_id === "string" ? { accountId: u.aws_account_id } : {}),
            });
          }
          continue;
        }

        if (evType === "routing_decision") {
          const routed = String(payload.resolved_model_id || payload.model_id || payload.model || "");
          if (routed) {
            resolvedModelId = routed;
            if (canEmitRoutedThinking()) {
              emittedRoutedModel = true;
              push({
                type: "thinking",
                text: `[AWS Quick] mode=${selection.agentMode} · effort=${selection.thinkingEffort} · routed=${routed}\n`,
              });
            }
          }
        } else if (evType === "text_delta") {
          clearPostUsageTimer();
          const delta = String(payload.delta || "");
          if (delta) {
            const afterTools = toolFilter ? toolFilter.feed(delta) : delta;
            const emitText = afterTools && uiTagSanitizer ? uiTagSanitizer.feed(afterTools) : afterTools;
            if (emitText) {
              hasEmittedText = true;
              assistantOutputText += emitText;
              push({ type: "text", text: emitText });
            }
          }
        } else if (evType === "thinking_delta") {
          clearPostUsageTimer();
          const delta = String(payload.delta || "");
          if (delta) push({ type: "thinking", text: delta });
        } else if (evType === "turn_usage") {
          const inputTokens = Number(payload.input_tokens || 0);
          const outputTokens = Number(payload.output_tokens || 0);
          const cacheReadTokens = Number(payload.cache_read_tokens || 0);
          const cacheWriteTokens = Number(payload.cache_write_tokens || 0);
          const served = String(payload.resolved_model_id || payload.served_model_id || "");
          if (served) {
            resolvedModelId = served;
            if (canEmitRoutedThinking()) {
              emittedRoutedModel = true;
              push({
                type: "thinking",
                text: `[AWS Quick] mode=${selection.agentMode} · effort=${selection.thinkingEffort} · routed=${served}\n`,
              });
            }
          }
          this.usageTracker.recordTurn({
            apiKey: lease.apiKey,
            modelId: resolvedModelId ? `${selection.model} (${resolvedModelId})` : selection.model,
            mode: execMode,
            metrics: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
          });
          push({
            type: "usage",
            metrics: {
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              ...(resolvedModelId ? { resolvedModel: resolvedModelId } : {}),
              ...(isIncognito && this.autoDeleteSession ? { sessionDeleted: true } : {}),
            },
          });
          // Guard against AWS Quick occasionally omitting `message_complete` after very long outputs (30K+ output tokens).
          // Only armed once actual output has started and cancelled immediately if any subsequent delta/event arrives.
          if (hasEmittedText || outputTokens > 0) {
            clearPostUsageTimer();
            const usageThreadId = String(ev.thread_id || threadId);
            postUsageTimer = setTimeout(() => {
              // Watchdog-triggered completion must NOT park the WS back into warm pool.
              finalizeTurn(usageThreadId, false);
            }, 15_000);
          }
        } else if (
          evType === "message_complete" ||
          evType === "stream_ended" ||
          evType === "turn_aborted" ||
          evType === "session_end"
        ) {
          finalizeTurn(String(ev.thread_id || threadId));
          return;
        } else if (evType === "session_deleted") {
          clearPostUsageTimer();
          try {
            ws.close();
          } catch { }
          return;
        } else if (evType === "error" || evType === "guardrail_blocked") {
          clearPing();
          clearPostUsageTimer();
          ended = true;
          const errCode = String(payload.error_code || "");
          const errText = typeof payload.error === "string" ? payload.error : "";
          let gatewayErr: GatewayError;
          if (evType === "guardrail_blocked" || errCode === "content_filtered") {
            gatewayErr = new GatewayError(
              "AWS Quick upstream content filter blocked this reply (content_filtered — triggered by AWS Bedrock Guardrail, e.g. sensitive/credential keywords, not a gateway outage). Rephrase or start a new chat. / 上游 AWS Quick 内容安全审核拦截了本次回复（非网关故障，通常因触发密码/密钥等敏感词风控），请调整措辞或新开会话。",
              400,
              "content_filter",
            );
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
          try {
            ws.close();
          } catch { }
          return;
        }
      }
    };

    const onWsError = (err: Error) => {
      clearPing();
      clearPostUsageTimer();
      if (!ended) {
        ended = true;
        push({ type: "__error", error: mapSdkError(err) });
      }
    };

    const onWsClose = (code: number, reason: Buffer) => {
      clearPing();
      clearPostUsageTimer();
      if (!ended) {
        ended = true;
        push({
          type: "__error",
          error: new GatewayError(`WebSocket closed (${code}): ${reason.toString("utf8")}`, 502, "upstream_error"),
        });
      }
    };

    ws.on("message", onWsMessage);
    ws.once("error", onWsError);
    ws.once("close", onWsClose);

    if (reusedWs && ws === reusedWs && ws.readyState === WebSocket.OPEN) {
      startTurnPing();
      sendChunkMessage(0);
    } else {
      ws.once("open", () => {
        ws.send(
          encodeFrame({
            type: "session_connect",
            payload: {
              ...(actorArn ? { actor_id: actorArn } : {}),
              surfaceType,
              outpostId,
              appVersion,
              ...DESKTOP_CAPABILITIES,
            },
          }),
        );
        if (!isWeb) {
          ws.send(
            encodeFrame({
              type: "federate_status",
              payload: {},
            }),
          );
        }
        startTurnPing();
        handshakeTimer = setTimeout(() => {
          handshakeTimer = null;
          sendChunkMessage(0);
        }, 200);
      });
    }

    try {
      while (true) {
        await waitNext();
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (item.type === "__error") {
            throw item.error;
          }
          yield item;
          if (item.type === "done") return;
        }
        if (ended) return;
      }
    } finally {
      const nextActive = (this.activeWsBySlot.get(lease.slotId) || 1) - 1;
      if (nextActive <= 0) this.activeWsBySlot.delete(lease.slotId);
      else this.activeWsBySlot.set(lease.slotId, nextActive);
      clearPing();
      clearPostUsageTimer();
      clearAuxTimers();
      clearTimeout(timer);
      turn.signal?.removeEventListener("abort", onAbort);
      // Note: `lease.release()` is owned exclusively by `executeTurnWithPool` so retries keep accurate inflight counts.
      if (!wsParked) {
        ws.off("message", onWsMessage);
        ws.off("error", onWsError);
        ws.off("close", onWsClose);
        if (!(ended && isIncognito && this.autoDeleteSession)) {
          try {
            ws.close();
          } catch { }
        }
      }
    }
  }

  /**
   * Best-effort 15s `quick-fast` summary of an omitted middle section when a caller exceeds
   * `AUTO_COMPACT_OVERFLOW_TOKENS` (~850K tokens). Falls back cleanly to head+tail trim on any error.
   */
  private async summarizeOverflowMiddle(
    middleSample: string,
    lease: ReturnType<UpstreamKeyPool["leaseKey"]>,
    parentSignal?: AbortSignal,
    chatAgentId?: string,
  ): Promise<string | undefined> {
    const cacheKey = crypto.createHash("sha256").update(middleSample).digest("hex");
    const now = Date.now();
    const cached = this.overflowSummaryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.summary;
    }
    if (cached) this.overflowSummaryCache.delete(cacheKey);

    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => ac.abort(), 15_000);
    timeout.unref?.();
    try {
      const summaryTurn: ParsedProtocolTurn = {
        scope: "internal-compact",
        requestedModel: "quick-fast",
        stream: false,
        systemPrompt: "You are a concise context compactor. Summarize the key facts, decisions, code identifiers, file paths, and open tasks from this earlier conversation excerpt in <= 400 words.",
        fullTranscriptText: middleSample,
        images: [],
        tools: [],
        toolChoice: "none",
        trailingToolResults: [],
        estimatedInputTokens: estimatePromptTokens(middleSample),
        conversationKey: `compact-${crypto.randomUUID()}`,
        rawBody: { __internalSummary: true },
        signal: ac.signal,
      };
      let out = "";
      const subLease = { ...lease, release: () => { }, markSuccess: () => { } };
      for await (const ev of this.executeTurnWithLease(summaryTurn, subLease, true, undefined, chatAgentId)) {
        if (ev.type === "text") out += ev.text;
      }
      const trimmed = out.trim();
      if (trimmed) {
        while (this.overflowSummaryCache.size >= 32) {
          const oldest = this.overflowSummaryCache.keys().next().value;
          if (!oldest) break;
          this.overflowSummaryCache.delete(oldest);
        }
        this.overflowSummaryCache.set(cacheKey, { summary: trimmed, expiresAt: Date.now() + 30 * 60 * 1000 });
        return trimmed;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }
}
