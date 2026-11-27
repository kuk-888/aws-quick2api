import crypto from "node:crypto";
import { fetchViaOptionalProxy } from "../utils/proxy-agent.js";
import { normalizeOAuthUploadContentType, type QuickFileAttachment } from "./oauth-client.js";
import type { CloudSessionMeta, QuickQuotaUsage } from "./types.js";

export interface WebCookieCredential {
  accountId: string;
  mbtc: string;
  cookie: string;
  email?: string;
}

const ESSENTIAL_COOKIES = ["aws-directoryUserInfo", "aws-ds-access-token", "JSESSIONID"] as const;
const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function extractEssentialCookies(rawCookieHeader: string): string {
  const map = new Map<string, string>();
  for (const part of rawCookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) map.set(k, v);
  }
  const kept: string[] = [];
  for (const name of ESSENTIAL_COOKIES) {
    const val = map.get(name);
    if (val) kept.push(`${name}=${val}`);
  }
  return kept.length > 0 ? kept.join("; ") : rawCookieHeader.trim();
}

function extractAccountIdFromCookie(cookie: string): string | undefined {
  const m = /(?:^|;\s*)aws-directoryUserInfo=([^;]+)/.exec(cookie);
  if (!m?.[1]) return undefined;
  try {
    const decoded = JSON.parse(safeDecodeURIComponent(m[1])) as { alias?: string };
    if (decoded.alias && /^\d{8,16}$/.test(decoded.alias)) return decoded.alias;
  } catch {
    // ignore
  }
  return undefined;
}

