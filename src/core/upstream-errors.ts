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
  // Never match `Unexpected server response: 401/403/429` here so WS 401 triggers OAuth refresh & WS 429 triggers rate-limit backoff.
  const isExplicitProxyOrNetErr =
    /proxy connect failed|socks5.*(?:authentication|handshake|connect)|econnrefused|econnreset|etimedout|socket hang up|unexpected server response:\s*(?:5\d\d|407|408)|websocket closed \(1006\)|opening handshake has timed out/i.test(lower);
  const isExplicitOverloadErr =
    finalErr.status === 529 ||
    finalErr.code === "overloaded" ||
    /service\s+is\s+busy|temporarily\s+unavailable|model\s+(?:is\s+)?overloaded|overloaded_error|server\s+is\s+overloaded|too\s+busy|capacity\s+(?:exceeded|unavailable)/i.test(lower);
  // Check explicit quota exhaustion BEFORE generic HTTP 429 so `QuotaExceededException`, `monthly limit exceeded`,
  // and 429 responses carrying explicit quota text trip quota circuit-breaking instead of 3s transient backoff.
  const isQuotaErr =
    !isPayloadOrContextSizeErr &&
    !isConnLimitErr &&
    !isExplicitProxyOrNetErr &&
    !isExplicitOverloadErr &&
    (finalErr.code === "quota_exhausted" ||
      finalErr.status === 402 ||
      /usage.?limit|credits?.?(?:exhausted|insufficient|exceeded)|insufficient.?(?:quota|credits?|balance)|quota.?exceeded|exceeded\s+(?:your\s+)?(?:current\s+)?quota|quota\s+(?:has\s+been\s+)?(?:exhausted|exceeded|insufficient)|monthly\s+limit\s+exceeded|reached (?:your|its) (?:usage|session|monthly) limit/i.test(lower));
  const isRateLimitErr =
    !isExplicitProxyOrNetErr &&
    !isExplicitOverloadErr &&
    !isQuotaErr &&
    (isConnLimitErr ||
      finalErr.status === 429 ||
      /unexpected server response:\s*429|rate.?limit|too many requests|toomanyrequestsexception|throttl/i.test(lower));
  const isAuthErr =
    !isExplicitProxyOrNetErr &&
    !isExplicitOverloadErr &&
    !isRateLimitErr &&
    !isQuotaErr &&
    finalErr.code !== "model_not_available" &&
    !isSessionLifecycleErr &&
    (finalErr.status === 401 ||
      finalErr.status === 403 ||
      /unexpected server response:\s*(?:401|403)|oidc refresh_token failed \((?:401|403)\)|unauthorized|invalid.?grant|invalid.?client|unauthorized.?client|expired.?token|invalid refresh token|(?:token|oauth|cookie|credential).?expired|access.?denied|authentication|oauth token refresh failed|session cookie/i.test(lower));
  const isProxyOrConnErr =
    !isPayloadOrContextSizeErr &&
    (isExplicitProxyOrNetErr ||
      isExplicitOverloadErr ||
      (!isQuotaErr &&
        !isRateLimitErr &&
        !isAuthErr &&
        (finalErr.status === 502 || finalErr.status === 503 || finalErr.status === 504)));

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
export const LEGACY_CONTENT_FILTER_REPHRASE_PROMPT = [
  "Rewrite the user's request into clear, neutral, standard engineering phrasing in the exact same language, domain, and format so it aligns with content moderation and safety guidelines. NEVER answer the request; output ONLY the rewritten request.",
  "1. Stay strictly within the user's actual domain (frontend, backend, DevOps, QA, writing, etc.), tech stack, and requested deliverables—do NOT add unrequested security audits, lectures, or extra tests that the user did not ask for.",
  "2. Replace aggressive or trigger wording (e.g. attack, exploit, bypass, crack, hijack, steal, inject, kill, payload, bombard) with neutral technical equivalents (e.g. benchmark/verify, handle edge case, skip cache/constraint, terminate process, pass/render data). Omit all exploit payloads, reverse-shell strings, or cloud metadata URLs.",
  "3. If the user asked to write vulnerable/broken code or demonstrate an exploit, drop that part and explicitly ask the responder NOT to output vulnerable code or exploit demos—only explain the pitfall in prose (if relevant) and provide the standard, safe/correct implementation (plus any tests the user requested using synthetic placeholders).",
  "4. Preserve `[USER]:` / `[ASSISTANT]:` markers and prior turns verbatim; rewrite only the final `[USER]:` turn.",
].join("\n");

