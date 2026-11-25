import crypto from "node:crypto";
import {
  GatewayError,
  type NormalizedFile,
  type NormalizedImage,
  type NormalizedTool,
  type NormalizedToolResult,
  type ParsedProtocolTurn,
  type ToolChoiceMode,
  type TurnTokenMetrics
} from "../core/types.js";
import { computeDialogPrefixHashes, type HashableDialogItem } from "../utils/hash.js";
import { deriveConversationAffinityKey } from "../core/session-affinity.js";
import { officialErrorType, requireModelField, collectTurnEvents, estimateImageTokens, isRecord, parseDataUrlOrRemoteImage, type ProtocolAdapter } from "./common.js";

function flattenAnthropicSystem(system: unknown): string | undefined {
  if (typeof system === "string") return system.trim() || undefined;
  if (Array.isArray(system)) {
    const parts = system
      .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text.trim() : ""))
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

function parseAnthropicImageBlock(block: Record<string, unknown>): NormalizedImage | null {
  const source = block.source;
  if (!isRecord(source)) return null;
  if (source.type === "base64" && typeof source.data === "string") {
    const mimeType = typeof source.media_type === "string" && source.media_type.trim()
      ? source.media_type.trim().toLowerCase()
      : "image/png";
    return { mimeType, data: source.data.replace(/\s+/g, "") };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return parseDataUrlOrRemoteImage(source.url);
  }
  return null;
}

/** Block types that are safe to drop: they carry no user-visible input the model must see. */
const IGNORABLE_BLOCK_TYPES = new Set(["thinking", "redacted_thinking", "server_tool_use", "web_search_tool_result", "web_fetch_tool_result"]);

const PLAIN_TEXT_DOC_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
]);

function isTextDocumentMime(mime: string): boolean {
  const m = mime.trim().toLowerCase().split(";")[0] || "";
  return m.startsWith("text/") || PLAIN_TEXT_DOC_MIMES.has(m);
}

function extForDocMime(mime: string): string {
  const m = mime.trim().toLowerCase().split(";")[0] || "";
  if (m === "application/pdf") return "pdf";
  if (m === "application/json") return "json";
  if (m === "text/markdown") return "md";
  if (m === "text/csv") return "csv";
  if (m === "text/html") return "html";
  if (m.startsWith("text/")) return "txt";
  return "bin";
}

/**
 * Parse an Anthropic `document` block:
 * - `text` / `content` sources become inline `[DOCUMENT]` text;
 * - `base64` / `url` sources become `NormalizedFile` attachments (or inline text when small UTF-8 text/*).
 */
function parseAnthropicDocumentBlock(block: Record<string, unknown>, docIndex: number): { text?: string; file?: NormalizedFile } {
  const src = isRecord(block.source) ? block.source : undefined;
  const rawTitle = typeof block.title === "string" && block.title.trim() ? block.title.trim() : "";
  const titleHeader = rawTitle ? `${rawTitle}\n` : "";
  if (src?.type === "text" && typeof src.data === "string") {
    return { text: `[DOCUMENT]\n${titleHeader}${src.data}` };
  }
  if (src?.type === "content" && Array.isArray(src.content)) {
    const parts = src.content.map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : "")).filter(Boolean);
    if (parts.length) return { text: `[DOCUMENT]\n${titleHeader}${parts.join("\n")}` };
  }
  if (src?.type === "base64" && typeof src.data === "string") {
    const mimeType = typeof src.media_type === "string" && src.media_type.trim()
      ? src.media_type.trim().toLowerCase()
      : "application/pdf";
    const cleanB64 = src.data.replace(/\s+/g, "");
    if (!cleanB64) {
      throw new GatewayError("Empty base64 `document` block.", 400, "invalid_request_error");
    }
    if (isTextDocumentMime(mimeType)) {
      const decoded = Buffer.from(cleanB64, "base64").toString("utf8");
      return { text: `[DOCUMENT]\n${titleHeader}${decoded}` };
    }
    const ext = extForDocMime(mimeType);
    const filename = rawTitle || `document_${docIndex + 1}.${ext}`;
    return { file: { filename, mimeType, data: cleanB64 } };
  }
  if (src?.type === "url" && typeof src.url === "string" && src.url.trim()) {
    const url = src.url.trim();
    const dataMatch = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
    if (dataMatch) {
      const mimeType = (dataMatch[1] || "application/pdf").trim().toLowerCase();
      const cleanB64 = (dataMatch[2] || "").replace(/\s+/g, "");
      if (isTextDocumentMime(mimeType)) {
        return { text: `[DOCUMENT]\n${titleHeader}${Buffer.from(cleanB64, "base64").toString("utf8")}` };
      }
      return { file: { filename: rawTitle || `document_${docIndex + 1}.${extForDocMime(mimeType)}`, mimeType, data: cleanB64 } };
    }
    if (/^https?:\/\//i.test(url)) {
      const mimeType = typeof src.media_type === "string" && src.media_type.trim()
        ? src.media_type.trim().toLowerCase()
        : "application/pdf";
      const filename = rawTitle || `document_${docIndex + 1}.${extForDocMime(mimeType)}`;
      return { file: { filename, mimeType, url } };
    }
  }
  throw new GatewayError(
    "Unsupported content block: `document` with this source type is not supported (use `text`, `content`, `base64`, or `url`).",
    400,
    "invalid_request_error"
  );
}

