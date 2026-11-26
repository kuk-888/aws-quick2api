import { redactSecrets } from "../utils/hash.js";
import { GatewayError } from "./types.js";

export function mapSdkError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  const msg = redactSecrets(err instanceof Error ? err.message : String(err));
  return new GatewayError(msg || "Unexpected AWS Quick gateway error.", 502, "upstream_error");
}

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
  // Check proxy/transport errors BEFORE auth so `Proxy CONNECT failed (407 Proxy Authentication Required)`
  // and `SOCKS5 username/password authentication failed` never permanently disable a healthy AWS account.
  const isExplicitProxyOrNetErr =
    /proxy connect failed|socks5.*(?:authentication|handshake|connect)|econnrefused|econnreset|etimedout|socket hang up|unexpected server response|websocket closed \(1006\)/i.test(lower);
  // Check explicit quota exhaustion BEFORE generic HTTP 429 so `QuotaExceededException`, `monthly limit exceeded`,
  // and 429 responses carrying explicit quota text trip quota circuit-breaking instead of 3s transient backoff.
  const isQuotaErr =
    !isPayloadOrContextSizeErr &&
    !isConnLimitErr &&
    !isExplicitProxyOrNetErr &&
    (finalErr.code === "quota_exhausted" ||
      finalErr.status === 402 ||
      /usage.?limit|credits?.?(?:exhausted|insufficient|exceeded)|insufficient.?(?:quota|credits?|balance)|quota.?exceeded|exceeded\s+(?:your\s+)?(?:current\s+)?quota|quota\s+(?:has\s+been\s+)?(?:exhausted|exceeded|insufficient)|monthly\s+limit\s+exceeded|reached (?:your|its) (?:usage|session|monthly) limit/i.test(lower));
  const isRateLimitErr =
    !isExplicitProxyOrNetErr &&
    !isQuotaErr &&
    (isConnLimitErr ||
      finalErr.status === 429 ||
      /rate.?limit|too many requests|toomanyrequestsexception|throttl/i.test(lower));
  const isAuthErr =
    !isExplicitProxyOrNetErr &&
    !isRateLimitErr &&
    !isQuotaErr &&
    finalErr.code !== "model_not_available" &&
    !isSessionLifecycleErr &&
    (finalErr.status === 401 ||
      finalErr.status === 403 ||
      /unauthorized|invalid.?grant|invalid.?client|unauthorized.?client|expired.?token|invalid refresh token|(?:token|oauth|cookie|credential).?expired|access.?denied|authentication|oauth token refresh failed|session cookie/i.test(lower));
  const isProxyOrConnErr =
    isExplicitProxyOrNetErr ||
    (!isQuotaErr &&
      !isRateLimitErr &&
      !isAuthErr &&
      (finalErr.status === 502 || finalErr.status === 503 || finalErr.status === 504));

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

const PSEUDO_200_USAGE_LIMIT_PHRASES = [
  "you've reached your usage limit. check your profile for details.",
  "you have reached your usage limit. check your profile for details.",
] as const;

function normalizeUsageLimitProbe(text: string): string {
  return text.trimStart().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");
}

export function isPseudo200UsageLimitText(text: string): boolean {
  const norm = normalizeUsageLimitProbe(text).trimEnd();
  if (!norm || norm.length > 140) return false;
  return /^you(?:'ve| have) reached your usage limit\.\s*check your profile for details\.?$/i.test(norm);
}

export function isPseudo200UsageLimitPrefix(text: string): boolean {
  const norm = normalizeUsageLimitProbe(text);
  if (!norm) return true;
  if (norm.length > 80) return false;
  return PSEUDO_200_USAGE_LIMIT_PHRASES.some((phrase) => phrase.startsWith(norm));
}

export const DEFAULT_CONTENT_FILTER_REPHRASE_MODEL = "quick-fast";
export const DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT = [
  "Rewrite the user's request into clear, neutral, standard engineering phrasing in the exact same language, domain, and format so it aligns with content moderation and safety guidelines. NEVER answer the request; output ONLY the rewritten request.",
  "1. Stay strictly within the user's actual domain (frontend, backend, DevOps, QA, writing, etc.), tech stack, and requested deliverables—do NOT add unrequested security audits, lectures, or extra tests that the user did not ask for.",
  "2. Replace aggressive or trigger wording (e.g. attack, exploit, bypass, crack, hijack, steal, inject, kill, payload, bombard) with neutral technical equivalents (e.g. benchmark/verify, handle edge case, skip cache/constraint, terminate process, pass/render data). Omit all exploit payloads, reverse-shell strings, or cloud metadata URLs.",
  "3. If the user asked to write vulnerable/broken code or demonstrate an exploit, drop that part and explicitly ask the responder NOT to output vulnerable code or exploit demos—only explain the pitfall in prose (if relevant) and provide the standard, safe/correct implementation (plus any tests the user requested using synthetic placeholders).",
  "4. Preserve `[USER]:` / `[ASSISTANT]:` markers and prior turns verbatim; rewrite only the final `[USER]:` turn.",
].join("\n");

/**
 * High-precision patterns matching false-positive prompt-injection accusations and AWS Quick
 * built-in device/role-lock refusals (never matches generic apologies like plain "I'm sorry"
 * or legitimate educational/defensive discussions of "prompt injection").
 */
export const SOFT_REFUSAL_PATTERNS: readonly RegExp[] = [
  /\b(?:this|that|your)\s+(?:message|input|prompt|request|text)\s+(?:is|contains|looks?\s+like|appears?\s+to\s+be|has\s+been\s+flagged\s+as)\s+(?:an?\s+)?(?:indirect\s+)?prompt\s+injection(?:\s+(?:attack|attempt))?\b/i,
  /\bI(?:'ve|'m|\s+have|\s+must|\s+need\s+to)?\s+(?:flag(?:ged|ging)?|detect(?:ed)?|stop(?:ping)?\s+and\s+flag)\s+(?:this|that|your\s+(?:message|input|prompt|request)|an?\s+(?:indirect\s+)?prompt\s+injection)\b/i,
  /\b(?:this|that|your)\s+(?:message|input|prompt|request)\s+(?:is|looks?\s+like|appears?\s+to\s+be)\s+(?:a\s+)?social\s+engineering(?:\s+attack)?\b/i,
  /\bI\s+need\s+to\s+stop\s+and\s+flag\b/i,
  /\bWhat\s+I\s+will\s+not\s+do\b/i,
  /\binjected\s+system\s+prompts?\b/i,
  /\breplayed\s+against\s+a\s+real\s+system\b/i,
  /\b(?:no\s+device\s+(?:is\s+)?connected|connect\s+(?:a|your)\s+local\s+device\s+in\s+(?:amazon|aws)\s+quick)\b/i,
  /\bAs\s+an\s+(?:Amazon|AWS)\s+Quick\s+assistant\b/i,
  /\bmake\s+me\s+output\s+tool\s+calls?\b/i,
  /检测到.*(?:提示词注入|越狱|社会工程)/,
  /(?:没有|未)连接本地设备.*(?:无法|不能)/,
];

export function isLikelySoftRefusal(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("<tool_call>")) return false;
  // For longer responses, only inspect the opening 320 chars so legitimate discussions of security
  // concepts ("prompt injection") deep inside a real answer are never falsely tripped.
  const window = trimmed.length > 500 ? trimmed.slice(0, 320) : trimmed;
  return SOFT_REFUSAL_PATTERNS.some((re) => re.test(window));
}