export const DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT = [
  "Rewrite ONLY the user's request into clear, neutral, standard software-engineering phrasing in the exact same language so it aligns with content moderation and safety guidelines. NEVER answer the request, NEVER add preamble/explanations, and output ONLY the rewritten request.",
  "1. Preserve actionable intent verbatim: keep imperative requests actionable (if the user asked to write, edit, fix, refactor, debug, or generate code, commands, or structured output, keep that exact deliverable—NEVER downgrade it into 'explain how to...' or a generic discussion).",
  "2. Preserve all benign technical details verbatim: keep exact file paths, symbol/API names, code blocks, error logs, schemas, output format constraints, and standard engineering terms in benign context (e.g., dependency injection, JSON/HTTP payload, cache bypass, SIGTERM/process termination).",
  "3. Neutralize only hyperbolic, ambiguous, or unsafe phrasing into standard technical language (e.g., 'attack/bombard this API' -> 'load-test/benchmark this API', 'hack around this bug' -> 'work around this bug'). Omit unsafe exploit payloads, reverse-shell strings, or sensitive internal metadata URLs.",
  "4. If part of the request asks for unsafe or harmful demonstrations, remove only that part and state the constructive engineering goal positively (e.g., request the standard, safe implementation and unit tests with synthetic inputs)—do NOT insert negative meta-instructions like 'do NOT output vulnerable code'.",
  "5. Stay strictly within the user's original domain and scope; do not add unrequested audits, lectures, or extra tasks. If `[USER]:` / `[ASSISTANT]:` markers exist, preserve prior turns verbatim and rewrite only the final `[USER]:` turn.",
].join("\n");

export interface SplitTrailingUserTurnResult {
  prefix: string;
  lastUser: string;
  hasMarkers: boolean;
}

/**
 * Isolates only the final `[USER]:` turn from a multi-turn transcript so the helper model
 * rewrites ONLY that turn without echoing/truncating prior turns.
 */
export function splitTrailingUserTurn(rawPrompt: string): SplitTrailingUserTurnResult {
  const trimmed = rawPrompt.trim();
  if (!trimmed) return { prefix: "", lastUser: "", hasMarkers: false };

  const markerRe = /(?:^|\n)\[USER\]:[ \t]*/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(trimmed)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) {
    return { prefix: "", lastUser: trimmed, hasMarkers: false };
  }
  const bodyStart = lastMatch.index + lastMatch[0].length;
  const tail = trimmed.slice(bodyStart);
  // Ensure there is no subsequent `[ASSISTANT]:` turn after this `[USER]:` marker.
  if (/(?:^|\n)\[ASSISTANT\]:/i.test(tail)) {
    return { prefix: "", lastUser: trimmed, hasMarkers: false };
  }
  return {
    prefix: trimmed.slice(0, bodyStart),
    lastUser: tail.trim(),
    hasMarkers: true,
  };
}

