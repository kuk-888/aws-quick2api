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
  return systemPrompt
    .replace(/\r\n/g, "\n")
    // Strip common volatile timestamp / date / clock lines injected by Agent clients on every turn
    .replace(/<(?:current_time|current_date|timestamp|datetime)[^>]*>[\s\S]*?<\/(?:current_time|current_date|timestamp|datetime)>/gi, "<TS_BLOCK>")
    .replace(/^(?:current(?:\s+local)?\s+(?:date|time)|today(?:'s)?\s+date|timestamp|now|当前(?:本地)?(?:时间|日期)|现在时间)\s*[:：].*$/gim, "<TIME_LINE>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ISO_TS>")
    .replace(/\b\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, "<CN_TS>")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<HMS>")
    .replace(/((?:request|trace|turn|invocation)[_-]?id["':=\s]+)[0-9a-f-]{8,36}\b/gi, "$1<ID>")
    .trim();
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

    const hashText = grpText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim() || grpText.trim();
    const hashParts = isPureSingleUser
      ? [runningHash, `USER:${hashText}`, `IMG:${imagesDigest(grpImages)}`]
      : [runningHash, `INPUT:${hashText}`, `IMG:${imagesDigest(grpImages)}`];
    if (grpFiles.length > 0) {
      hashParts.push(`FILE:${filesDigest(grpFiles)}`);
    }
    runningHash = computeConversationHash(hashParts);
  }

  return {
    ...(priorPrefixHash ? { priorPrefixHash } : {}),
    currentInputPrefixHash: runningHash,
    ...(incrementalUserText !== undefined ? { incrementalUserText } : {}),
    ...(incrementalImages ? { incrementalImages } : {}),
    ...(incrementalFiles ? { incrementalFiles } : {}),
  };
}
