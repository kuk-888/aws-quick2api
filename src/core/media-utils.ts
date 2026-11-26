import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import sharp from "sharp";
import type { QuickFileAttachment } from "../aws-quick/oauth-client.js";
import { redactSecrets } from "../utils/hash.js";
import { GatewayError, type NormalizedFile, type NormalizedImage } from "./types.js";

export interface QuickImageAttachment {
  type: "image";
  name: string;
  size: number;
  mimeType: string;
  contentSha256: string;
  data: string;
}

export type QuickAttachment = QuickImageAttachment | QuickFileAttachment;

export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
// AWS Quick WebSocket `user_message` enforces a hard 50,000-byte single-frame ceiling.
// Keep total inline image base64 payload <= 40,000 chars (~30 KB raw) so text + JSON envelope always fit safely.
export const MAX_TOTAL_IMAGE_BASE64_CHARS = 40_000;
export const MAX_INLINE_IMAGES = 10;
export const MAX_INLINE_FILES = 5;
export const MAX_HIGHRES_IMAGE_DIMENSION = 4096;
export const MAX_HIGHRES_RAW_BYTES = 8 * 1024 * 1024;
export const OAUTH_DIRECT_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
export const MAX_REMOTE_IMAGE_REDIRECTS = 3;
export const MAX_WS_RECV_BUF_BYTES = 16 * 1024 * 1024;
export const MAX_WS_PAYLOAD_UTF8_BYTES = 50_000;
export const WS_FRAME_ENVELOPE_MARGIN_BYTES = 3_500;
export const MAX_INLINE_CUSTOM_PROMPT_BYTES = 36_000;

export function clampSurrogateEnd(str: string, end: number): number {
  if (end > 0 && end < str.length) {
    const code = str.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) return end - 1;
  }
  return end;
}

export function clampSurrogateStart(str: string, start: number): number {
  if (start > 0 && start < str.length) {
    const code = str.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) return start + 1;
  }
  return start;
}

/**
 * Build a compact inline wrapper prompt when an oversized (>46KB) conversation/context
 * has been uploaded out-of-band as a `.txt` attachment. Preserves BOTH the opening of the
 * latest user request (for "question first, logs after" inputs) and the trailing context inline
 * so the model immediately sees the user's request regardless of placement.
 */
export function buildOutOfBandContextPrompt(
  fullPrompt: string,
  filename: string,
  maxInlineChars = 3_500,
  isIncremental = false,
  openingHintSource?: string,
): string {
  const totalChars = fullPrompt.length;
  const label = isIncremental ? "incremental context" : "full conversation/context";
  const header = `[The ${label} (${totalChars.toLocaleString()} chars) is attached in \`${filename}\`. Read the attached file for the full text/details, then respond directly to the user's request.]`;

  if (totalChars <= maxInlineChars) {
    return [header, "", fullPrompt.trim()].join("\n");
  }

  const headBudget = Math.min(1_100, Math.floor(maxInlineChars * 0.32));
  const tailBudget = Math.max(800, maxInlineChars - headBudget);

  let tailStart = Math.max(0, totalChars - tailBudget);
  if (tailStart > 0) {
    const nextNl = fullPrompt.indexOf("\n", tailStart);
    if (nextNl !== -1 && nextNl < tailStart + 400) {
      tailStart = nextNl + 1;
    }
    tailStart = clampSurrogateStart(fullPrompt, tailStart);
  }
  const tailText = fullPrompt.slice(tailStart).trimStart();

  const useExplicitHint = Boolean(openingHintSource && openingHintSource.trim());
  const headSource = useExplicitHint ? openingHintSource! : fullPrompt;
  let headSnippet = "";
  let headMergedContiguously = false;
  if (headSource.length > headBudget) {
    let headEnd = headBudget;
    const prevNl = headSource.lastIndexOf("\n", headEnd);
    if (prevNl > Math.floor(headBudget * 0.5)) {
      headEnd = prevNl;
    } else {
      const nextNl = headSource.indexOf("\n", headEnd);
      if (nextNl !== -1 && nextNl < headEnd + 250) headEnd = nextNl;
    }
    if (!useExplicitHint && headEnd >= tailStart) {
      headEnd = tailStart;
      headMergedContiguously = true;
    }
    headEnd = clampSurrogateEnd(headSource, headEnd);
    headSnippet = headSource.slice(0, headEnd).trim();
  } else {
    headSnippet = headSource.trim();
  }

  // Deduplicate partial overlap when openingHintSource (latest user turn) overlaps the start of tailText
  let includeHead = Boolean(headSnippet) && !tailText.includes(headSnippet);
  if (includeHead && useExplicitHint && tailText.length >= 24) {
    const tailProbe = tailText.slice(0, Math.min(80, tailText.length));
    const overlapIdx = headSnippet.indexOf(tailProbe);
    if (overlapIdx === 0) {
      includeHead = false;
    } else if (overlapIdx > 0) {
      headSnippet = headSnippet.slice(0, clampSurrogateEnd(headSnippet, overlapIdx)).trimEnd();
      headMergedContiguously = true;
      includeHead = Boolean(headSnippet);
    }
  }

  const bodyParts = includeHead
    ? headMergedContiguously
      ? [`[Opening of latest request]\n${headSnippet}`, tailText]
      : [`[Opening of latest request]\n${headSnippet}`, "...", `[Trailing context]\n${tailText}`]
    : [tailText];

  return [header, "", ...bodyParts].join("\n");
}

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