const ACCIDENTAL_ANSWER_PREFIX_RE =
  /^(?:sure[,!.: ]|certainly[,!.: ]|of course[,!.: ]|here(?:'s| is| are)\b|to (?:fix|solve|resolve|implement|accomplish) this[,: ]|好的[，,。！!：:]|当然[，,。！!：:]|以下是|下面(?:是|为你提供)|要解决这个)/i;

const ENTITY_PATH_RE = /\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b/g;
const ENTITY_BACKTICK_RE = /`([A-Za-z_][A-Za-z0-9_.$:/-]{2,64})`/g;
const SENSITIVE_ENTITY_RE = /(?:169\.254\.169\.254|\/etc\/passwd|\/etc\/shadow|id_rsa|\.env\b|metadata\.google)/i;

export function extractPreservableEntities(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(ENTITY_PATH_RE)) {
    const token = m[0];
    if (!SENSITIVE_ENTITY_RE.test(token)) found.add(token);
  }
  for (const m of text.matchAll(ENTITY_BACKTICK_RE)) {
    const token = m[1];
    if (!SENSITIVE_ENTITY_RE.test(token) && !/\s/.test(token)) found.add(token);
  }
  return [...found];
}

export interface RephraseValidationResult {
  ok: boolean;
  cleaned?: string;
  reason?: string;
}

/**
 * Validates that the helper model returned a faithful rephrase rather than answering the
 * request, refusing, over-truncating, or stripping all benign technical anchors.
 */
export function validateRephrasedPrompt(
  original: string,
  rawCandidate: string,
  options?: { inputHadMarkers?: boolean },
): RephraseValidationResult {
  const orig = original.trim();
  let cleaned = rawCandidate
    .trim()
    .replace(/^<original_request>\s*/i, "")
    .replace(/\s*<\/original_request>$/i, "")
    .trim();

  if (!options?.inputHadMarkers) {
    cleaned = cleaned.replace(/^\[USER\]:\s*/i, "").trim();
  }
  if (!cleaned) return { ok: false, reason: "empty" };
  if (isLikelySoftRefusal(cleaned)) return { ok: false, reason: "soft_refusal" };
  if (cleaned === orig) return { ok: false, reason: "unchanged" };

  // Anti-answer guardrail: helper model answered instead of rewriting
  if (ACCIDENTAL_ANSWER_PREFIX_RE.test(cleaned)) {
    return { ok: false, reason: "accidental_answer_prefix" };
  }
  const origHasFence = orig.includes("```");
  const cleanedHasFence = cleaned.includes("```");
  if (!origHasFence && cleanedHasFence && cleaned.length > orig.length * 1.4) {
    return { ok: false, reason: "accidental_code_answer" };
  }

  // Length fidelity guardrail: prevent severe truncation or runaway expansion
  if (cleaned.length > Math.max(4_000, orig.length * 2.5)) {
    return { ok: false, reason: "too_long" };
  }
  if (orig.length >= 60 && cleaned.length < Math.max(18, Math.floor(orig.length * 0.25))) {
    return { ok: false, reason: "too_short" };
  }

  // Entity preservation guardrail: if original carried >=2 concrete benign code/file entities
  // and 0% survived in the rewrite, reject as severe intent drift.
  const entities = extractPreservableEntities(orig);
  if (entities.length >= 2) {
    const lowerCleaned = cleaned.toLowerCase();
    const kept = entities.filter((e) => lowerCleaned.includes(e.toLowerCase())).length;
    if (kept === 0) {
      return { ok: false, reason: "entities_dropped" };
    }
  }

  return { ok: true, cleaned };
}

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
  /\b(?:As\s+an|I(?:'m|\s+am)\s+actually)\s+(?:Amazon|AWS)\s+Quick\b/i,
  /\bmake\s+me\s+output\s+tool\s+calls?\b/i,
  /检测到.*(?:提示词注入|越狱|社会工程)/,
  /(?:没有|未)连接本地设备.*(?:无法|不能)/,
  /(?:没有|看不到)(?:任何)?(?:可访问的|已索引的)?本地文件夹/,
  /(?:在|从).*?AWS\s*Quick\s*(?:桌面)?应用.*?(?:发起|添加|开启索引)/i,
  /这次请求(?:是从云端处理的|在云端运行).*?(?:访问不到|连不上|看不到)/,
  /我是\s*(?:Amazon|AWS)\s*Quick/i,
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