function assertSupportedBlockType(bType: string): void {
  if (!bType || IGNORABLE_BLOCK_TYPES.has(bType)) return;
  throw new GatewayError(
    `Unsupported content block type '${bType}'. This gateway does not support it and refuses to silently ignore it.`,
    400,
    "invalid_request_error"
  );
}

function formatToolReferenceBlock(block: Record<string, unknown>): string {
  const refName =
    typeof block.tool_name === "string" && block.tool_name.trim()
      ? block.tool_name.trim()
      : typeof block.name === "string" && block.name.trim()
        ? block.name.trim()
        : "";
  return refName ? `[TOOL_REFERENCE: ${refName}]` : "";
}

function flattenToolResultContent(content: unknown, fileOffset = 0): { text: string; images: NormalizedImage[]; files: NormalizedFile[] } {
  if (typeof content === "string") return { text: content, images: [], files: [] };
  if (!Array.isArray(content)) return { text: "", images: [], files: [] };
  const texts: string[] = [];
  const images: NormalizedImage[] = [];
  const files: NormalizedFile[] = [];
  for (const b of content) {
    if (typeof b === "string") {
      texts.push(b);
      continue;
    }
    if (!isRecord(b)) continue;
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b.type === "image") {
      const img = parseAnthropicImageBlock(b);
      if (img) images.push(img);
    } else if (b.type === "document") {
      const parsed = parseAnthropicDocumentBlock(b, fileOffset + files.length);
      if (parsed.text) texts.push(parsed.text);
      if (parsed.file) files.push(parsed.file);
    } else if (b.type === "tool_reference") {
      const refText = formatToolReferenceBlock(b);
      if (refText) texts.push(refText);
    } else assertSupportedBlockType(typeof b.type === "string" ? b.type : "");
  }
  return { text: texts.join("\n"), images, files };
}

