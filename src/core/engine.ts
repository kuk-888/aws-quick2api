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
import { extendHashWithAssistantReply, redactSecrets } from "../utils/hash.js";
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
 * Splits a UTF-8 string into chunks each strictly <= `maxFrameBytes` UTF-8 bytes,
 * preferring newline boundaries and never splitting UTF-16 surrogate pairs.
 */
export function splitPromptIntoSafeChunks(
  prompt: string,
  customPrompt: string | null,
  maxFrameBytes = MAX_WS_PAYLOAD_UTF8_BYTES,
): { chunks: string[]; effectiveCustomPrompt: string | null } {
  const customBytes = customPrompt ? Buffer.byteLength(customPrompt, "utf8") : 0;
  const promptBytes = Buffer.byteLength(prompt, "utf8");

  if (promptBytes + customBytes <= maxFrameBytes) {
    return { chunks: [prompt], effectiveCustomPrompt: customPrompt };
  }

  let effectiveCustomPrompt = customPrompt;
  let fullText = prompt;
  if (customPrompt && customBytes > MAX_INLINE_CUSTOM_PROMPT_BYTES) {
    // Keep the tail (including any tool-bridge instructions) inside native `custom_prompt`
    // so AWS Quick does not treat system/tool instructions as untrusted user-message prompt injection.
    const keepBudget = Math.min(MAX_INLINE_CUSTOM_PROMPT_BYTES, Math.max(8_192, maxFrameBytes - 10_000));
    let keepStart = customPrompt.length;
    let keptBytes = 0;
    while (keepStart > 0) {
      const prevIdx = keepStart - 1;
      const chBytes = Buffer.byteLength(customPrompt[prevIdx]!, "utf8");
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

  const reserved = effectiveCustomPrompt ? Buffer.byteLength(effectiveCustomPrompt, "utf8") : 0;
  const chunkLimit = Math.max(8_192, maxFrameBytes - reserved - 256);

  const chunks: string[] = [];
  let offset = 0;
  const len = fullText.length;

  while (offset < len) {
    if (Buffer.byteLength(fullText.slice(offset), "utf8") <= chunkLimit) {
      chunks.push(fullText.slice(offset));
      break;
    }

    let lo = offset + 1;
    let hi = Math.min(len, offset + chunkLimit);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(fullText.slice(offset, mid), "utf8") <= chunkLimit) {
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
const MAX_WARM_THREADS = 256;

export class QuickExecutionEngine {
  private readonly config: GatewayConfig;
  private readonly usageTracker: UsageTracker;
  private readonly modelListFetcher?: (apiKey: string) => Promise<SDKModel[]>;
  private readonly incognito: boolean;
  private readonly autoDeleteSession: boolean;
  private readonly showRoutedModelInThinking: boolean;
  private readonly suppressLateRoutedThinkingInStream: boolean;
  private readonly webSearchEnabled: boolean;
  private readonly sanitizeAwsUiTags: boolean;
  private readonly workingSessionIds = new Map<string, string>();
  private readonly warmThreads = new Map<string, { threadId: string; expiresAt: number }>();
  private readonly overflowSummaryCache = new Map<string, { summary: string; expiresAt: number }>();

  private warmKey(
    scope: string | undefined,
    conversationKey: string | undefined,
    slotId: string,
    prefixHash: string
  ): string {
    return `${scope || "default"}|${conversationKey || "-"}|${slotId}|${prefixHash}`;
  }

  private lookupWarmThread(
    scope: string | undefined,
    conversationKey: string | undefined,
    slotId: string,
    prefixHash: string
  ): string | undefined {
    const key = this.warmKey(scope, conversationKey, slotId, prefixHash);
    const hit = this.warmThreads.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.warmThreads.delete(key);
      return undefined;
    }
    // Consume the previous prefix entry once reused so each turn advances cleanly
    this.warmThreads.delete(key);
    return hit.threadId;
  }

  private setWarmThread(
    scope: string | undefined,
    conversationKey: string | undefined,
    slotId: string,
    prefixHash: string,
    threadId: string
  ): void {
    const now = Date.now();
    const maxWarm = this.config.maxWarmSessions || MAX_WARM_THREADS;
    const warmTtlMs = this.config.warmSessionTtlMs || WARM_THREAD_TTL_MS;
    if (this.warmThreads.size >= maxWarm) {
      for (const [k, v] of this.warmThreads) {
        if (v.expiresAt <= now) this.warmThreads.delete(k);
      }
      while (this.warmThreads.size >= maxWarm) {
        const oldest = this.warmThreads.keys().next().value;
        if (!oldest) break;
        this.warmThreads.delete(oldest);
      }
    }
    this.warmThreads.set(this.warmKey(scope, conversationKey, slotId, prefixHash), {
      threadId,
      expiresAt: now + warmTtlMs,
    });
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
    this.showRoutedModelInThinking = process.env.SHOW_ROUTED_MODEL_IN_THINKING !== "false";
    this.suppressLateRoutedThinkingInStream =
      process.env.SUPPRESS_LATE_ROUTED_THINKING_IN_STREAM === "true";
    this.webSearchEnabled = process.env.WEB_SEARCH_ENABLED !== "false";
    this.sanitizeAwsUiTags = process.env.SANITIZE_AWS_UI_TAGS !== "false";
  }

  runtimeStats() {
    return {
      parkedToolSessions: 0,
      warmIncrementalSessions: this.warmThreads.size,
      warmIdleSessions: 0,
      memoryStore: { blobs: 0, totalBytes: 0 },
    };
  }

  async sweepStaleAssets(): Promise<void> {
    // AWS Quick streams over WebSocket without local temp blobs.
  }

  async disposeAll(): Promise<void> {
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

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const lease = keyPool.leaseKey(turn.requestedModel, excluded.size > 0 ? excluded : undefined, turn.conversationKey);
      const isIncognito = keyPool.getSettings().incognitoMode;
      let yieldedOutput = false;

      try {
        for await (const ev of this.executeTurnWithLease(turn, lease, isIncognito, onExecMeta)) {
          if (ev.type === "text" || ev.type === "thinking" || ev.type === "tool_calls") {
            yieldedOutput = true;
          }
          yield ev;
        }
        lease.markSuccess();
        return;
      } catch (err) {
        const gwErr = mapSdkError(err);
        const msg = gwErr.message || "";
        const lower = msg.toLowerCase();
        const isQuotaErr =
          gwErr.code === "quota_exhausted" ||
          gwErr.status === 402 ||
          /quota|usage.?limit|limit.?exceeded|insufficient|exhausted|credits?/i.test(lower);
        const isRateLimitErr =
          !isQuotaErr &&
          (gwErr.status === 429 || /rate.?limit|too many requests|throttl/i.test(lower));
        const isAuthErr =
          gwErr.code !== "model_not_available" &&
          (gwErr.status === 401 ||
            gwErr.status === 403 ||
            /unauthorized|invalid.?grant|expired|access.?denied|authentication|oauth token refresh failed|session cookie/i.test(lower));

        const isProxyOrConnErr =
          !isQuotaErr &&
          !isRateLimitErr &&
          !isAuthErr &&
          (gwErr.status === 502 ||
            gwErr.status === 503 ||
            /proxy connect failed|econnrefused|econnreset|etimedout|socket hang up|unexpected server response|websocket closed \(1006\)/i.test(lower));

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
        throw gwErr;
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
  ): AsyncGenerator<GatewayStreamEvent, void, unknown> {
    const warmThreadId =
      !(isIncognito && this.autoDeleteSession) &&
        turn.priorPrefixHash &&
        turn.incrementalUserText !== undefined
        ? this.lookupWarmThread(turn.scope, turn.conversationKey, lease.slotId, turn.priorPrefixHash)
        : undefined;
    const isWarmIncremental = Boolean(warmThreadId);
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

    const toolBridgePrompt = buildToolBridgePrompt(turn.tools, turn.toolChoice);
    const customPromptParts: string[] = [];
    if (turn.systemPrompt?.trim()) {
      customPromptParts.push(
        sanitizeClientSystemPromptForQuick(turn.systemPrompt.trim(), Boolean(toolBridgePrompt)),
      );
    }
    if (toolBridgePrompt) customPromptParts.push(toolBridgePrompt);
    const customPrompt = customPromptParts.length > 0 ? customPromptParts.join("\n\n") : null;

    const sourceImages = isWarmIncremental ? (turn.incrementalImages ?? []) : turn.images;
    const rawPromptText = isWarmIncremental ? turn.incrementalUserText : turn.fullTranscriptText;
    // Dynamically reserve room for prompt + customPrompt (e.g. 24 tool definitions) so single-turn
    // multimodal requests stay inside 1 WebSocket frame (~9s) instead of splitting into 2-3 serial chunks (~26s).
    const approxTextBytes =
      Buffer.byteLength(rawPromptText || "", "utf8") + Buffer.byteLength(customPrompt || "", "utf8");
    const adaptiveImageBudget = Math.max(18_000, Math.min(38_000, 44_000 - approxTextBytes));
    const attachments = await buildQuickImageAttachments(sourceImages, turn.signal, adaptiveImageBudget);
    let prompt = rawPromptText?.trim() || (attachments.length > 0 ? "Please analyze the attached image(s)." : "");
    if (!prompt) {
      throw new GatewayError("Empty prompt", 400, "invalid_request_error");
    }

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
          middleSummary = await this.summarizeOverflowMiddle(initialCompact.middleSample, lease, turn.signal).catch(() => undefined);
        }
        prompt = middleSummary
          ? compactOversizedPrompt(prompt, customPrompt, overflowLimit, middleSummary).prompt
          : initialCompact.prompt;
      }
    }
    const toolFilter = toolBridgePrompt ? new StreamingToolCallFilter() : null;
    const uiTagSanitizer = this.sanitizeAwsUiTags ? new StreamingUiTagSanitizer() : null;

    const { selection } = await this.resolveModel(lease.apiKey, turn.requestedModel, turn.rawBody);

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
    let outpostId = "web0";
    const effectiveProxy = lease.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const wsAgent = getProxyAgent(effectiveProxy);

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
        lease.release();
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
    let pingTimer: NodeJS.Timeout | null = null;
    const clearPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const sendChunkMessage = (idx: number) => {
      if (ws.readyState !== WebSocket.OPEN || ended) return;
      const isFinal = idx >= totalChunks - 1;
      const baseChunkText =
        totalChunks === 1
          ? chunks[idx]!
          : isFinal
            ? `[Context Part ${idx + 1}/${totalChunks} — all context has now been provided; please answer the user's request directly]\n\n${chunks[idx]!}`
            : `[Context Part ${idx + 1}/${totalChunks} — memorize silently for the upcoming final message and reply ONLY: OK]\n\n${chunks[idx]!}`;
      const chunkText =
        isFinal && toolBridgePrompt
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
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && !ended) {
          try {
            ws.send(encodeFrame({ type: "ping", payload: { timestamp: Date.now() } }));
          } catch { }
        }
      }, 25_000);

      setTimeout(() => {
        sendChunkMessage(0);
      }, 200);
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

        // Intermediate context chunks (for >50KB prompts): silently advance to next chunk on message_complete.
        if (advancingChunk) {
          if (evType !== "error" && evType !== "guardrail_blocked") continue;
        }
        if (activeChunkIndex < totalChunks - 1) {
          if (evType === "message_complete") {
            advancingChunk = true;
            setTimeout(() => {
              activeChunkIndex += 1;
              advancingChunk = false;
              sendChunkMessage(activeChunkIndex);
            }, 250);
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
        } else if (evType === "message_complete" || evType === "stream_ended" || evType === "turn_aborted") {
          clearPing();
          const realThreadId = String(ev.thread_id || threadId);
          const shouldAutoDelete = isIncognito && this.autoDeleteSession;
          if (shouldAutoDelete && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(encodeFrame({ type: "session_delete", payload: { session_id: realThreadId } }));
            } catch { }
          }
          let stopReason: "stop" | "tool_calls" = "stop";
          if (toolFilter) {
            const { remainingText, toolCalls } = toolFilter.flush();
            const cleanRem = remainingText && uiTagSanitizer ? uiTagSanitizer.feed(remainingText) : remainingText;
            if (cleanRem) {
              hasEmittedText = true;
              assistantOutputText += cleanRem;
              push({ type: "text", text: cleanRem });
            }
            if (toolCalls.length > 0) {
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
          if (
            !shouldAutoDelete &&
            stopReason === "stop" &&
            turn.currentInputPrefixHash &&
            assistantOutputText.trim().length > 0
          ) {
            const nextHash = extendHashWithAssistantReply(turn.currentInputPrefixHash, assistantOutputText);
            this.setWarmThread(turn.scope, turn.conversationKey, lease.slotId, nextHash, realThreadId);
          }
          ended = true;
          push({ type: "done", stopReason });
          if (shouldAutoDelete) {
            setTimeout(() => {
              try {
                ws.close();
              } catch { }
            }, 1000);
          } else {
            try {
              ws.close();
            } catch { }
          }
          return;
        } else if (evType === "session_deleted") {
          try {
            ws.close();
          } catch { }
          return;
        } else if (evType === "error" || evType === "guardrail_blocked") {
          clearPing();
          ended = true;
          const errCode = String(payload.error_code || "");
          const errText = typeof payload.error === "string" ? payload.error : "";
          let gatewayErr: GatewayError;
          if (evType === "guardrail_blocked" || errCode === "content_filtered") {
            gatewayErr = new GatewayError(
              "AWS Quick content filter blocked this reply (content_filtered). Rephrase or start a new chat.",
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
    });

    ws.once("error", (err) => {
      clearPing();
      if (!ended) {
        ended = true;
        push({ type: "__error", error: mapSdkError(err) });
      }
    });

    ws.once("close", (code, reason) => {
      clearPing();
      if (!ended) {
        ended = true;
        push({
          type: "__error",
          error: new GatewayError(`WebSocket closed (${code}): ${reason.toString("utf8")}`, 502, "upstream_error"),
        });
      }
    });

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
      clearPing();
      clearTimeout(timer);
      turn.signal?.removeEventListener("abort", onAbort);
      lease.release();
      // Close immediately unless a normal incognito+autoDeleteSession turn is awaiting session_deleted (1s max).
      if (!(ended && isIncognito && this.autoDeleteSession)) {
        try {
          ws.close();
        } catch { }
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
      for await (const ev of this.executeTurnWithLease(summaryTurn, subLease, true)) {
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