function extractEmailFromCookie(cookie: string): string | undefined {
  const m = /(?:^|;\s*)qs-saved-accounts=([^;]+)/.exec(cookie);
  if (!m?.[1]) return undefined;
  try {
    const decoded = JSON.parse(safeDecodeURIComponent(m[1])) as { a?: Array<{ u?: string }> };
    const u = decoded.a?.[0]?.u;
    if (typeof u === "string" && u.includes("@")) return u;
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Parse either a normalized `web:<accountId>|<mbtc>|<cookie>` credential
 * OR a raw browser `curl ...` command copied from `quick.aws.com` DevTools (`qbsproxy` / `wsproxy`).
 */
export function parseWebCurlOrCredential(raw: string): WebCookieCredential | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Format 1: compact `web:<accountId>|<mbtc>|<cookie>`
  if (trimmed.startsWith("web:")) {
    const rest = trimmed.slice(4);
    const p1 = rest.indexOf("|");
    const p2 = p1 > 0 ? rest.indexOf("|", p1 + 1) : -1;
    if (p1 <= 0 || p2 <= p1) return null;
    const accountId = rest.slice(0, p1).trim();
    const mbtc = safeDecodeURIComponent(rest.slice(p1 + 1, p2).trim());
    const cookie = extractEssentialCookies(rest.slice(p2 + 1).trim());
    if (!accountId || !mbtc || !cookie.includes("aws-ds-access-token=")) return null;
    return { accountId, mbtc, cookie };
  }

  // Format 2: pasted browser `curl` from quick.aws.com
  if (!/quick\.aws\.com/i.test(trimmed) || !/aws-ds-access-token=/i.test(trimmed)) {
    return null;
  }

  // Collapse backslash-newline continuations
  const flat = trimmed.replace(/\\\r?\n\s*/g, " ");

  const cookieMatch =
    /(?:^|\s)(?:-b|--cookie)\s+['"]([^'"]+)['"]/.exec(flat) ||
    /-H\s+['"]cookie:\s*([^'"]+)['"]/i.exec(flat);
  const fullCookie = cookieMatch?.[1]?.trim() || "";
  if (!fullCookie || !fullCookie.includes("aws-ds-access-token=")) return null;

  const accountMatch =
    /\/sn\/account\/(\d{8,16})\//.exec(flat) ||
    /awsAccountId=(\d{8,16})/.exec(flat);
  const accountId = accountMatch?.[1] || extractAccountIdFromCookie(fullCookie);
  if (!accountId) return null;

  const mbtcMatch =
    /[?&]mbtc=([^&'"\s]+)/.exec(flat) ||
    /-H\s+['"]x-amzn-csrf-token:\s*([^'"]+)['"]/i.exec(flat);
  const mbtc = mbtcMatch?.[1] ? safeDecodeURIComponent(mbtcMatch[1].trim()) : "";
  if (!mbtc) return null;

  const email = extractEmailFromCookie(fullCookie);
  return {
    accountId,
    mbtc,
    cookie: extractEssentialCookies(fullCookie),
    ...(email ? { email } : {}),
  };
}

export function serializeWebCredential(cred: WebCookieCredential): string {
  return `web:${cred.accountId}|${cred.mbtc}|${cred.cookie}`;
}

export function buildWebWsConnection(cred: WebCookieCredential, workingSessionId: string): {
  url: string;
  protocols: string[];
  headers: Record<string, string>;
} {
  const mbtcEnc = encodeURIComponent(cred.mbtc);
  const url =
    `wss://quick.aws.com/sn/account/${encodeURIComponent(cred.accountId)}` +
    `/wsproxy/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream` +
    `?wsproxy-protocol=rpc-v2-cbor` +
    `&awsAccountId=${encodeURIComponent(cred.accountId)}` +
    `&surfaceType=WEB_EXPERIENCE` +
    `&agentServiceType=UNIFIED_QUICK` +
    `&outpostId=web0` +
    `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
    `&mbtc=${mbtcEnc}`;
  const protocols = [
    "subprotocol-json",
    encodeURIComponent(JSON.stringify({ csrfToken: mbtcEnc })),
  ];
  const headers: Record<string, string> = {
    Origin: "https://quick.aws.com",
    Cookie: cred.cookie,
    "User-Agent": WEB_UA,
  };
  return { url, protocols, headers };
}

async function callWebQbsProxy(
  cred: WebCookieCredential,
  invocationPath: string,
  method: "GET" | "POST",
  bodyObj: Record<string, unknown> = {},
  proxyUrl?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const mbtcEnc = encodeURIComponent(cred.mbtc);
  const workingSessionId = crypto.randomUUID();
  const url =
    `https://quick.aws.com/sn/account/${encodeURIComponent(cred.accountId)}` +
    `/qbsproxy/quicksight/accounts/${encodeURIComponent(cred.accountId)}` +
    `/invocations/${invocationPath.replace(/^\/+/, "")}` +
    `?_method=${method}&surfaceType=WEB_EXPERIENCE&appVersion=qbiz-web-bridge` +
    `&mbtc=${mbtcEnc}&outpostId=web0&workingSessionId=${workingSessionId}`;

  const bodyStr = JSON.stringify(bodyObj);
  let resp!: Awaited<ReturnType<typeof fetchViaOptionalProxy>>;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    resp = await fetchViaOptionalProxy(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://quick.aws.com",
          Referer: "https://quick.aws.com/",
          Cookie: cred.cookie,
          "User-Agent": WEB_UA,
          "x-amzn-csrf-token": mbtcEnc,
        },
        body: bodyStr,
        ...(signal ? { signal } : {}),
      },
      proxyUrl,
    );
    if (
      attempt === 0 &&
      !signal?.aborted &&
      (resp.status === 429 || (resp.status >= 500 && resp.status <= 599))
    ) {
      await resp.text().catch(() => "");
      const backoffMs = 350 + Math.floor(Math.random() * 200);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, backoffMs);
      });
      continue;
    }
    break;
  }

  if (!resp.ok) {
    let summary = "";
    try {
      summary = (await resp.text()).replace(/\s+/g, " ").trim().slice(0, 220);
    } catch {
      summary = "";
    }
    throw new Error(`AWS Quick Web qbsproxy ${invocationPath} failed (${resp.status})${summary ? `: ${summary}` : ""}`);
  }

  const rawText = await resp.text();
  let outer: unknown;
  try {
    outer = JSON.parse(rawText);
    if (typeof outer === "string") {
      outer = JSON.parse(outer);
    }
  } catch {
    throw new Error(`AWS Quick Web qbsproxy ${invocationPath} returned non-JSON response (session may be expired)`);
  }
  // qbsproxy returns either a JSON string containing `{ body: "..." }` or an object `{ body: "..." }`
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) {
    throw new Error(`AWS Quick Web qbsproxy ${invocationPath} returned non-JSON response (session may be expired)`);
  }
  const parsed = outer as { status?: number; statusCode?: number; body?: unknown; errorMessage?: unknown; error?: unknown };
  const formatField = (val: unknown): string => {
    if (typeof val === "string") return val.replace(/\s+/g, " ").trim();
    if (val && typeof val === "object") {
      if (Array.isArray(val) ? val.length === 0 : Object.keys(val).length === 0) return "";
      try {
        return JSON.stringify(val).replace(/\s+/g, " ").trim();
      } catch {
        return "";
      }
    }
    return "";
  };
  const innerStatus = typeof parsed.status === "number" ? parsed.status : parsed.statusCode;
  const innerErr = formatField(parsed.errorMessage) || formatField(parsed.error);
  if (innerErr) {
    throw new Error(`AWS Quick Web qbsproxy ${invocationPath} error: ${innerErr.slice(0, 220)}`);
  }
  if (typeof innerStatus === "number" && innerStatus >= 400) {
    const bodySnippet = formatField(parsed.body).slice(0, 220);
    throw new Error(
      `AWS Quick Web qbsproxy ${invocationPath} failed (inner ${innerStatus})${bodySnippet ? `: ${bodySnippet}` : ""}`,
    );
  }
  if (typeof parsed?.body === "string") {
    if (!parsed.body.trim()) return {};
    try {
      return JSON.parse(parsed.body);
    } catch {
      throw new Error(`AWS Quick Web qbsproxy ${invocationPath} returned malformed body payload`);
    }
  }
  if (parsed?.body && typeof parsed.body === "object") {
    return parsed.body;
  }
  return parsed;
}

export async function fetchWebProfileUsage(
  cred: WebCookieCredential,
  proxyUrl?: string,
): Promise<QuickQuotaUsage> {
  const data = await callWebQbsProxy(cred, "profile/usage", "GET", {}, proxyUrl);
  return (data && typeof data === "object" ? data : {}) as QuickQuotaUsage;
}

