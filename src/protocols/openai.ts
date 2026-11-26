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
import { computeDialogPrefixHashes, extractFirstUserTurnText, type HashableDialogItem } from "../utils/hash.js";
import { deriveConversationAffinityKey } from "../core/session-affinity.js";
import { officialErrorType, requireModelField, collectTurnEvents, estimateImageTokens, isRecord, parseDataUrlOrRemoteImage, type ProtocolAdapter } from "./common.js";

function inferFileMimeFromName(filename: string): string {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".txt") || lower.endsWith(".log") || lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return "text/plain";
  }
  return "application/octet-stream";
}

function parseOpenAiFileObject(src: Record<string, unknown>, fileIndex: number): NormalizedFile {
  const rawName = typeof src.filename === "string" && src.filename.trim() ? src.filename.trim() : "";
  const rawUrl = typeof src.file_url === "string" && src.file_url.trim() ? src.file_url.trim() : "";
  const rawData = typeof src.file_data === "string" && src.file_data.trim() ? src.file_data.trim() : "";

  if (rawData) {
    const dataMatch = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(rawData);
    if (dataMatch) {
      const mimeType = (dataMatch[1] || "").trim().toLowerCase() || inferFileMimeFromName(rawName || "file.pdf");
      const filename = rawName || `file_${fileIndex + 1}.${mimeType === "application/pdf" ? "pdf" : "bin"}`;
      return { filename, mimeType, data: (dataMatch[2] || "").replace(/\s+/g, "") };
    }
    const filename = rawName || `file_${fileIndex + 1}.pdf`;
    return { filename, mimeType: inferFileMimeFromName(filename), data: rawData.replace(/\s+/g, "") };
  }
  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    const filename = rawName || `file_${fileIndex + 1}.pdf`;
    return { filename, mimeType: inferFileMimeFromName(filename), url: rawUrl };
  }
  if (typeof src.file_id === "string" && src.file_id.trim()) {
    throw new GatewayError(
      "Unsupported `file_id` reference: this stateless gateway does not host OpenAI `/v1/files`. Send inline `file_data` (base64/data URL) or `file_url` instead.",
      400,
      "invalid_request_error",
    );
  }
  throw new GatewayError("Invalid `file` / `input_file` block: `file_data` or `file_url` is required.", 400, "invalid_request_error");
}

function extractContentParts(content: unknown, fileOffset = 0): { text: string; images: NormalizedImage[]; files: NormalizedFile[] } {
  if (typeof content === "string") return { text: content, images: [], files: [] };
  if (!Array.isArray(content)) return { text: "", images: [], files: [] };

  const texts: string[] = [];
  const images: NormalizedImage[] = [];
  const files: NormalizedFile[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const pType = typeof part.type === "string" ? part.type : "";
    if ((pType === "text" || pType === "input_text" || pType === "output_text") && typeof part.text === "string") {
      texts.push(part.text);
    } else if (pType === "image_url") {
      const urlVal = typeof part.image_url === "string"
        ? part.image_url
        : isRecord(part.image_url) && typeof part.image_url.url === "string"
          ? part.image_url.url
          : "";
      const parsed = parseDataUrlOrRemoteImage(urlVal);
      if (parsed) images.push(parsed);
    } else if (pType === "input_image") {
      const urlVal = typeof part.image_url === "string"
        ? part.image_url
        : isRecord(part.image_url) && typeof part.image_url.url === "string"
          ? part.image_url.url
          : typeof part.url === "string"
            ? part.url
            : "";
      const parsed = parseDataUrlOrRemoteImage(urlVal);
      if (parsed) images.push(parsed);
    } else if (pType === "file" && isRecord(part.file)) {
      files.push(parseOpenAiFileObject(part.file, fileOffset + files.length));
    } else if (pType === "input_file") {
      files.push(parseOpenAiFileObject(part, fileOffset + files.length));
    }
  }
  return { text: texts.join("\n"), images, files };
}