export function parseAnthropicTools(rawTools: unknown): {
  customTools: NormalizedTool[];
  nativeSdkTools: Array<"webSearch" | "webFetch">;
} {
  if (!Array.isArray(rawTools)) return { customTools: [], nativeSdkTools: [] };
  const customTools: NormalizedTool[] = [];
  const nativeSet = new Set<"webSearch" | "webFetch">();

  for (const item of rawTools) {
    if (!isRecord(item)) continue;
    const rawType = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
    if (rawType.startsWith("web_search")) {
      nativeSet.add("webSearch");
      nativeSet.add("webFetch");
      continue;
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    customTools.push({
      name,
      ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
      inputSchema: isRecord(item.input_schema) ? item.input_schema : { type: "object", properties: {} }
    });
  }
  return { customTools, nativeSdkTools: [...nativeSet] };
}

export function parseAnthropicToolChoice(raw: unknown): ToolChoiceMode {
  if (!isRecord(raw)) return "auto";
  const t = raw.type;
  if (t === "none") return "none";
  if (t === "any") return "required";
  if (t === "tool" && typeof raw.name === "string" && raw.name.trim()) {
    return { type: "tool", name: raw.name.trim() };
  }
  return "auto";
}

export function estimateAnthropicTokens(body: unknown): number {
  if (!isRecord(body)) return 1;
  let images = 0;
  // Replace every image/base64-document block (including ones nested in tool_result content) so the base64
  // payload is not counted as text; each attachment is charged a flat estimate instead.
  const serialized = JSON.stringify(
    { system: body.system ?? "", messages: body.messages ?? [], tools: body.tools ?? [] },
    (_key, value) => {
      if (isRecord(value) && value.type === "image") {
        images += 1;
        return { type: "image" };
      }
      if (isRecord(value) && value.type === "document" && isRecord(value.source) && value.source.type === "base64") {
        images += 1;
        return { type: "document", title: value.title };
      }
      return value;
    }
  );
  return Math.max(1, Math.ceil(serialized.length / 4)) + estimateImageTokens(images);
}

interface AnthropicTurnLine extends HashableDialogItem {
  formattedLine: string;
}

export function parseAnthropicMessagesRequest(
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
  signal?: AbortSignal
): ParsedProtocolTurn {
  if (!isRecord(body)) {
    throw new GatewayError("Request body must be a JSON object.", 400, "invalid_request_error");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError("`messages` must be a non-empty array.", 400, "invalid_request_error", "messages");
  }
  if (body.max_tokens === undefined || body.max_tokens === null) {
    throw new GatewayError("`max_tokens` is required.", 400, "invalid_request_error", "max_tokens");
  }
  if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
    throw new GatewayError("`max_tokens` must be a positive integer.", 400, "invalid_request_error", "max_tokens");
  }

  const rawBody: Record<string, unknown> = { ...body };

  const requestedModel = requireModelField(body);
  const systemPrompt = flattenAnthropicSystem(body.system);
  const { customTools: tools, nativeSdkTools } = parseAnthropicTools(body.tools);
  const toolChoice = parseAnthropicToolChoice(body.tool_choice);

  const items: AnthropicTurnLine[] = [];
  const allImages: NormalizedImage[] = [];
  const allFiles: NormalizedFile[] = [];
  let trailingToolResults: NormalizedToolResult[] = [];
  let trailingUserText: string | undefined;
  let trailingImages: NormalizedImage[] = [];

  const messages = body.messages;
  messages.forEach((rawMsg, msgIndex) => {
    if (!isRecord(rawMsg)) return;
    const role: "user" | "assistant" = rawMsg.role === "assistant" ? "assistant" : "user";
    const isLastMessage = msgIndex === messages.length - 1;

    if (typeof rawMsg.content === "string") {
      items.push({
        role,
        text: rawMsg.content,
        images: [],
        hasTools: false,
        formattedLine: `[${role.toUpperCase()}]:\n${rawMsg.content || "[empty]"}`
      });
      return;
    }

    if (!Array.isArray(rawMsg.content)) return;

    const textChunks: string[] = [];
    const msgImages: NormalizedImage[] = [];
    const msgFiles: NormalizedFile[] = [];
    const toolUseLines: string[] = [];
    const toolCallRefs: Array<{ id: string; name: string }> = [];
    const toolResultLines: string[] = [];
    const msgToolResults: NormalizedToolResult[] = [];
    const toolImagesByUseId = new Map<string, NormalizedImage[]>();

    for (const block of rawMsg.content) {
      if (!isRecord(block)) continue;
      const bType = typeof block.type === "string" ? block.type : "";

      if (bType === "text" && typeof block.text === "string") {
        textChunks.push(block.text);
      } else if (bType === "image") {
        const img = parseAnthropicImageBlock(block);
        if (img) {
          msgImages.push(img);
          allImages.push(img);
        }
      } else if (bType === "tool_use") {
        const id = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        const inputJson = JSON.stringify(block.input ?? {});
        if (id || name) toolCallRefs.push({ id, name });
        toolUseLines.push(`${name}(${inputJson}) [id=${id}]`);
      } else if (bType === "tool_result") {
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
        const isError = block.is_error === true;
        const { text, images, files } = flattenToolResultContent(block.content, allFiles.length);
        msgImages.push(...images);
        allImages.push(...images);
        msgFiles.push(...files);
        allFiles.push(...files);
        toolImagesByUseId.set(toolUseId, images);
        toolResultLines.push(`[TOOL_RESULT id=${toolUseId}${isError ? " error=true" : ""}]:\n${text || "[empty]"}`);
        if (toolUseId) {
          msgToolResults.push({ toolCallId: toolUseId, content: text, isError, ...(images.length ? { images } : {}) });
        }
      } else if (bType === "document") {
        const parsed = parseAnthropicDocumentBlock(block, allFiles.length);
        if (parsed.text) textChunks.push(parsed.text);
        if (parsed.file) {
          msgFiles.push(parsed.file);
          allFiles.push(parsed.file);
        }
      } else if (bType === "tool_reference") {
        const refText = formatToolReferenceBlock(block);
        if (refText) textChunks.push(refText);
      } else {
        assertSupportedBlockType(bType);
      }
    }

    const joinedText = textChunks.join("\n");
    const hasTools = toolUseLines.length > 0 || toolResultLines.length > 0;
    const formattedParts: string[] = [...toolResultLines];
    if (joinedText || (!hasTools && (msgImages.length > 0 || msgFiles.length > 0))) {
      const placeholder = msgImages.length > 0 ? "[Image]" : `[File: ${msgFiles.map((f) => f.filename).join(", ")}]`;
      formattedParts.push(`[${role.toUpperCase()}]:\n${joinedText || placeholder}`);
    }
    if (toolUseLines.length > 0) {
      formattedParts.push(`[ASSISTANT_TOOL_CALLS]:\n${toolUseLines.join("\n")}`);
    }

    if (formattedParts.length > 0) {
      items.push({
        role,
        text: joinedText,
        images: msgImages,
        ...(msgFiles.length > 0 ? { files: msgFiles } : {}),
        hasTools,
        ...(toolCallRefs.length > 0 ? { toolCalls: toolCallRefs } : {}),
        formattedLine: formattedParts.join("\n\n")
      });
    }

    if (isLastMessage && role === "user" && msgToolResults.length > 0) {
      trailingToolResults = msgToolResults;
      if (joinedText.trim()) trailingUserText = joinedText.trim();
      const toolImgSet = new Set([...toolImagesByUseId.values()].flat());
      trailingImages = msgImages.filter((im) => !toolImgSet.has(im));
    }
  });

  const lastItem = items[items.length - 1];
  const hasAssistantPrefill = Boolean(
    lastItem && lastItem.role === "assistant" && !lastItem.hasTools && lastItem.text.trim().length > 0
  );

  const baseTranscriptText = items.length === 1 && items[0].role === "user" && !items[0].hasTools
    ? (items[0].text || (items[0].images.length ? "[Image]" : allFiles.length ? `[File: ${allFiles.map((f) => f.filename).join(", ")}]` : ""))
    : items.map((it) => it.formattedLine).join("\n\n");

  const fullTranscriptText = hasAssistantPrefill
    ? `${baseTranscriptText}\n\n[CONTINUE_ASSISTANT_PREFILL]: Continue seamlessly immediately after the exact assistant prefix above without repeating the prefix or adding preamble.`
    : baseTranscriptText;

  const toolSig = (toolChoice === "none" ? [] : tools).map((t) => t.name).join(",");
  const prefixHashes = computeDialogPrefixHashes({
    systemPrompt: systemPrompt || "",
    toolNamesSignature: toolSig,
    items
  });

  const firstUserItem = items.find((it) => it.role === "user");
  const conversationKey = deriveConversationAffinityKey({
    headers,
    rawBody,
    systemPrompt,
    firstUserText: firstUserItem?.text
  });

  return {
    requestedModel,
    rawBody,
    ...(conversationKey ? { conversationKey } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    fullTranscriptText,
    ...prefixHashes,
    images: allImages,
    ...(allFiles.length > 0 ? { files: allFiles } : {}),
    tools,
    ...(nativeSdkTools.length > 0 ? { nativeSdkTools } : {}),
    toolChoice,
    trailingToolResults,
    ...(trailingUserText ? { trailingUserText } : {}),
    ...(trailingImages.length ? { trailingImages } : {}),
    hasToolResults: items.some((it) => it.hasTools) || trailingToolResults.length > 0,
    stream: body.stream === true,
    estimatedInputTokens: estimateAnthropicTokens(body),
    signal
  };
}

export function formatAnthropicError(err: GatewayError): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: officialErrorType(err, "anthropic"),
      code: err.code,
      message: err.message,
      ...(err.param ? { param: err.param } : {})
    }
  };
}