export async function listWebCloudSessions(
  cred: WebCookieCredential,
  limit = 50,
  proxyUrl?: string,
): Promise<CloudSessionMeta[]> {
  const data = (await callWebQbsProxy(
    cred,
    "api/ws-rpc",
    "POST",
    {
      type: "session_list",
      payload: { limit },
    },
    proxyUrl,
  )) as { frames?: Array<{ type?: string; payload?: { sessions?: CloudSessionMeta[] } }> };
  const frame = (data?.frames || []).find((f) => f.type === "session_list");
  return (frame?.payload?.sessions || []).map((s) => ({
    id: String(s.id),
    title: String(s.title || "(Untitled)"),
    created_at: Number(s.created_at || 0),
    updated_at: Number(s.updated_at || 0),
    message_count: Number(s.message_count || 0),
  }));
}

/**
 * Native Web Cookie out-of-band attachment upload (matches official quick.aws.com web capture):
 * 1. POST `/qbsproxy/qs-file-proxy/accounts/{acct}/attachments/presigned-url` with raw binary bytes → `attachmentId`
 * 2. POST `/qbsproxy/quicksight/accounts/{acct}/invocations/files/upload/{threadId}` with `{ attachmentId }` → `path`
 */
export async function uploadWebBinaryAttachment(
  cred: WebCookieCredential,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  threadId: string,
  proxyUrl?: string,
  signal?: AbortSignal,
): Promise<QuickFileAttachment> {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.byteLength === 0) {
    throw new Error("AWS Quick Web attachment upload rejected: empty file (0 bytes).");
  }
  const contentSha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const normalizedMime = normalizeOAuthUploadContentType(mimeType, filename);
  const mbtcEnc = encodeURIComponent(cred.mbtc);
  const acctEnc = encodeURIComponent(cred.accountId);

  // Align 1:1 with official quick.aws.com web capture (`req-1431-presigned-url.json`):
  // Operation=ConversationServiceFileAttachmentProxy, awsAccountId, name, contentType, contentLength, mbtc
  // plus `x-amzn-target: api`, `x-amzn-web-client-version: 0.1.4`, and chat `Referer`.
  const uploadUrl =
    `https://quick.aws.com/sn/account/${acctEnc}` +
    `/qbsproxy/qs-file-proxy/accounts/${acctEnc}` +
    `/attachments/presigned-url?Operation=ConversationServiceFileAttachmentProxy` +
    `&awsAccountId=${acctEnc}` +
    `&name=${encodeURIComponent(filename)}` +
    `&contentType=${encodeURIComponent(normalizedMime)}` +
    `&contentLength=${buf.byteLength}` +
    `&mbtc=${mbtcEnc}`;

  let upResp!: Awaited<ReturnType<typeof fetchViaOptionalProxy>>;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    upResp = await fetchViaOptionalProxy(
      uploadUrl,
      {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": normalizedMime,
          Origin: "https://quick.aws.com",
          Referer: `https://quick.aws.com/sn/account/${acctEnc}/start/chat?conversationId=${encodeURIComponent(threadId)}`,
          Cookie: cred.cookie,
          "User-Agent": WEB_UA,
          "x-amzn-csrf-token": mbtcEnc,
          "x-amzn-target": "api",
          "x-amzn-web-client-version": "0.1.4",
        },
        body: buf,
        ...(signal ? { signal } : {}),
      },
      proxyUrl,
    );
    if (
      attempt === 0 &&
      !signal?.aborted &&
      (upResp.status === 429 || (upResp.status >= 500 && upResp.status <= 599))
    ) {
      await upResp.text().catch(() => "");
      const backoffMs = 350 + Math.floor(Math.random() * 200);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, backoffMs);
      });
      continue;
    }
    break;
  }
  if (!upResp.ok) {
    const errText = await upResp.text().catch(() => "");
    throw new Error(`AWS Quick Web attachment upload failed (${upResp.status}): ${errText.slice(0, 200)}`);
  }
  const upData = (await upResp.json()) as { attachmentId?: string; id?: string };
  const attachmentId = upData?.attachmentId || upData?.id;
  if (!attachmentId) {
    throw new Error("AWS Quick Web attachment upload response missing attachmentId.");
  }

  const bindData = (await callWebQbsProxy(
    cred,
    `files/upload/${encodeURIComponent(threadId)}`,
    "POST",
    { attachmentId },
    proxyUrl,
    signal,
  )) as { path?: string; workspace_path?: string; name?: string; files?: Array<{ path?: string }> };

  const serverPath = bindData?.path || bindData?.files?.[0]?.path;
  if (!serverPath) {
    throw new Error("AWS Quick Web files/upload response missing workspace file path.");
  }

  return {
    type: normalizedMime.startsWith("image/") ? "image" : "file",
    name: bindData?.name || filename,
    size: buf.byteLength,
    mimeType: normalizedMime,
    path: serverPath,
    attachmentId,
    contentSha256,
  };
}