export function parseOpenAiTools(rawTools: unknown): {
  customTools: NormalizedTool[];
  nativeSdkTools: Array<"webSearch" | "webFetch">;
} {
  if (!Array.isArray(rawTools)) return { customTools: [], nativeSdkTools: [] };
  const customTools: NormalizedTool[] = [];
  const nativeSet = new Set<"webSearch" | "webFetch">();

  for (const item of rawTools) {
    if (!isRecord(item)) continue;
    const rawType = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";

    // Native built-in search tools (OpenAI `web_search_preview` / `web_search`, xAI `x_search`)
    if (
      rawType === "web_search" ||
      rawType === "web_search_preview" ||
      rawType.startsWith("web_search_") ||
      rawType === "x_search"
    ) {
      nativeSet.add("webSearch");
      nativeSet.add("webFetch");
      continue;
    }
    if (rawType === "web_fetch") {
      nativeSet.add("webFetch");
      continue;
    }

    if (item.type === "function" && isRecord(item.function)) {
      const fn = item.function;
      const name = typeof fn.name === "string" ? fn.name.trim() : "";
      if (!name) continue;
      customTools.push({
        name,
        ...(typeof fn.description === "string" && fn.description ? { description: fn.description } : {}),
        inputSchema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
        toolKind: "function",
      });
    } else if (item.type === "function" && typeof item.name === "string" && item.name.trim()) {
      customTools.push({
        name: item.name.trim(),
        ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
        inputSchema: isRecord(item.parameters) ? item.parameters : { type: "object", properties: {} },
        toolKind: "function",
      });
    } else if (rawType === "custom" && typeof item.name === "string" && item.name.trim()) {
      // OpenAI Responses / Codex CLI free-form custom tools (e.g. `apply_patch`)
      customTools.push({
        name: item.name.trim(),
        ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string", description: "Raw tool input text payload" },
          },
          required: ["input"],
        },
        toolKind: "custom",
      });
    } else if (rawType === "namespace" && typeof item.name === "string" && item.name.trim() && Array.isArray(item.tools)) {
      // OpenAI Responses / Codex CLI namespaced tool groups (e.g. MCP servers `mcp__<server>` and `multi_agent_v1`)
      const ns = item.name.trim();
      for (const sub of item.tools) {
        if (!isRecord(sub)) continue;
        const subType = typeof sub.type === "string" ? sub.type.trim().toLowerCase() : "function";
        const subName =
          typeof sub.name === "string" && sub.name.trim()
            ? sub.name.trim()
            : isRecord(sub.function) && typeof sub.function.name === "string"
              ? sub.function.name.trim()
              : "";
        if (!subName) continue;
        const fnObj = isRecord(sub.function) ? sub.function : sub;
        const subDesc = typeof fnObj.description === "string" && fnObj.description ? fnObj.description : undefined;
        const subSchema =
          subType === "custom"
            ? {
              type: "object",
              properties: {
                input: { type: "string", description: "Raw tool input text payload" },
              },
              required: ["input"],
            }
            : isRecord(fnObj.parameters)
              ? fnObj.parameters
              : { type: "object", properties: {} };
        customTools.push({
          name: `${ns}__${subName}`,
          ...(subDesc ? { description: subDesc } : {}),
          inputSchema: subSchema,
          toolKind: subType === "custom" ? "custom" : "function",
          toolNamespace: ns,
          wireName: subName,
        });
      }
    } else if (rawType === "apply_patch") {
      const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : "apply_patch";
      customTools.push({
        name,
        description:
          typeof item.description === "string" && item.description
            ? item.description
            : "Apply a structured file patch.",
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string", description: "Raw patch text payload" },
          },
          required: ["input"],
        },
        toolKind: "custom",
      });
    } else if (rawType === "local_shell" || rawType === "shell") {
      // OpenAI Responses / Codex CLI local shell / GA shell tool
      const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : rawType;
      customTools.push({
        name,
        description:
          typeof item.description === "string" && item.description
            ? item.description
            : "Propose a shell command for the local CLI runner to execute.",
        inputSchema:
          rawType === "shell"
            ? {
              type: "object",
              properties: {
                commands: { type: "array", items: { type: "string" }, description: "Shell command strings to execute" },
                timeout_ms: { type: "number" },
                max_output_length: { type: "number" },
              },
              required: ["commands"],
            }
            : {
              type: "object",
              properties: {
                command: { type: "array", items: { type: "string" }, description: "Command argv array" },
                working_directory: { type: "string" },
                timeout_ms: { type: "number" },
              },
              required: ["command"],
            },
        toolKind: rawType === "local_shell" ? "local_shell" : "shell",
      });
    }
  }
  return { customTools, nativeSdkTools: [...nativeSet] };
}

export function parseOpenAiToolChoice(raw: unknown): ToolChoiceMode {
  if (raw === "none") return "none";
  if (raw === "required") return "required";
  if (raw === "auto" || raw === undefined || raw === null) return "auto";
  if (isRecord(raw)) {
    if (raw.type === "function" && isRecord(raw.function) && typeof raw.function.name === "string") {
      return { type: "tool", name: raw.function.name.trim() };
    }
    if ((raw.type === "function" || raw.type === "custom") && typeof raw.name === "string") {
      return { type: "tool", name: raw.name.trim() };
    }
    if (raw.type === "local_shell") {
      return { type: "tool", name: "local_shell" };
    }
  }
  return "auto";
}

interface ChatTurnLine extends HashableDialogItem {
  formattedLine: string;
}

/**
 * Reject parameters whose absence would silently break the caller's own parsing logic.
 * (Pure sampling hints such as temperature / max_tokens / stop are accepted and ignored; see README.)
 */
function assertNoUnsupportedStructuredOptions(body: Record<string, unknown>): void {
  const viaText = !isRecord(body.response_format) && isRecord(body.text) && isRecord(body.text.format);
  const fmt = isRecord(body.response_format) ? body.response_format : viaText ? (body.text as Record<string, unknown>).format as Record<string, unknown> : undefined;
  const param = viaText ? "text.format" : "response_format";
  if (fmt && fmt.type !== undefined && fmt.type !== "text") {
    const kind = typeof fmt.type === "string" ? fmt.type : typeof fmt.type;
    const hint =
      kind === "json_schema"
        ? "JSON Schema structured outputs cannot be enforced by AWS Quick; describe the schema in the prompt (or use a tool whose parameters are the schema) and validate client-side."
        : kind === "json_object"
          ? "JSON mode cannot be enforced by AWS Quick; ask for JSON in the prompt and parse it client-side."
          : "Only the default text format is supported.";
    throw new GatewayError(`\`${param}\` of type '${kind}' is not supported. ${hint}`, 400, "unsupported_parameter", param);
  }
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    throw new GatewayError(
      "`n` must be 1: this gateway returns exactly one completion per request.",
      400,
      "unsupported_parameter",
      "n"
    );
  }
  // Length caps cannot be honoured, but malformed values still deserve the same 400 the official API gives.
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new GatewayError(`\`${key}\` must be a positive integer.`, 400, "invalid_request_error", key);
    }
  }
}