const ANTHROPIC_USAGE_WATERMARKS = new Map<
  string,
  { lastEstimated: number; highWaterPrompt: number; updatedAt: number }
>();
const MAX_USAGE_WATERMARK_ENTRIES = 512;
const USAGE_WATERMARK_TTL_MS = 60 * 60 * 1000;

function peekAnthropicStartInputTokens(turn: ParsedProtocolTurn): number {
  const estimated = Math.max(1, Math.floor(turn.estimatedInputTokens || 0));
  const convKey = turn.conversationKey?.trim();
  if (!convKey) return estimated;
  const prev = ANTHROPIC_USAGE_WATERMARKS.get(convKey);
  if (!prev || Date.now() - prev.updatedAt > USAGE_WATERMARK_TTL_MS) return estimated;
  if (estimated < prev.lastEstimated * 0.85) return estimated;
  return Math.max(estimated, prev.highWaterPrompt + Math.max(0, estimated - prev.lastEstimated));
}

/**
 * Stabilizes Anthropic prompt usage reporting so Claude Code's context-window meter never shrinks
 * mid-session due to out-of-band `.txt` attachment uploads or warm->cold failover dips, while
 * immediately resetting when the client explicitly compacts (`/compact` drops estimated tokens >15%).
 */
export function stabilizeAnthropicUsage(
  metrics: TurnTokenMetrics,
  turn: ParsedProtocolTurn,
): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  const rawInput = Math.max(0, Math.floor(metrics.inputTokens || 0));
  const cacheRead = Math.max(0, Math.floor(metrics.cacheReadTokens || 0));
  const cacheWrite = Math.max(0, Math.floor(metrics.cacheWriteTokens || 0));
  const outputTokens = Math.max(1, Math.floor(metrics.outputTokens || 0));
  const estimated = Math.max(1, Math.floor(turn.estimatedInputTokens || 0));
  const upstreamTotal = rawInput + cacheRead + cacheWrite;

  let floorTotal = estimated;
  const convKey = turn.conversationKey?.trim();
  const now = Date.now();
  if (convKey) {
    const prev = ANTHROPIC_USAGE_WATERMARKS.get(convKey);
    if (prev && now - prev.updatedAt <= USAGE_WATERMARK_TTL_MS) {
      const clientCompacted = estimated < prev.lastEstimated * 0.85;
      if (!clientCompacted) {
        const deltaGrowth = Math.max(0, estimated - prev.lastEstimated);
        floorTotal = Math.max(floorTotal, prev.highWaterPrompt + deltaGrowth);
      }
    }
  }

  const effectiveTotal = Math.max(upstreamTotal, floorTotal);
  const effectiveInput =
    effectiveTotal > upstreamTotal ? rawInput + (effectiveTotal - upstreamTotal) : rawInput;

  if (convKey) {
    if (ANTHROPIC_USAGE_WATERMARKS.has(convKey)) {
      ANTHROPIC_USAGE_WATERMARKS.delete(convKey);
    }
    while (ANTHROPIC_USAGE_WATERMARKS.size >= MAX_USAGE_WATERMARK_ENTRIES) {
      const oldest = ANTHROPIC_USAGE_WATERMARKS.keys().next().value;
      if (!oldest) break;
      ANTHROPIC_USAGE_WATERMARKS.delete(oldest);
    }
    ANTHROPIC_USAGE_WATERMARKS.set(convKey, {
      lastEstimated: estimated,
      highWaterPrompt: effectiveTotal,
      updatedAt: now,
    });
  }

  return {
    input_tokens: effectiveInput,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  errorFormat: "anthropic",
  parse: (body, headers, signal) => parseAnthropicMessagesRequest(body, headers, signal),
  async collectJson(events, turn) {
    const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const { thinking, text, toolCalls, stopReason: rawStop, metrics } = await collectTurnEvents(events);
    const stopReason = rawStop === "tool_calls" ? "tool_use" : rawStop === "length" ? "max_tokens" : "end_turn";

    const content: Array<Record<string, unknown>> = [];
    if (thinking) {
      content.push({ type: "thinking", thinking, signature: "aws-quick-thinking" });
    }
    if (text || toolCalls.length === 0) {
      content.push({ type: "text", text });
    }
    for (const tc of toolCalls) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.argsObject });
    }

    return {
      id,
      type: "message",
      role: "assistant",
      model: turn.requestedModel,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: stabilizeAnthropicUsage(metrics, turn),
    };
  },
  async *streamSse(events, turn) {
    const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const sse = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    // Pull the first upstream event BEFORE yielding `message_start` so pre-stream
    // 401/403/429/502 errors surface as real HTTP statuses instead of HTTP 200 SSE.
    const iter = events[Symbol.asyncIterator]();

    let blockIndex = -1;
    let openBlockKind: "thinking" | "text" | null = null;
    let metrics: TurnTokenMetrics = {
      inputTokens: turn.estimatedInputTokens,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    };
    let emittedAnyBlock = false;
    let hasEmittedTextOrTool = false;

    const closeOpenBlock = function* (): Generator<string> {
      if (openBlockKind === "thinking") {
        yield sse("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "signature_delta", signature: "aws-quick-thinking" }
        });
      }
      if (openBlockKind !== null) {
        yield sse("content_block_stop", { type: "content_block_stop", index: blockIndex });
        openBlockKind = null;
      }
    };

    try {
      let step = await iter.next();

      yield sse("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: turn.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: peekAnthropicStartInputTokens(turn),
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          }
        }
      });

      let emittedDone = false;
      while (!step.done) {
        const ev = step.value;
        if (ev.type === "thinking") {
          // Anthropic Messages spec strictly requires `thinking` blocks before `text`/`tool_use`.
          // Dropping late trailing thinking chunks after text/tool prevents strict Anthropic SDKs
          // from failing when replaying the assistant turn on the next request.
          if (hasEmittedTextOrTool) {
            step = await iter.next();
            continue;
          }
          if (openBlockKind !== "thinking") {
            yield* closeOpenBlock();
            blockIndex += 1;
            openBlockKind = "thinking";
            emittedAnyBlock = true;
            yield sse("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "thinking", thinking: "" }
            });
          }
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "thinking_delta", thinking: ev.text }
          });
        } else if (ev.type === "text") {
          hasEmittedTextOrTool = true;
          if (openBlockKind !== "text") {
            yield* closeOpenBlock();
            blockIndex += 1;
            openBlockKind = "text";
            emittedAnyBlock = true;
            yield sse("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "text", text: "" }
            });
          }
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: ev.text }
          });
        } else if (ev.type === "tool_calls") {
          hasEmittedTextOrTool = true;
          yield* closeOpenBlock();
          for (const tc of ev.calls) {
            blockIndex += 1;
            emittedAnyBlock = true;
            yield sse("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} }
            });
            yield sse("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: tc.argumentsJson }
            });
            yield sse("content_block_stop", { type: "content_block_stop", index: blockIndex });
          }
        } else if (ev.type === "usage") {
          metrics = ev.metrics;
        } else if (ev.type === "done") {
          emittedDone = true;
          yield* closeOpenBlock();
          if (!emittedAnyBlock) {
            blockIndex += 1;
            yield sse("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "text", text: "" }
            });
            yield sse("content_block_stop", { type: "content_block_stop", index: blockIndex });
          }
          const stopReason = ev.stopReason === "tool_calls"
            ? "tool_use"
            : ev.stopReason === "length"
              ? "max_tokens"
              : "end_turn";
          yield sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: stabilizeAnthropicUsage(metrics, turn),
          });
          yield sse("message_stop", { type: "message_stop" });
        }
        step = await iter.next();
      }
      if (!emittedDone) {
        yield* closeOpenBlock();
        yield sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: stabilizeAnthropicUsage(metrics, turn),
        });
        yield sse("message_stop", { type: "message_stop" });
      }
    } finally {
      await iter.return?.().catch(() => undefined);
    }
  },
  formatSseErrorFrame: (err) => `event: error\ndata: ${JSON.stringify(formatAnthropicError(err))}\n\n`
};