export function extForImageMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "png";
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function resolveRawImagePayloads(
  images: readonly NormalizedImage[] | undefined,
  signal?: AbortSignal,
): Promise<Array<{ buf: Buffer; mimeType: string }>> {
  if (!images || images.length === 0) return [];
  if (images.length > MAX_INLINE_IMAGES) {
    throw new GatewayError(
      `Too many images in request (${images.length}; max supported per turn is ${MAX_INLINE_IMAGES}).`,
      400,
      "invalid_request_error",
    );
  }
  const resolved: Array<{ buf: Buffer; mimeType: string }> = [];

  for (const img of images) {
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
        const { contentType, buf } = await fetchSafeRemoteImage(url, signal);
        const ct = contentType.split(";")[0]?.trim().toLowerCase();
        if (!ct || !ct.startsWith("image/")) {
          throw new GatewayError("Remote image URL did not return an image/* Content-Type.", 400, "invalid_image_type");
        }
        mimeType = ct;
        rawBase64 = buf.toString("base64");
      } else {
        continue;
      }
    }
    if (!rawBase64) continue;
    resolved.push({ buf: Buffer.from(rawBase64, "base64"), mimeType: mimeType.toLowerCase() });
  }
  return resolved;
}

export async function prepareHighResImageForOutOfBand(
  buf: Buffer,
  mimeType: string,
): Promise<{ buf: Buffer; mimeType: string }> {
  const normMime = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  if (OAUTH_DIRECT_IMAGE_MIMES.has(normMime) && buf.byteLength <= MAX_HIGHRES_RAW_BYTES) {
    try {
      const meta = await sharp(buf).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (w <= MAX_HIGHRES_IMAGE_DIMENSION && h <= MAX_HIGHRES_IMAGE_DIMENSION) {
        return { buf, mimeType: normMime };
      }
    } catch {
      return { buf, mimeType: normMime };
    }
  }
  try {
    const outBuf = await sharp(buf)
      .rotate()
      .resize({
        width: MAX_HIGHRES_IMAGE_DIMENSION,
        height: MAX_HIGHRES_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
    return { buf: outBuf, mimeType: "image/jpeg" };
  } catch {
    return { buf, mimeType: normMime };
  }
}

export async function resolveNormalizedFiles(
  files: readonly NormalizedFile[] | undefined,
  signal?: AbortSignal,
): Promise<Array<{ filename: string; mimeType: string; buf: Buffer }>> {
  if (!files || files.length === 0) return [];
  if (files.length > MAX_INLINE_FILES) {
    throw new GatewayError(
      `Too many files in request (${files.length}; max supported per turn is ${MAX_INLINE_FILES}).`,
      400,
      "invalid_request_error",
    );
  }
  const out: Array<{ filename: string; mimeType: string; buf: Buffer }> = [];
  for (const f of files) {
    let buf: Buffer;
    let mimeType = f.mimeType.trim().toLowerCase() || "application/octet-stream";
    if (f.data) {
      buf = Buffer.from(f.data, "base64");
    } else if (f.url) {
      const fetched = await fetchSafeRemoteImage(f.url, signal);
      buf = fetched.buf;
      const remoteCt = fetched.contentType.split(";")[0]?.trim().toLowerCase();
      if (remoteCt && remoteCt !== "application/octet-stream") {
        mimeType = remoteCt;
      }
    } else {
      continue;
    }
    if (buf.byteLength === 0) continue;
    if (buf.byteLength > MAX_REMOTE_IMAGE_BYTES) {
      throw new GatewayError(`Attached file '${f.filename}' exceeds 10 MB limit.`, 400, "payload_too_large");
    }
    out.push({ filename: f.filename, mimeType, buf });
  }
  return out;
}

export async function compressResolvedImagesForQuickFrame(
  resolved: ReadonlyArray<{ buf: Buffer; mimeType: string }>,
  totalBase64Budget = MAX_TOTAL_IMAGE_BASE64_CHARS,
): Promise<QuickImageAttachment[]> {
  if (resolved.length === 0) return [];
  const effectiveTotalBudget = Math.max(12_000, Math.min(MAX_TOTAL_IMAGE_BASE64_CHARS, totalBase64Budget));
  // Scale per-image budget strictly by image count (floor 2.4KB) so 6-10 images never exceed 50KB total.
  const perImageBudget = Math.max(2_400, Math.floor(effectiveTotalBudget / resolved.length));
  const out: QuickImageAttachment[] = [];

  for (const { buf, mimeType } of resolved) {
    const fitted = await compressImageForQuickFrame(buf, mimeType, perImageBudget);
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

/**
 * Convert OpenAI/Anthropic NormalizedImage entries into AWS Quick `user_message.payload.attachments`.
 * Supports inline base64, `data:image/...;base64,...` URIs, and remote `http(s)://` image URLs.
 */
export async function buildQuickImageAttachments(
  images: readonly NormalizedImage[] | undefined,
  signal?: AbortSignal,
  totalBase64Budget = MAX_TOTAL_IMAGE_BASE64_CHARS,
): Promise<QuickImageAttachment[]> {
  const resolved = await resolveRawImagePayloads(images, signal);
  return compressResolvedImagesForQuickFrame(resolved, totalBase64Budget);
}

export function mapAttachmentUploadError(err: unknown, contextLabel: string): GatewayError {
  if (err instanceof GatewayError) return err;
  if (
    err instanceof Error &&
    (err.name === "AbortError" || /this operation was aborted|the operation was aborted/i.test(err.message))
  ) {
    return new GatewayError("Request aborted by client.", 499, "client_aborted");
  }
  const raw = err instanceof Error ? err.message : String(err || "unknown");
  const reason = redactSecrets(raw);
  if (/blocked by aws quick dlp policy/i.test(reason)) {
    return new GatewayError(reason, 400, "content_filtered");
  }
  const statusMatch = /\((\d{3})\)/.exec(reason);
  const upstreamStatus = statusMatch ? Number(statusMatch[1]) : 0;
  const isOidcRefresh = /oidc refresh_token failed/i.test(reason);
  if (upstreamStatus === 429) {
    return new GatewayError(`${contextLabel}: ${reason}`, 429, "rate_limit_exceeded");
  }
  if (!isOidcRefresh && (upstreamStatus === 401 || upstreamStatus === 403)) {
    return new GatewayError(`${contextLabel}: ${reason}`, upstreamStatus, "upstream_auth_error");
  }
  if (!isOidcRefresh && upstreamStatus >= 400 && upstreamStatus < 500) {
    return new GatewayError(`${contextLabel}: ${reason}`, upstreamStatus, "invalid_request_error");
  }
  return new GatewayError(`${contextLabel}: ${reason}`, 502, "upstream_error");
}

export function appendWsRecvBuf(
  recvBuf: Buffer<ArrayBuffer>,
  data: Buffer | ArrayBuffer | Buffer[],
): Buffer<ArrayBuffer> {
  const chunk = (Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data)) as Buffer<ArrayBuffer>;
  if (recvBuf.length + chunk.length > MAX_WS_RECV_BUF_BYTES) {
    throw new GatewayError("Upstream WebSocket frame buffer exceeded 16 MB limit.", 502, "upstream_frame_too_large");
  }
  return recvBuf.length === 0 ? chunk : (Buffer.concat([recvBuf, chunk]) as Buffer<ArrayBuffer>);
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((s) => Number(s));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local & cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true; // IETF protocol / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Expands any valid IPv6 literal (including `::` shorthand, zone IDs, and embedded dotted-quad IPv4)
 * into its canonical 8 × 16-bit integer groups.
 */
function parseIpv6ToGroups(raw: string): number[] | null {
  const withoutZone = raw.split("%")[0]!.toLowerCase();
  let normalized = withoutZone;
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon >= 0 && normalized.slice(lastColon + 1).includes(".")) {
    const ipv4Tail = normalized.slice(lastColon + 1);
    if (!net.isIPv4(ipv4Tail)) return null;
    const octets = ipv4Tail.split(".").map((s) => Number(s));
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const full = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (full.length !== 8) return null;
  const groups: number[] = [];
  for (const g of full) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

function groupsToIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isPrivateOrReservedIp(raw: string): boolean {
  const ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(ip)) return isPrivateOrReservedIpv4(ip);
  if (net.isIPv6(ip)) {
    const g = parseIpv6ToGroups(ip);
    if (!g) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
    const allZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0;
    const isLoopback = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1;
    if (allZero || isLoopback) return true;
    // IPv4-mapped ::ffff:0:0/96 (covers both dotted ::ffff:127.0.0.1 and WHATWG hex ::ffff:7f00:1)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return isPrivateOrReservedIpv4(groupsToIpv4(g6, g7));
    }
    // IPv4-compatible ::/96 (deprecated RFC 4291, e.g. ::7f00:1)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return isPrivateOrReservedIpv4(groupsToIpv4(g6, g7));
    }
    // IPv4-translated ::ffff:0:0:0/96 (RFC 2765)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
      return isPrivateOrReservedIpv4(groupsToIpv4(g6, g7));
    }
    // NAT64 well-known 64:ff9b::/96 & local-use 64:ff9b:1::/48
    if (g0 === 0x0064 && g1 === 0xff9b && ((g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) || g2 === 0x0001)) {
      return true;
    }
    // 6to4 2002::/16 (embeds IPv4 in g1..g2)
    if (g0 === 0x2002) {
      return isPrivateOrReservedIpv4(groupsToIpv4(g1, g2));
    }
    // Teredo 2001:0000::/32 (tunneling)
    if (g0 === 0x2001 && g1 === 0x0000) return true;
    // Discard 0100::/64
    if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
    // Documentation 2001:db8::/32
    if (g0 === 0x2001 && g1 === 0x0db8) return true;
    // ULA fc00::/7
    if ((g0 & 0xfe00) === 0xfc00) return true;
    // Link-local fe80::/10 & deprecated site-local fec0::/10
    if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
    // Multicast ff00::/8
    if ((g0 & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

export async function assertSafeRemoteImageUrl(rawUrl: string): Promise<{
  parsed: URL;
  pinnedIp: string;
  family: 4 | 6;
}> {
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
  const bareHost = host.replace(/^\[|\]$/g, "");
  if (
    !bareHost ||
    bareHost === "localhost" ||
    bareHost.endsWith(".localhost") ||
    bareHost.endsWith(".local") ||
    bareHost.endsWith(".internal")
  ) {
    throw new GatewayError("Blocked private/internal image URL host.", 400, "ssrf_blocked");
  }
  const ipVer = net.isIP(bareHost);
  if (ipVer === 4 || ipVer === 6) {
    if (isPrivateOrReservedIp(bareHost)) {
      throw new GatewayError("Blocked private/internal image URL IP.", 400, "ssrf_blocked");
    }
    return { parsed, pinnedIp: bareHost, family: ipVer };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(bareHost, { all: true, verbatim: true });
  } catch {
    throw new GatewayError("Failed to resolve image URL hostname.", 400, "invalid_image_url");
  }
  if (!addrs.length || addrs.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new GatewayError("Blocked image URL resolving to private/internal IP.", 400, "ssrf_blocked");
  }
  const first = addrs[0]!;
  return {
    parsed,
    pinnedIp: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}

export function pinnedHttpGet(
  parsed: URL,
  pinnedIp: string,
  family: 4 | 6,
  signal?: AbortSignal,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GatewayError("Remote image request aborted.", 499, "request_aborted"));
      return;
    }
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const bareHostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const req = mod.request(
      {
        hostname: bareHostname,
        port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          Host: parsed.host,
          "User-Agent": "aws-quick2api/image-fetch",
        },
        ...(isHttps && !net.isIP(bareHostname) ? { servername: bareHostname } : {}),
        // Pin DNS resolution directly to the validated IP to eliminate DNS Rebinding (TOCTOU).
        // Node >=20 enables `autoSelectFamily` by default and passes `{ all: true }` to custom lookup.
        lookup: (_hostname, opts, cb) => {
          if (opts && typeof opts === "object" && opts.all) {
            (cb as unknown as (err: NodeJS.ErrnoException | null, addrs: Array<{ address: string; family: number }>) => void)(
              null,
              [{ address: pinnedIp, family }],
            );
          } else {
            cb(null, pinnedIp, family);
          }
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          done(() => resolve({ status, headers: res.headers, buf: Buffer.alloc(0) }));
          return;
        }
        const declaredLen = Number(res.headers["content-length"] || "0");
        if (Number.isFinite(declaredLen) && declaredLen > MAX_REMOTE_IMAGE_BYTES) {
          res.destroy();
          req.destroy();
          done(() => reject(new GatewayError("Remote image exceeds 10 MB limit.", 400, "image_too_large")));
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on("data", (chunk: Buffer) => {
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += b.byteLength;
          if (totalBytes > MAX_REMOTE_IMAGE_BYTES) {
            res.destroy();
            req.destroy();
            done(() => reject(new GatewayError("Remote image exceeds 10 MB limit.", 400, "image_too_large")));
            return;
          }
          chunks.push(b);
        });
        res.on("end", () => {
          done(() => resolve({ status, headers: res.headers, buf: Buffer.concat(chunks) }));
        });
        res.on("error", (err) => done(() => reject(err)));
      },
    );
    const onAbort = () => {
      req.destroy();
      done(() => reject(new GatewayError("Remote image request aborted.", 499, "request_aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new GatewayError("Timed out fetching remote image URL.", 400, "invalid_image_url")));
    }, 15_000);
    timer.unref?.();
    req.on("error", (err) => done(() => reject(err)));
    req.end();
  });
}

async function fetchSafeRemoteImage(
  initialUrl: string,
  signal?: AbortSignal,
): Promise<{ contentType: string; buf: Buffer }> {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REMOTE_IMAGE_REDIRECTS; hop++) {
    const { parsed, pinnedIp, family } = await assertSafeRemoteImageUrl(current);
    const res = await pinnedHttpGet(parsed, pinnedIp, family, signal);
    if (res.status >= 300 && res.status < 400) {
      const loc = typeof res.headers.location === "string" ? res.headers.location : undefined;
      if (!loc || hop === MAX_REMOTE_IMAGE_REDIRECTS) {
        throw new GatewayError("Too many or invalid redirects for image URL.", 400, "invalid_image_url");
      }
      current = new URL(loc, parsed).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new GatewayError(`Failed to fetch image URL (${res.status}).`, 400, "invalid_image_url");
    }
    const ct = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : "";
    return { contentType: ct, buf: res.buf };
  }
  throw new GatewayError("Too many redirects for image URL.", 400, "invalid_image_url");
}

/**
 * Fast bilingual token estimator (~3.8 chars/token for ASCII, ~1.5 chars/token for CJK/non-ASCII).
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

export function jsonStringUtf8Bytes(s: string): number {
  if (!s) return 0;
  return Buffer.byteLength(JSON.stringify(s), "utf8");
}

/**
 * Splits a UTF-8 string into chunks that strictly fit AWS Quick's 50KB single-frame ceiling
 * (leaving margin for JSON/CBOR envelope, chunk header, and client-tool reminder),
 * preferring newline boundaries and never splitting UTF-16 surrogate pairs.
 */
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