export function parseChatCompletionsRequest(
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
  assertNoUnsupportedStructuredOptions(body);

  const requestedModel = requireModelField(body);
  const { customTools: tools, nativeSdkTools } = parseOpenAiTools(body.tools);
  if (body.web_search_options && typeof body.web_search_options === "object") {
    if (!nativeSdkTools.includes("webSearch")) nativeSdkTools.push("webSearch");
    if (!nativeSdkTools.includes("webFetch")) nativeSdkTools.push("webFetch");
  }
  const toolChoice = parseOpenAiToolChoice(body.tool_choice);

  const systemParts: string[] = [];
  const items: ChatTurnLine[] = [];
  const allImages: NormalizedImage[] = [];
  const allFiles: NormalizedFile[] = [];

  for (const rawMsg of body.messages) {
    if (!isRecord(rawMsg)) continue;
    const role = typeof rawMsg.role === "string" ? rawMsg.role.toLowerCase() : "user";
    const { text, images, files } = extractContentParts(rawMsg.content, allFiles.length);
    allImages.push(...images);
    allFiles.push(...files);

    if (role === "system" || role === "developer") {
      if (text.trim()) systemParts.push(text.trim());
      continue;
    }

    if (role === "tool") {
      const callId = typeof rawMsg.tool_call_id === "string" ? rawMsg.tool_call_id : "";
      const name = typeof rawMsg.name === "string" ? rawMsg.name : "";
      const meta = [name ? `name=${name}` : "", callId ? `id=${callId}` : ""].filter(Boolean).join(" ");
      const toolFallback = images.length ? "[Image]" : files.length ? `[File: ${files.map((f) => f.filename).join(", ")}]` : "[empty]";
      items.push({
        role: "tool",
        text,
        images,
        ...(files.length > 0 ? { files } : {}),
        hasTools: true,
        formattedLine: `[TOOL_RESULT${meta ? ` ${meta}` : ""}]:\n${text || toolFallback}`
      });
      continue;
    }

    if (role === "assistant") {
      const hasTools = Array.isArray(rawMsg.tool_calls) && rawMsg.tool_calls.length > 0;
      const parts: string[] = [];
      const toolCallRefs: Array<{ id: string; name: string }> = [];
      if (text.trim()) parts.push(`[ASSISTANT]:\n${text}`);
      if (hasTools) {
        const callsDesc = (rawMsg.tool_calls as unknown[])
          .map((tc) => {
            if (!isRecord(tc)) return "";
            const id = typeof tc.id === "string" ? tc.id : "";
            const fn = isRecord(tc.function) ? tc.function : {};
            const name = typeof fn.name === "string" ? fn.name : "";
            const args =
              typeof fn.arguments === "string"
                ? fn.arguments
                : fn.arguments && typeof fn.arguments === "object"
                  ? JSON.stringify(fn.arguments)
                  : "{}";
            if (id || name) toolCallRefs.push({ id, name });
            return `${name}(${args}) [id=${id}]`;
          })
          .filter(Boolean);
        if (callsDesc.length) parts.push(`[ASSISTANT_TOOL_CALLS]:\n${callsDesc.join("\n")}`);
      }
      if (parts.length > 0) {
        items.push({
          role: "assistant",
          text: text.trim(),
          images: [],
          hasTools,
          ...(toolCallRefs.length > 0 ? { toolCalls: toolCallRefs } : {}),
          formattedLine: parts.join("\n\n")
        });
      }
      continue;
    }

    items.push({
      role: "user",
      text,
      images,
      ...(files.length > 0 ? { files } : {}),
      hasTools: false,
      formattedLine: `[USER]:\n${text || (images.length ? "[Image]" : files.length ? `[File: ${files.map((f) => f.filename).join(", ")}]` : "[empty]")}`
    });
  }

  if (items.length === 0 && systemParts.length > 0) {
    const lastSys = systemParts.pop()!;
    items.push({ role: "user", text: lastSys, images: [], hasTools: false, formattedLine: lastSys });
  }

  const fullTranscriptText = items.length === 1 && items[0].role === "user"
    ? (items[0].text || (items[0].images.length ? "[Image]" : allFiles.length ? `[File: ${allFiles.map((f) => f.filename).join(", ")}]` : ""))
    : items.map((it) => it.formattedLine).join("\n\n");

  const systemJoined = systemParts.join("\n\n");
  const toolSig = (toolChoice === "none" ? [] : tools).map((t) => t.name).join(",");
  const prefixHashes = computeDialogPrefixHashes({
    systemPrompt: systemJoined,
    toolNamesSignature: toolSig,
    items
  });

  const trailingToolResults: NormalizedToolResult[] = [];
  let trailingUserText: string | undefined;
  const trailingImages: NormalizedImage[] = [];
  let idx = body.messages.length - 1;

  const roleOf = (m: unknown): string => (isRecord(m) && typeof m.role === "string" ? m.role.toLowerCase() : "");
  if (idx >= 1 && roleOf(body.messages[idx]) === "user") {
    const prev = body.messages[idx - 1];
    if (roleOf(prev) === "tool") {
      const trailing = extractContentParts((body.messages[idx] as Record<string, unknown>).content);
      trailingUserText = trailing.text;
      if (trailing.images.length) trailingImages.push(...trailing.images);
      idx -= 1;
    }
  }

  while (idx >= 0) {
    const m = body.messages[idx];
    if (!isRecord(m) || roleOf(m) !== "tool") break;
    const callId = typeof m.tool_call_id === "string" ? m.tool_call_id.trim() : "";
    if (callId) {
      const parts = extractContentParts(m.content);
      trailingToolResults.unshift({
        toolCallId: callId,
        ...(typeof m.name === "string" ? { name: m.name } : {}),
        content: parts.text,
        ...(parts.images.length ? { images: parts.images } : {})
      });
    }
    idx -= 1;
  }

  const conversationKey = deriveConversationAffinityKey({
    headers,
    rawBody: body,
    systemPrompt: systemJoined,
    firstUserText: extractFirstUserTurnText(items)
  });

  return {
    requestedModel,
    rawBody: body,
    ...(conversationKey ? { conversationKey } : {}),
    ...(systemJoined ? { systemPrompt: systemJoined } : {}),
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
    hasToolResults: items.some((it) => it.role === "tool") || trailingToolResults.length > 0,
    stream: body.stream === true,
    includeStreamUsage: isRecord(body.stream_options) && body.stream_options.include_usage === true,
    estimatedInputTokens: Math.max(1, Math.ceil((systemJoined.length + fullTranscriptText.length) / 4)) + estimateImageTokens(allImages.length + allFiles.length),
    signal
  };
}

