import crypto from "node:crypto";
import type { NormalizedFile, NormalizedImage } from "../core/types.js";

const SECRET_REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-aq-[A-Za-z0-9_-]{6,}\b/g, "sk-aq-[REDACTED]"],
  [/\badm_[A-Za-z0-9._-]{10,}\b/g, "adm_[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?\b/g, "[REDACTED_JWT]"],
  [/\boauth:[A-Za-z0-9+/=_-]{16,}/g, "oauth:[REDACTED]"],
  [/\bweb:[^\s"',;]{16,}/g, "web:[REDACTED]"],
  [/\baoa[A-Za-z0-9._-]{20,}\b/g, "aoa[REDACTED]"],
  [/(\b(?:https?|socks5h?):\/\/)([^:@\s/]+):([^\s/]+)@/gi, "$1***:***@"],
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SECRET_REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function safeStringEquals(a: string, b: string): boolean {
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export function normalizeBaseModelId(modelId: string): string {
  let raw = modelId.trim().toLowerCase();
  // Strip leading aggregator/provider prefixes (e.g. `[aws]-`, `quick/`, `amazon-quick/`) BEFORE
  // splitting on trailing `[effort=...]` params so `[aws]-quick-advanced` never collapses to `""`.
  raw = raw.replace(/^\[[^\]]+\][-_/]?/, "");
  raw = raw.replace(/^(?:amazon-quick|aws-quick|quick|aws|anthropic)\//, "");
  let base = raw.split("[")[0]?.trim() ?? "";
  base = base.replace(/\([^)]*\)$/, "").trim();
  if (base === "default") return "auto";
  if (base.endsWith("-fast") && base !== "quick-fast") base = base.slice(0, -"-fast".length);
  if (base.endsWith("-slow")) base = base.slice(0, -"-slow".length);
  const ctxSuffix = /^(.+?)-(\d+(?:\.\d+)?[km])$/i.exec(base);
  if (ctxSuffix) base = ctxSuffix[1]!;
  return base;
}

export function computeConversationHash(parts: readonly string[]): string {
  const h = crypto.createHash("sha256");
  for (const p of parts) {
    h.update(p);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 32);
}

/**
 * Generalized, client-agnostic tag-name matcher for volatile per-turn IDE metadata envelopes injected by
 * coding agents (Claude Code, Codex CLI, Cursor, DSH, Cline, Roo, Kilo, Windsurf, Trae, Antigravity,
 * OpenCode, etc.). Matches compound `<prefix_suffix>` / `<system-reminder>` / `<current_time>` envelopes
 * only — never touches normal HTML/JSX/code tags (`<div>`, `<input>`, `Array<T>`, etc.) or explicit
 * `@file` attachments (`<attached_files>`, `<file_content>`).
 *
 * Used solely for conversation affinity & prefix-hash stability; never mutates outbound upstream prompts.
 */
const VOLATILE_IDE_TAG_NAME_RE =
  /^(?:system[-_]reminder|(?:user|ide|editor|workspace|cursor|client|session|environment|env|runtime|additional|git|tab|open_and_recently_viewed)[-_](?:info|context|details|metadata|status|files?|opened_file|state|reminder|commands?)|current_time|current_date|timestamp|datetime)$/;

const MAX_TAG_ATTR_LEN = 160;

/**
 * Strict linear-time O(N) balanced-innermost XML/HTML tag block stripper.
 * Prevents quadratic ReDoS on repeated unmatched opening tags (e.g. 50k `<timestamp>`) and avoids
 * swallowing user prose when an unclosed tag mention precedes a real IDE metadata envelope.
 */
function stripTagBlocksLinear(
  input: string,
  matchesTagName: (lowerTagName: string) => boolean,
  replacement = "",
): string {
  // Fast exit: balanced `<tag>...</tag>` cannot exist without `</`.
  if (!input || !input.includes("</")) return input;
  const len = input.length;
  let lower: string | null = null;
  const getLower = (): string => {
    if (lower === null) lower = input.toLowerCase();
    return lower;
  };
  const nextCloseCache = new Map<string, number>();
  const nextOpenCache = new Map<string, number>();
  let out = "";
  let lastEmit = 0;
  let pos = 0;

  const isTagBoundaryChar = (code: number): boolean =>
    code === 62 /* > */ || code === 47 /* / */ || code === 32 /* space */ || code === 9 || code === 10 || code === 13;

  const findNextClose = (tag: string, from: number): number => {
    const cached = nextCloseCache.get(tag);
    if (cached === -1) return -1;
    if (cached !== undefined && cached >= from) return cached;
    const needle = `</${tag}>`;
    const idx = getLower().indexOf(needle, from);
    nextCloseCache.set(tag, idx);
    return idx;
  };

  const findNextOpenSameTag = (tag: string, from: number): number => {
    const cached = nextOpenCache.get(tag);
    if (cached === -1) return -1;
    if (cached !== undefined && cached >= from) return cached;
    const needle = `<${tag}`;
    const low = getLower();
    let searchAt = from;
    while (searchAt < len) {
      const idx = low.indexOf(needle, searchAt);
      if (idx === -1) {
        nextOpenCache.set(tag, -1);
        return -1;
      }
      const after = idx + needle.length;
      if (after < len && isTagBoundaryChar(low.charCodeAt(after))) {
        nextOpenCache.set(tag, idx);
        return idx;
      }
      searchAt = idx + 1;
    }
    nextOpenCache.set(tag, -1);
    return -1;
  };

  while (pos < len) {
    const lt = input.indexOf("<", pos);
    if (lt === -1) break;

    // Parse tag name starting at lt + 1 with lazy ASCII lowercase folding (avoids full-string .toLowerCase() when no IDE tags match)
    let nameEnd = lt + 1;
    let hasUpper = false;
    while (nameEnd < len) {
      const raw = input.charCodeAt(nameEnd);
      const ch = raw >= 65 && raw <= 90 ? (hasUpper = true, raw | 32) : raw;
      const isNameChar =
        (ch >= 97 && ch <= 122) || // a-z
        (ch >= 48 && ch <= 57) || // 0-9
        ch === 95 || // _
        ch === 45; // -
      if (!isNameChar) break;
      nameEnd += 1;
    }
    if (nameEnd === lt + 1 || nameEnd >= len || !isTagBoundaryChar(input.charCodeAt(nameEnd))) {
      pos = lt + 1;
      continue;
    }
    const rawTag = input.slice(lt + 1, nameEnd);
    const tag = hasUpper ? rawTag.toLowerCase() : rawTag;
    if (!matchesTagName(tag)) {
      pos = lt + 1;
      continue;
    }

    // Find closing '>' of the opening tag within MAX_TAG_ATTR_LEN
    const maxGt = Math.min(len - 1, nameEnd + MAX_TAG_ATTR_LEN);
    let gt = -1;
    for (let k = nameEnd; k <= maxGt; k += 1) {
      const ch = input.charCodeAt(k);
      if (ch === 62 /* > */) {
        gt = k;
        break;
      }
      if (ch === 60 /* < */) break;
    }
    if (gt === -1) {
      pos = lt + 1;
      continue;
    }

    const closeIdx = findNextClose(tag, gt + 1);
    if (closeIdx === -1) {
      pos = lt + 1;
      continue;
    }

    // If another opening <tag...> appears before </tag>, treat this outer one as unclosed prose
    // so only the innermost balanced IDE envelope is stripped.
    const innerOpen = findNextOpenSameTag(tag, gt + 1);
    if (innerOpen !== -1 && innerOpen < closeIdx) {
      pos = gt + 1;
      continue;
    }

    if (lt > lastEmit) out += input.slice(lastEmit, lt);
    if (replacement) out += replacement;
    pos = closeIdx + tag.length + 3; // skip `</${tag}>`
    lastEmit = pos;
  }
  // Zero-allocation fast return when no volatile IDE tags were stripped.
  if (lastEmit === 0) return input;
  if (lastEmit < len) out += input.slice(lastEmit);
  return out;
}

const VOLATILE_CLOCK_LINE_RE =
  /^(?:current(?:\s+local)?\s+(?:date|time)|today(?:'s)?\s+date|当前(?:本地)?(?:时间|日期)|现在时间)\s*[:：].*$/gim;

function normalizeVolatileTimestamps(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^(?:current(?:\s+local)?\s+(?:date|time)|today(?:'s)?\s+date|timestamp|now|当前(?:本地)?(?:时间|日期)|现在时间)\s*[:：].*$/gim, "<TIME_LINE>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ISO_TS>")
    .replace(/\b\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, "<CN_TS>")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<HMS>")
    .replace(/((?:request|trace|turn|invocation)[_-]?id["':=\s]+)[0-9a-f-]{8,36}\b/gi, "$1<ID>");
}

/**
 * Single source of truth for normalizing a user turn solely for sticky affinity (`conversationKey`)
 * and `warm_incremental` prefix hashing. Strips volatile IDE metadata envelopes and explicit clock
 * header lines while preserving real user content (explicit `@file` attachments, pasted log timestamps/IDs,
 * and HTML/code tags). Falls back to trimmed raw text if nothing else remains.
 */
export function normalizeUserTurnForHash(input: string): string {
  if (!input) return "";
  const normalizedLf = input.includes("\r") ? input.replace(/\r\n/g, "\n") : input;
  const stripped = stripTagBlocksLinear(normalizedLf, (tag) => VOLATILE_IDE_TAG_NAME_RE.test(tag))
    .replace(VOLATILE_CLOCK_LINE_RE, "<TIME_LINE>")
    .trim();
  const substantive = stripped.includes("<TIME_LINE>") ? stripped.replace(/<TIME_LINE>/g, "").trim() : stripped;
  return substantive ? stripped : normalizedLf.trim();
}

/**
 * Extracts the coalesced first logical user turn (all leading consecutive `user` items before the
 * first `assistant` item, matching `computeDialogPrefixHashes`) so clients that send volatile IDE
 * metadata (`<environment_context>`, `<user_info>`, `<system-reminder>`) in a separate leading
 * `user` message keep stable `conversationKey` stickiness across turns.
 */
export function extractFirstUserTurnText(items: ReadonlyArray<{ role: string; text: string }>): string | undefined {
  const parts: string[] = [];
  for (const it of items) {
    if (it.role === "assistant") {
      if (parts.length > 0) break;
      continue;
    }
    if (it.role === "user" && it.text.trim()) {
      parts.push(it.text.trim());
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Stable digest of attached images so two dialogs differing only by an image never share a warm agent. */
function imagesDigest(images: readonly NormalizedImage[]): string {
  if (!images.length) return "";
  const h = crypto.createHash("sha256");
  for (const img of images) h.update("url" in img ? `u:${img.url}` : `d:${img.mimeType}:${img.data}`).update("\0");
  return h.digest("hex").slice(0, 16);
}

function filesDigest(files: readonly NormalizedFile[]): string {
  if (!files.length) return "";
  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(f.url ? `u:${f.filename}:${f.mimeType}:${f.url}` : `d:${f.filename}:${f.mimeType}:${f.data || ""}`).update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export function normalizeSystemPromptForHash(systemPrompt: string): string {
  if (!systemPrompt) return "";
  return normalizeVolatileTimestamps(
    stripTagBlocksLinear(systemPrompt, (tag) => VOLATILE_IDE_TAG_NAME_RE.test(tag), "<TS_BLOCK>"),
  ).trim();
}

export interface HashableToolCallRef {
  id: string;
  name: string;
}

export function extendHashWithAssistantReply(inputPrefixHash: string, assistantText: string): string {
  return crypto
    .createHash("sha256")
    .update(inputPrefixHash)
    .update("\0ASSISTANT_TEXT:")
    .update(assistantText.trim())
    .digest("hex")
    .slice(0, 32);
}

export function extendHashWithAssistantTurn(
  inputPrefixHash: string,
  assistantText: string,
  toolCalls?: readonly HashableToolCallRef[],
): string {
  if (!toolCalls || toolCalls.length === 0) {
    return extendHashWithAssistantReply(inputPrefixHash, assistantText);
  }
  const callsSig = toolCalls
    .map((tc) => `${tc.id.trim()}:${tc.name.trim()}`)
    .join("|");
  return crypto
    .createHash("sha256")
    .update(inputPrefixHash)
    .update("\0ASSISTANT_TEXT:")
    .update(assistantText.trim())
    .update("\0ASSISTANT_TOOLS:")
    .update(callsSig)
    .digest("hex")
    .slice(0, 32);
}

export interface HashableDialogItem {
  role: "user" | "assistant" | "tool";
  text: string;
  images: NormalizedImage[];
  files?: NormalizedFile[];
  hasTools: boolean;
  toolCalls?: HashableToolCallRef[];
  formattedLine?: string;
}

export interface ComputedDialogPrefix {
  priorPrefixHash?: string;
  currentInputPrefixHash?: string;
  /** Number of completed assistant turns preceding the current user/tool input group. */
  priorAssistantTurns?: number;
  incrementalUserText?: string;
  incrementalImages?: NormalizedImage[];
  incrementalFiles?: NormalizedFile[];
}

type LogicalDialogGroup =
  | { kind: "assistant"; text: string; toolCalls: HashableToolCallRef[] }
  | { kind: "input"; items: HashableDialogItem[] };

/**
 * Unified incremental prefix hash calculator shared across OpenAI Chat, OpenAI Responses,
 * and Anthropic Messages protocols.
 *
 * Supports BOTH pure multi-turn conversations and multi-turn tool-calling sessions
 * (Claude Code, Codex CLI, Witan, etc.), and intentionally ignores volatile `systemPrompt`
 * mutations because every warm turn still delivers the latest `custom_prompt` to AWS Quick.
 */
export function computeDialogPrefixHashes(params: {
  systemPrompt: string;
  toolNamesSignature: string;
  items: readonly HashableDialogItem[];
}): ComputedDialogPrefix {
  const { toolNamesSignature, items } = params;
  if (items.length === 0) {
    return {};
  }

  // Coalesce consecutive assistant items (e.g. OpenAI Responses assistant text + function_call items)
  // and consecutive non-assistant input items (e.g. multiple tool results + optional trailing user msg).
  const groups: LogicalDialogGroup[] = [];
  for (const it of items) {
    if (it.role === "assistant") {
      const prev = groups[groups.length - 1];
      if (prev && prev.kind === "assistant") {
        if (it.text.trim()) {
          prev.text = prev.text ? `${prev.text}\n${it.text.trim()}` : it.text.trim();
        }
        if (it.toolCalls?.length) prev.toolCalls.push(...it.toolCalls);
      } else {
        groups.push({
          kind: "assistant",
          text: it.text.trim(),
          toolCalls: it.toolCalls ? [...it.toolCalls] : [],
        });
      }
    } else {
      const prev = groups[groups.length - 1];
      if (prev && prev.kind === "input") {
        prev.items.push(it);
      } else {
        groups.push({ kind: "input", items: [it] });
      }
    }
  }

  const lastGroup = groups[groups.length - 1];
  if (!lastGroup || lastGroup.kind !== "input") {
    return {};
  }

  let runningHash = computeConversationHash([`TOOLS:${toolNamesSignature}`]);
  let priorPrefixHash: string | undefined;
  let incrementalUserText: string | undefined;
  let incrementalImages: NormalizedImage[] | undefined;
  let incrementalFiles: NormalizedFile[] | undefined;

  for (let i = 0; i < groups.length; i += 1) {
    const grp = groups[i]!;
    if (grp.kind === "assistant") {
      runningHash = extendHashWithAssistantTurn(runningHash, grp.text, grp.toolCalls);
      continue;
    }

    const isPureSingleUser =
      grp.items.length === 1 && grp.items[0]!.role === "user" && !grp.items[0]!.hasTools;
    const grpText = isPureSingleUser
      ? grp.items[0]!.text
      : grp.items
        .map((it) => it.formattedLine || it.text)
        .filter((s) => s.length > 0)
        .join("\n\n");
    const grpImages = grp.items.flatMap((it) => it.images);
    const grpFiles = grp.items.flatMap((it) => it.files ?? []);

    if (i === groups.length - 1 && i > 0) {
      priorPrefixHash = runningHash;
      incrementalUserText = grpText;
      incrementalImages = grpImages;
      incrementalFiles = grpFiles;
    }

    const hashText = normalizeUserTurnForHash(grpText);
    const hashParts = isPureSingleUser
      ? [runningHash, `USER:${hashText}`, `IMG:${imagesDigest(grpImages)}`]
      : [runningHash, `INPUT:${hashText}`, `IMG:${imagesDigest(grpImages)}`];
    if (grpFiles.length > 0) {
      hashParts.push(`FILE:${filesDigest(grpFiles)}`);
    }
    runningHash = computeConversationHash(hashParts);
  }

  const priorAssistantTurns = groups.reduce((acc, g) => (g.kind === "assistant" ? acc + 1 : acc), 0);

  return {
    ...(priorPrefixHash ? { priorPrefixHash } : {}),
    currentInputPrefixHash: runningHash,
    priorAssistantTurns,
    ...(incrementalUserText !== undefined ? { incrementalUserText } : {}),
    ...(incrementalImages ? { incrementalImages } : {}),
    ...(incrementalFiles ? { incrementalFiles } : {}),
  };
}