export function parseResponsesRequest(
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
  signal?: AbortSignal
): ParsedProtocolTurn {
  if (!isRecord(body)) {
    throw new GatewayError("Request body must be a JSON object.", 400, "invalid_request_error");
  }

  assertNoUnsupportedStructuredOptions(body);
  if (typeof body.previous_response_id === "string" && body.previous_response_id.trim()) {
    throw new GatewayError(
      "`previous_response_id` is not supported: this gateway does not store responses. Resend the full conversation in `input`.",
      400,
      "unsupported_parameter",
      "previous_response_id"
    );
  }

  const requestedModel = requireModelField(body);
  const { customTools: tools, nativeSdkTools } = parseOpenAiTools(body.tools);
  const toolChoice = parseOpenAiToolChoice(body.tool_choice);
  const systemParts: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    systemParts.push(body.instructions.trim());
  }

  const transcriptLines: string[] = [];
  const items: HashableDialogItem[] = [];
  const allImages: NormalizedImage[] = [];
  const allFiles: NormalizedFile[] = [];
  const trailingToolResults: NormalizedToolResult[] = [];
  let trailingUserText: string | undefined;
  const trailingImages: NormalizedImage[] = [];
  let hasToolResults = false;

  if (typeof body.input === "string") {
    transcriptLines.push(body.input);
    items.push({ role: "user", text: body.input, images: [], hasTools: false });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isRecord(item)) continue;
      const itemType = typeof item.type === "string" ? item.type : "message";
      if (
        itemType === "function_call_output" ||
        itemType === "custom_tool_call_output" ||
        itemType === "local_shell_call_output" ||
        itemType === "shell_call_output" ||
        itemType === "apply_patch_call_output"
      ) {
        hasToolResults = true;
        const callId = typeof item.call_id === "string" ? item.call_id.trim() : "";
        let outStr = "";
        let outImages: NormalizedImage[] = [];
        let outFiles: NormalizedFile[] = [];
        if (typeof item.output === "string") {
          outStr = item.output;
        } else if (Array.isArray(item.output)) {
          // Codex CLI GA `shell_call_output` entries have `{ stdout, stderr, outcome }`
          const shellChunks = item.output
            .map((entry) => {
              if (!isRecord(entry) || !("stdout" in entry || "stderr" in entry)) return null;
              const stdout = typeof entry.stdout === "string" ? entry.stdout : "";
              const stderr = typeof entry.stderr === "string" ? entry.stderr : "";
              const outcome = isRecord(entry.outcome) ? JSON.stringify(entry.outcome) : "";
              return [stdout, stderr ? `[stderr]\n${stderr}` : "", outcome ? `[outcome] ${outcome}` : ""]
                .filter(Boolean)
                .join("\n");
            })
            .filter((s): s is string => s !== null);
          if (shellChunks.length > 0) {
            outStr = shellChunks.join("\n");
          } else {
            const parts = extractContentParts(item.output, allFiles.length);
            outStr = parts.text;
            outImages = parts.images;
            outFiles = parts.files;
            allImages.push(...outImages);
            allFiles.push(...outFiles);
          }
        } else if (itemType === "apply_patch_call_output" && typeof item.status === "string") {
          outStr = item.output ? JSON.stringify(item.output) : `status=${item.status}`;
        } else {
          outStr = JSON.stringify(item.output ?? "");
        }
        const toolFallback = outImages.length ? "[Image]" : outFiles.length ? `[File: ${outFiles.map((f) => f.filename).join(", ")}]` : "";
        const toolResLine = `[TOOL_RESULT id=${callId}]:\n${outStr || toolFallback}`;
        transcriptLines.push(toolResLine);
        if (callId) {
          trailingToolResults.push({
            toolCallId: callId,
            content: outStr,
            ...(outImages.length ? { images: outImages } : {})
          });
        }
        items.push({
          role: "tool",
          text: outStr,
          images: outImages,
          ...(outFiles.length > 0 ? { files: outFiles } : {}),
          hasTools: true,
          formattedLine: toolResLine
        });
        continue;
      }
      if (
        itemType === "function_call" ||
        itemType === "custom_tool_call" ||
        itemType === "local_shell_call" ||
        itemType === "shell_call" ||
        itemType === "apply_patch_call"
      ) {
        trailingToolResults.length = 0;
        const callId = typeof item.call_id === "string" ? item.call_id : "";
        const rawName =
          itemType === "local_shell_call"
            ? "local_shell"
            : itemType === "shell_call"
              ? "shell"
              : itemType === "apply_patch_call"
                ? "apply_patch"
                : typeof item.name === "string"
                  ? item.name
                  : "";
        const ns = typeof item.namespace === "string" && item.namespace.trim() ? item.namespace.trim() : "";
        const name = ns && rawName ? `${ns}__${rawName}` : rawName;
        const args =
          itemType === "custom_tool_call"
            ? typeof item.input === "string"
              ? item.input
              : JSON.stringify(item.input ?? "")
            : itemType === "local_shell_call" || itemType === "shell_call"
              ? JSON.stringify(item.action ?? {})
              : itemType === "apply_patch_call"
                ? JSON.stringify(item.operation ?? item.input ?? {})
                : typeof item.arguments === "string"
                  ? item.arguments
                  : "{}";
        const toolCallLine = `[ASSISTANT_TOOL_CALLS]:\n${name}(${args}) [id=${callId}]`;
        transcriptLines.push(toolCallLine);
        items.push({
          role: "assistant",
          text: "",
          images: [],
          hasTools: true,
          toolCalls: [{ id: callId, name }],
          formattedLine: toolCallLine
        });
        continue;
      }
      if (itemType === "compaction") {
        // Codex CLI / Responses API compaction summary item: preserve summary text if present.
        const summary =
          typeof item.summary === "string"
            ? item.summary.trim()
            : typeof item.encrypted_content === "string"
              ? ""
              : "";
        if (summary) {
          const line = `[USER]:\n[Compacted Context Summary]\n${summary}`;
          transcriptLines.push(line);
          items.push({ role: "user", text: summary, images: [], hasTools: false, formattedLine: line });
        }
        continue;
      }
      if (itemType !== "message" && !("role" in item)) {
        // Non-user/server-side Responses items carry no actionable client text to replay.
        if (
          itemType === "reasoning" ||
          itemType === "item_reference" ||
          itemType === "web_search_call" ||
          itemType === "mcp_call" ||
          itemType === "mcp_list_tools" ||
          itemType === "mcp_approval_request" ||
          itemType === "mcp_approval_response" ||
          itemType === "code_interpreter_call" ||
          itemType === "file_search_call" ||
          itemType === "computer_call" ||
          itemType === "computer_call_output"
        ) {
          continue;
        }
        throw new GatewayError(
          `Unsupported input item type '${itemType}'. This gateway refuses to silently ignore it.`,
          400,
          "invalid_request_error",
          "input"
        );
      }
      const role = typeof item.role === "string" ? item.role.toLowerCase() : "user";
      const { text, images, files } = extractContentParts(item.content, allFiles.length);
      allImages.push(...images);
      allFiles.push(...files);
      if (role === "system" || role === "developer") {
        if (text.trim()) systemParts.push(text.trim());
      } else if (role === "assistant") {
        trailingToolResults.length = 0;
        trailingUserText = undefined;
        trailingImages.length = 0;
        if (text.trim()) transcriptLines.push(`[ASSISTANT]:\n${text}`);
        items.push({ role: "assistant", text, images, hasTools: false });
      } else {
        const placeholder = images.length ? "[Image]" : files.length ? `[File: ${files.map((f) => f.filename).join(", ")}]` : "[empty]";
        const userLine = `[USER]:\n${text || placeholder}`;
        transcriptLines.push(userLine);
        items.push({ role: "user", text, images, ...(files.length > 0 ? { files } : {}), hasTools: false, formattedLine: userLine });
        // A user message that follows tool outputs is the same turn's trailing user text
        // (mirrors the Chat Completions path); without this the new text was silently dropped on resume.
        if (trailingToolResults.length > 0) {
          if (text.trim()) trailingUserText = [trailingUserText, text.trim()].filter(Boolean).join("\n");
          trailingImages.push(...images);
        } else {
          trailingUserText = undefined;
          trailingImages.length = 0;
        }
      }
    }
  } else {
    throw new GatewayError("`input` must be a string or array.", 400, "invalid_request_error", "input");
  }

  if (items.length === 0 && systemParts.length > 0) {
    const lastSys = systemParts.pop()!;
    items.push({ role: "user", text: lastSys, images: [], hasTools: false, formattedLine: lastSys });
    transcriptLines.push(lastSys);
  }

  const systemJoined = systemParts.join("\n\n");
  const fullTranscriptText =
    items.length === 1 && items[0].role === "user"
      ? (items[0].text || (items[0].images.length ? "[Image]" : allFiles.length ? `[File: ${allFiles.map((f) => f.filename).join(", ")}]` : ""))
      : transcriptLines.join("\n\n");
  const toolSig = (toolChoice === "none" ? [] : tools).map((t) => t.name).join(",");
  const prefixHashes = computeDialogPrefixHashes({
    systemPrompt: systemJoined,
    toolNamesSignature: toolSig,
    items
  });
  const conversationKey = deriveConversationAffinityKey({
    headers,
    rawBody: body,
    systemPrompt: systemJoined,
    firstUserText: extractFirstUserTurnText(items)
  });
  return {
    requestedModel,
    rawBody: body,
    ...(conversationKey ? { conversationKey } : {}),
    ...(systemJoined ? { systemPrompt: systemJoined } : {}),
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
    hasToolResults,
    stream: body.stream === true,
    estimatedInputTokens: Math.max(1, Math.ceil((systemJoined.length + fullTranscriptText.length) / 4)) + estimateImageTokens(allImages.length + allFiles.length),
    signal
  };
}

function formatOpenAiUsageObject(m: TurnTokenMetrics): Record<string, unknown> {
  const promptTotal = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
  return {
    prompt_tokens: promptTotal,
    completion_tokens: m.outputTokens,
    total_tokens: promptTotal + m.outputTokens,
    prompt_tokens_details: { cached_tokens: m.cacheReadTokens },
    ...(m.reasoningTokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: m.reasoningTokens } }
      : {})
  };
}

export function formatOpenAiError(err: GatewayError): Record<string, unknown> {
  return {
    error: {
      message: err.message,
      type: officialErrorType(err, "openai"),
      param: err.param ?? null,
      code: err.code
    }
  };
}

export const openAiChatAdapter: ProtocolAdapter = {
  errorFormat: "openai",
  parse: (body, headers, signal) => parseChatCompletionsRequest(body, headers, signal),
  async collectJson(events, turn) {
    const id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    const { thinking, text, toolCalls, stopReason, metrics } = await collectTurnEvents(events);

    const message: Record<string, unknown> = {
      role: "assistant",
      content: toolCalls.length > 0 && !text ? null : text
    };
    if (thinking) message.reasoning_content = thinking;
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argumentsJson }
      }));
    }

    return {
      id,
      object: "chat.completion",
      created,
      model: turn.requestedModel,
      ...(metrics.resolvedModel ? { system_fingerprint: metrics.resolvedModel } : {}),
      choices: [{ index: 0, message, finish_reason: stopReason }],
      usage: formatOpenAiUsageObject(metrics)
    };
  },
  async *streamSse(events, turn) {
    const id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    let lastMetrics: TurnTokenMetrics | null = null;

    const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null, usageObj?: Record<string, unknown>) => {
      const payload: Record<string, unknown> = {
        id,
        object: "chat.completion.chunk",
        created,
        model: turn.requestedModel,
        ...(lastMetrics?.resolvedModel ? { system_fingerprint: lastMetrics.resolvedModel } : {}),
        choices: Object.keys(delta).length === 0 && finishReason === null && usageObj
          ? []
          : [{ index: 0, delta, finish_reason: finishReason }]
      };
      if (usageObj) payload.usage = usageObj;
      else if (turn.includeStreamUsage) payload.usage = null;
      return `data: ${JSON.stringify(payload)}\n\n`;
    };

    const fallbackMetrics = (): TurnTokenMetrics => ({
      inputTokens: Math.max(1, turn.estimatedInputTokens || 1),
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const disableParallel = turn.rawBody?.parallel_tool_calls === false;

    let sentRole = false;
    let sentDone = false;
    const allowedStreamIndices = new Set<number>();

    for await (const ev of events) {
      if (
        !sentRole &&
        (ev.type === "thinking" ||
          ev.type === "text" ||
          ev.type === "tool_call_start" ||
          ev.type === "tool_calls")
      ) {
        sentRole = true;
        yield makeChunk({ role: "assistant", content: "" });
      }
      if (ev.type === "thinking") {
        yield makeChunk({ reasoning_content: ev.text });
      } else if (ev.type === "text") {
        yield makeChunk({ content: ev.text });
      } else if (ev.type === "tool_call_start") {
        if (disableParallel && allowedStreamIndices.size >= 1) continue;
        allowedStreamIndices.add(ev.index);
        yield makeChunk({
          tool_calls: [{
            index: ev.index,
            id: ev.id,
            type: "function",
            function: { name: ev.name, arguments: "" }
          }]
        });
      } else if (ev.type === "tool_call_delta") {
        if (!allowedStreamIndices.has(ev.index)) continue;
        if (ev.argumentsDelta) {
          yield makeChunk({
            tool_calls: [{
              index: ev.index,
              function: { arguments: ev.argumentsDelta }
            }]
          });
        }
      } else if (ev.type === "tool_call_end") {
        // Already streamed start + deltas; nothing extra required for OpenAI Chat Completions.
      } else if (ev.type === "tool_calls") {
        const calls = disableParallel ? ev.calls.slice(0, 1) : ev.calls;
        yield makeChunk({
          tool_calls: calls.map((tc, idx) => ({
            index: idx,
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.argumentsJson }
          }))
        });
      } else if (ev.type === "usage") {
        lastMetrics = ev.metrics;
      } else if (ev.type === "done") {
        sentDone = true;
        if (!sentRole) {
          sentRole = true;
          yield makeChunk({ role: "assistant", content: "" });
        }
        yield makeChunk({}, ev.stopReason);
        if (turn.includeStreamUsage) {
          yield makeChunk({}, null, formatOpenAiUsageObject(lastMetrics ?? fallbackMetrics()));
        }
      }
    }
    if (!sentDone) {
      if (!sentRole) yield makeChunk({ role: "assistant", content: "" });
      yield makeChunk({}, "stop");
      if (turn.includeStreamUsage) {
        yield makeChunk({}, null, formatOpenAiUsageObject(lastMetrics ?? fallbackMetrics()));
      }
    }
    yield "data: [DONE]\n\n";
  },
  formatSseErrorFrame: (err) => `data: ${JSON.stringify(formatOpenAiError(err))}\n\ndata: [DONE]\n\n`
};

export const openAiResponsesAdapter: ProtocolAdapter = {
  errorFormat: "openai",
  parse: (body, headers, signal) => parseResponsesRequest(body, headers, signal),
  async collectJson(events, turn) {
    const respId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
    const msgId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    const { thinking, text, toolCalls, metrics, stopReason } = await collectTurnEvents(events);

    const output: Array<Record<string, unknown>> = [];
    if (thinking) {
      output.push({
        id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "reasoning",
        summary: [{ type: "summary_text", text: thinking }]
      });
    }
    if (text || toolCalls.length === 0) {
      output.push({
        id: msgId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }]
      });
    }
    const toolMetaByName = new Map<string, NormalizedTool>();
    for (const t of turn.tools) {
      toolMetaByName.set(t.name, t);
      if (t.wireName && !toolMetaByName.has(t.wireName)) toolMetaByName.set(t.wireName, t);
    }
    for (const tc of toolCalls) {
      const meta = toolMetaByName.get(tc.name);
      const kind = meta?.toolKind ?? "function";
      const wireName = meta?.wireName ?? tc.name;
      const nsField = meta?.toolNamespace ? { namespace: meta.toolNamespace } : {};
      if (kind === "custom") {
        const inputStr = typeof tc.argsObject.input === "string" ? tc.argsObject.input : tc.argumentsJson;
        output.push({
          id: `ctc_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "custom_tool_call",
          status: "completed",
          call_id: tc.id,
          name: wireName,
          ...nsField,
          input: inputStr,
        });
      } else if (kind === "local_shell") {
        const rawCmd = tc.argsObject.command;
        const cmd = Array.isArray(rawCmd)
          ? rawCmd.map((x) => String(x))
          : typeof rawCmd === "string"
            ? ["bash", "-lc", rawCmd]
            : [];
        output.push({
          id: `lsh_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "local_shell_call",
          status: "completed",
          call_id: tc.id,
          action: {
            type: "exec",
            command: cmd,
            ...(typeof tc.argsObject.working_directory === "string"
              ? { working_directory: tc.argsObject.working_directory }
              : {}),
            ...(typeof tc.argsObject.timeout_ms === "number" ? { timeout_ms: tc.argsObject.timeout_ms } : {}),
          },
        });
      } else if (kind === "shell") {
        const rawCmds = tc.argsObject.commands ?? tc.argsObject.command;
        const commands = Array.isArray(rawCmds)
          ? rawCmds.map((x) => String(x))
          : typeof rawCmds === "string"
            ? [rawCmds]
            : [];
        output.push({
          id: `sh_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "shell_call",
          status: "completed",
          call_id: tc.id,
          action: {
            commands,
            ...(typeof tc.argsObject.timeout_ms === "number" ? { timeout_ms: tc.argsObject.timeout_ms } : {}),
            ...(typeof tc.argsObject.max_output_length === "number"
              ? { max_output_length: tc.argsObject.max_output_length }
              : {}),
          },
        });
      } else {
        output.push({
          id: `fc_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "function_call",
          status: "completed",
          call_id: tc.id,
          name: wireName,
          ...nsField,
          arguments: tc.argumentsJson,
        });
      }
    }

    const totalInput = metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens;
    const isIncomplete = stopReason === "length";
    return {
      id: respId,
      object: "response",
      created_at: created,
      status: isIncomplete ? "incomplete" : "completed",
      ...(isIncomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      model: turn.requestedModel,
      output,
      output_text: text,
      usage: {
        input_tokens: totalInput,
        output_tokens: metrics.outputTokens,
        total_tokens: totalInput + metrics.outputTokens,
        input_tokens_details: { cached_tokens: metrics.cacheReadTokens },
        output_tokens_details: { reasoning_tokens: metrics.reasoningTokens ?? 0 }
      }
    };
  },
  async *streamSse(events, turn) {
    const respId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    let seq = 0;
    const sse = (event: string, data: Record<string, unknown>) =>
      `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data, sequence_number: seq++ })}\n\n`;
    const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
    const baseResponse = (status: string, output: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
      id: respId,
      object: "response",
      created_at: created,
      status,
      model: turn.requestedModel,
      output,
      ...extra
    });

    // Pull the first upstream event BEFORE yielding `response.created` so pre-stream
    // 401/403/429/502 errors surface as real HTTP statuses instead of HTTP 200 SSE.
    const iter = events[Symbol.asyncIterator]();
    // Items are opened lazily and closed on every kind transition (reasoning <-> message <-> tool calls),
    // so a model that interleaves them still yields a spec-shaped stream.
    const output: Array<Record<string, unknown>> = [];
    let open: { kind: "reasoning" | "message"; id: string; index: number; text: string } | null = null;
    let fullText = "";
    let sawMessage = false;
    let sawToolCalls = false;
    let finalStopReason: "stop" | "tool_calls" | "length" = "stop";
    let metrics: TurnTokenMetrics = {
      inputTokens: Math.max(1, turn.estimatedInputTokens || 1),
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const disableParallel = turn.rawBody?.parallel_tool_calls === false;
    let emittedCreated = false;
    const toolMetaByName = new Map<string, NormalizedTool>();
    for (const t of turn.tools) {
      toolMetaByName.set(t.name, t);
      if (t.wireName && !toolMetaByName.has(t.wireName)) toolMetaByName.set(t.wireName, t);
    }
    const allowedStreamToolIndices = new Set<number>();
    let openTool: {
      streamIndex: number;
      outputIndex: number;
      id: string;
      callId: string;
      wireName: string;
      nsField: Record<string, string>;
      args: string;
    } | null = null;

    const closeOpenTool = function* (finalArgsOverride?: string): Generator<string> {
      if (!openTool) return;
      const cur = openTool;
      openTool = null;
      const finalArgs = finalArgsOverride !== undefined ? finalArgsOverride : (cur.args || "{}");
      const base = { id: cur.id, type: "function_call", call_id: cur.callId, name: cur.wireName, ...cur.nsField };
      yield sse("response.function_call_arguments.done", {
        item_id: cur.id,
        output_index: cur.outputIndex,
        name: cur.wireName,
        arguments: finalArgs,
      });
      const item = { ...base, status: "completed", arguments: finalArgs };
      output[cur.outputIndex] = item;
      yield sse("response.output_item.done", { output_index: cur.outputIndex, item });
    };

    const emitSingleCompletedToolCall = function* (tc: import("../core/types.js").NormalizedToolCall): Generator<string> {
      const index = output.length;
      const meta = toolMetaByName.get(tc.name);
      const kind = meta?.toolKind ?? "function";
      const wireName = meta?.wireName ?? tc.name;
      const nsField = meta?.toolNamespace ? { namespace: meta.toolNamespace } : {};
      output.push({});
      if (kind === "custom") {
        const id = newId("ctc");
        const inputStr = typeof tc.argsObject.input === "string" ? tc.argsObject.input : tc.argumentsJson;
        const base = { id, type: "custom_tool_call", call_id: tc.id, name: wireName, ...nsField };
        yield sse("response.output_item.added", { output_index: index, item: { ...base, status: "in_progress", input: "" } });
        yield sse("response.custom_tool_call_input.delta", { item_id: id, output_index: index, delta: inputStr });
        yield sse("response.custom_tool_call_input.done", { item_id: id, output_index: index, input: inputStr });
        const item = { ...base, status: "completed", input: inputStr };
        output[index] = item;
        yield sse("response.output_item.done", { output_index: index, item });
      } else if (kind === "local_shell") {
        const id = newId("lsh");
        const rawCmd = tc.argsObject.command;
        const cmd = Array.isArray(rawCmd)
          ? rawCmd.map((x) => String(x))
          : typeof rawCmd === "string"
            ? ["bash", "-lc", rawCmd]
            : [];
        const action = {
          type: "exec",
          command: cmd,
          ...(typeof tc.argsObject.working_directory === "string"
            ? { working_directory: tc.argsObject.working_directory }
            : {}),
          ...(typeof tc.argsObject.timeout_ms === "number" ? { timeout_ms: tc.argsObject.timeout_ms } : {}),
        };
        const item = { id, type: "local_shell_call", call_id: tc.id, status: "completed", action };
        yield sse("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress" } });
        output[index] = item;
        yield sse("response.output_item.done", { output_index: index, item });
      } else if (kind === "shell") {
        const id = newId("sh");
        const rawCmds = tc.argsObject.commands ?? tc.argsObject.command;
        const commands = Array.isArray(rawCmds)
          ? rawCmds.map((x) => String(x))
          : typeof rawCmds === "string"
            ? [rawCmds]
            : [];
        const action = {
          commands,
          ...(typeof tc.argsObject.timeout_ms === "number" ? { timeout_ms: tc.argsObject.timeout_ms } : {}),
          ...(typeof tc.argsObject.max_output_length === "number"
            ? { max_output_length: tc.argsObject.max_output_length }
            : {}),
        };
        const item = { id, type: "shell_call", call_id: tc.id, status: "completed", action };
        yield sse("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress" } });
        output[index] = item;
        yield sse("response.output_item.done", { output_index: index, item });
      } else {
        const id = newId("fc");
        const base = { id, type: "function_call", call_id: tc.id, name: wireName, ...nsField };
        yield sse("response.output_item.added", { output_index: index, item: { ...base, status: "in_progress", arguments: "" } });
        yield sse("response.function_call_arguments.delta", { item_id: id, output_index: index, delta: tc.argumentsJson });
        yield sse("response.function_call_arguments.done", { item_id: id, output_index: index, name: wireName, arguments: tc.argumentsJson });
        const item = { ...base, status: "completed", arguments: tc.argumentsJson };
        output[index] = item;
        yield sse("response.output_item.done", { output_index: index, item });
      }
    };

    const closeOpen = function* (): Generator<string> {
      if (!open) return;
      const cur = open;
      open = null;
      if (cur.kind === "reasoning") {
        const part = { type: "summary_text", text: cur.text };
        yield sse("response.reasoning_summary_text.done", { item_id: cur.id, output_index: cur.index, summary_index: 0, text: cur.text });
        yield sse("response.reasoning_summary_part.done", { item_id: cur.id, output_index: cur.index, summary_index: 0, part });
        const item = { id: cur.id, type: "reasoning", summary: [part] };
        output[cur.index] = item;
        yield sse("response.output_item.done", { output_index: cur.index, item });
      } else {
        const part = { type: "output_text", text: cur.text, annotations: [] };
        yield sse("response.output_text.done", { item_id: cur.id, output_index: cur.index, content_index: 0, text: cur.text });
        yield sse("response.content_part.done", { item_id: cur.id, output_index: cur.index, content_index: 0, part });
        const item = { id: cur.id, type: "message", status: "completed", role: "assistant", content: [part] };
        output[cur.index] = item;
        yield sse("response.output_item.done", { output_index: cur.index, item });
      }
    };

    const openItem = function* (kind: "reasoning" | "message"): Generator<string> {
      if (open && open.kind === kind) return;
      yield* closeOpen();
      const index = output.length;
      const id = newId(kind === "reasoning" ? "rs" : "msg");
      output.push({});
      open = { kind, id, index, text: "" };
      if (kind === "reasoning") {
        yield sse("response.output_item.added", { output_index: index, item: { id, type: "reasoning", summary: [] } });
        yield sse("response.reasoning_summary_part.added", {
          item_id: id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" }
        });
      } else {
        sawMessage = true;
        yield sse("response.output_item.added", {
          output_index: index,
          item: { id, type: "message", status: "in_progress", role: "assistant", content: [] }
        });
        yield sse("response.content_part.added", {
          item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] }
        });
      }
    };

    try {
      let step = await iter.next();

      emittedCreated = true;
      yield sse("response.created", { response: baseResponse("in_progress", [], { error: null, incomplete_details: null }) });
      yield sse("response.in_progress", { response: baseResponse("in_progress", [], { error: null, incomplete_details: null }) });

      while (!step.done) {
        const ev = step.value;
        if (ev.type === "thinking") {
          if (ev.text && !sawMessage && !sawToolCalls) {
            yield* openItem("reasoning");
            open!.text += ev.text;
            yield sse("response.reasoning_summary_text.delta", {
              item_id: open!.id, output_index: open!.index, summary_index: 0, delta: ev.text
            });
          }
        } else if (ev.type === "text") {
          if (ev.text) {
            yield* openItem("message");
            open!.text += ev.text;
            fullText += ev.text;
            yield sse("response.output_text.delta", {
              item_id: open!.id, output_index: open!.index, content_index: 0, delta: ev.text, logprobs: []
            });
          }
        } else if (ev.type === "tool_call_start") {
          if (disableParallel && allowedStreamToolIndices.size >= 1) {
            step = await iter.next();
            continue;
          }
          allowedStreamToolIndices.add(ev.index);
          yield* closeOpen();
          yield* closeOpenTool();
          sawToolCalls = true;
          const meta = toolMetaByName.get(ev.name);
          const kind = meta?.toolKind ?? "function";
          if (kind === "function") {
            const outputIndex = output.length;
            const id = newId("fc");
            const wireName = meta?.wireName ?? ev.name;
            const nsField: Record<string, string> = meta?.toolNamespace ? { namespace: meta.toolNamespace } : {};
            output.push({});
            openTool = {
              streamIndex: ev.index,
              outputIndex,
              id,
              callId: ev.id,
              wireName,
              nsField,
              args: "",
            };
            yield sse("response.output_item.added", {
              output_index: outputIndex,
              item: { id, type: "function_call", call_id: ev.id, name: wireName, ...nsField, status: "in_progress", arguments: "" },
            });
          }
        } else if (ev.type === "tool_call_delta") {
          if (openTool && openTool.streamIndex === ev.index && ev.argumentsDelta) {
            openTool.args += ev.argumentsDelta;
            yield sse("response.function_call_arguments.delta", {
              item_id: openTool.id,
              output_index: openTool.outputIndex,
              delta: ev.argumentsDelta,
            });
          }
        } else if (ev.type === "tool_call_end") {
          if (!allowedStreamToolIndices.has(ev.index)) {
            step = await iter.next();
            continue;
          }
          if (openTool && openTool.streamIndex === ev.index) {
            yield* closeOpenTool(openTool.args || ev.call.argumentsJson);
          } else {
            yield* closeOpen();
            yield* closeOpenTool();
            sawToolCalls = true;
            yield* emitSingleCompletedToolCall(ev.call);
          }
        } else if (ev.type === "tool_calls") {
          yield* closeOpen();
          yield* closeOpenTool();
          sawToolCalls = true;
          const calls = disableParallel ? ev.calls.slice(0, 1) : ev.calls;
          for (const tc of calls) {
            yield* emitSingleCompletedToolCall(tc);
          }
        } else if (ev.type === "usage") {
          metrics = ev.metrics;
        } else if (ev.type === "done") {
          finalStopReason = ev.stopReason;
        }
        step = await iter.next();
      }
    } catch (streamErr) {
      if (!emittedCreated) throw streamErr;
      const gwErr = streamErr instanceof GatewayError
        ? streamErr
        : new GatewayError(streamErr instanceof Error ? streamErr.message : String(streamErr), 502, "upstream_error");
      yield* closeOpen();
      yield* closeOpenTool();
      yield sse("response.failed", {
        response: baseResponse("failed", output, {
          error: { code: gwErr.code, message: gwErr.message },
          incomplete_details: null,
          output_text: fullText,
        }),
      });
      yield sse("error", {
        code: gwErr.code,
        message: gwErr.message,
        param: gwErr.param ?? null,
      });
      return;
    } finally {
      await iter.return?.().catch(() => undefined);
    }
    yield* closeOpen();
    yield* closeOpenTool();

    // A reply with no text and no tool call still carries one (empty) assistant message, as the official API does.
    if (!sawMessage && !sawToolCalls) {
      yield* openItem("message");
      yield* closeOpen();
    }

    const totalInput = metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens;
    const isIncomplete = finalStopReason === "length";
    yield sse(isIncomplete ? "response.incomplete" : "response.completed", {
      response: baseResponse(isIncomplete ? "incomplete" : "completed", output, {
        ...(isIncomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        output_text: fullText,
        usage: {
          input_tokens: totalInput,
          output_tokens: metrics.outputTokens,
          total_tokens: totalInput + metrics.outputTokens,
          input_tokens_details: { cached_tokens: metrics.cacheReadTokens },
          output_tokens_details: { reasoning_tokens: metrics.reasoningTokens ?? 0 }
        }
      })
    });
  },
  formatSseErrorFrame: (err) =>
    `event: error\ndata: ${JSON.stringify({
      type: "error",
      code: err.code,
      message: err.message,
      param: err.param ?? null,
      sequence_number: 0,
    })}\n\n`
};
