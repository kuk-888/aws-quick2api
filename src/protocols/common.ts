import { GatewayError } from "../core/types.js";
import type {
  GatewayStreamEvent,
  NormalizedImage,
  NormalizedToolCall,
  ParsedProtocolTurn,
  TurnTokenMetrics
} from "../core/types.js";

export interface CollectedTurnResult {
  thinking: string;
  text: string;
  toolCalls: NormalizedToolCall[];
  stopReason: "stop" | "tool_calls" | "length";
  metrics: TurnTokenMetrics;
}

function upgradeRoutedHeaderExact(thinking: string, actualModel: string): string {
  const exactTag = `routed=${actualModel}`;
  if (/^\[AWS Quick\] [^\n]*routed≈[^\s·\n]+/.test(thinking)) {
    return thinking.replace(/^(\[AWS Quick\] [^\n]*)routed≈[^\s·\n]+/, (_, prefix: string) => `${prefix}${exactTag}`);
  }
  if (thinking.startsWith("[AWS Quick] ") && !/^\[AWS Quick\] [^\n]*routed=/.test(thinking)) {
    const nlIdx = thinking.indexOf("\n");
    const firstLine = nlIdx >= 0 ? thinking.slice(0, nlIdx) : thinking;
    const rest = nlIdx >= 0 ? thinking.slice(nlIdx) : "";
    const updatedFirst = firstLine.includes(" · rephrased")
      ? firstLine.replace(" · rephrased", ` · ${exactTag} · rephrased`)
      : `${firstLine} · ${exactTag}`;
    return `${updatedFirst}${rest}`;
  }
  return thinking;
}

/**
 * Shared non-streaming event accumulator used across OpenAI Chat, OpenAI Responses, and Anthropic Messages.
 */
export async function collectTurnEvents(events: AsyncIterable<GatewayStreamEvent>): Promise<CollectedTurnResult> {
  let thinking = "";
  let text = "";
  let toolCalls: NormalizedToolCall[] = [];
  let stopReason: "stop" | "tool_calls" | "length" = "stop";
  let metrics: TurnTokenMetrics = {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  };

  for await (const ev of events) {
    if (ev.type === "reset") {
      thinking = "";
      text = "";
      toolCalls = [];
      stopReason = "stop";
    } else if (ev.type === "thinking") {
      if (ev.lateRoutingCorrection && ev.actualRoutedModel) {
        const upgraded = upgradeRoutedHeaderExact(thinking, ev.actualRoutedModel);
        thinking = upgraded !== thinking ? upgraded : `${thinking}${ev.text}`;
      } else {
        thinking += ev.text;
      }
    } else if (ev.type === "text") text += ev.text;
    else if (ev.type === "tool_call_end") toolCalls.push(ev.call);
    else if (ev.type === "tool_calls") toolCalls = ev.calls;
    else if (ev.type === "usage") {
      metrics = ev.metrics;
      if (ev.metrics.resolvedModel) {
        thinking = upgradeRoutedHeaderExact(thinking, ev.metrics.resolvedModel);
      }
    } else if (ev.type === "done") stopReason = ev.stopReason;
  }

  return { thinking, text, toolCalls, stopReason, metrics };
}

/**
 * Flat per-image input-token estimate. Real vision cost depends on pixel dimensions (roughly
 * 1.1-1.6k tokens for a typical large image), never on the base64 byte length, so the payload
 * must not be counted as text. Upstream usage replaces this estimate whenever it is reported.
 */
export const IMAGE_TOKEN_ESTIMATE = 1200;

export function estimateImageTokens(imageCount: number): number {
  return Math.max(0, imageCount) * IMAGE_TOKEN_ESTIMATE;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Soft-bridges OpenAI `response_format` / Responses `text.format` / Anthropic `output_config.format`
 * (`json_object` and `json_schema`) into a strict JSON output system instruction so clients like
 * OpenWebUI, LangChain, Cherry Studio, and OpenAI SDK `.parse()` work cleanly instead of failing 400.
 * Still throws `400 unsupported_parameter` for genuinely unknown/unsupported format types.
 */
export function buildStructuredOutputBridgePrompt(
  fmt: unknown,
  paramName: "response_format" | "text.format" | "output_config.format",
): string | null {
  if (!isRecord(fmt) || fmt.type === undefined || fmt.type === "text") return null;
  const kind = typeof fmt.type === "string" ? fmt.type : typeof fmt.type;
  if (kind === "json_object") {
    return [
      "## Structured JSON Output Requirement",
      "Respond with ONLY a single valid JSON object. Do not wrap the response in markdown code fences (```json) and do not include any text before or after the JSON object.",
    ].join("\n");
  }
  if (kind === "json_schema") {
    const nested = isRecord(fmt.json_schema) ? fmt.json_schema : fmt;
    const schemaName = typeof nested.name === "string" && nested.name.trim() ? nested.name.trim() : undefined;
    const schemaObj = isRecord(nested.schema) ? nested.schema : undefined;
    let schemaStr = "";
    if (schemaObj) {
      try {
        const raw = JSON.stringify(schemaObj);
        schemaStr = raw.length > 16_000 ? `${raw.slice(0, 16_000)}...` : raw;
      } catch {
        schemaStr = "";
      }
    }
    return [
      `## Structured JSON Schema Output Requirement${schemaName ? ` (${schemaName})` : ""}`,
      "Respond with ONLY a single valid raw JSON value strictly conforming to the required JSON Schema. Do not wrap the response in markdown code fences (```json) and do not include any prose before or after the JSON.",
      ...(schemaStr ? [`JSON Schema:\n${schemaStr}`] : []),
    ].join("\n");
  }
  throw new GatewayError(
    `\`${paramName}\` of type '${kind}' is not supported. Supported types are 'text', 'json_object', and 'json_schema'.`,
    400,
    "unsupported_parameter",
    paramName,
  );
}

export function parseDataUrlOrRemoteImage(rawUrl: string): NormalizedImage | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const dataMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(trimmed);
  if (dataMatch) {
    return {
      mimeType: dataMatch[1].toLowerCase(),
      data: dataMatch[2].replace(/\s+/g, "")
    };
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new GatewayError(
      "Image URL must be a base64 data URL or an http(s) URL.",
      400,
      "invalid_request_error",
      "image_url"
    );
  }
  return { url: trimmed };
}

/**
 * Unified contract implemented by every LLM protocol adapter (OpenAI Chat, OpenAI Responses, Anthropic Messages).
 * Eliminates route boilerplate and double-parsing in `server.ts`.
 */
export interface ProtocolAdapter {
  readonly errorFormat: "openai" | "anthropic";
  parse(body: unknown, headers: Record<string, string | string[] | undefined>, signal?: AbortSignal): ParsedProtocolTurn;
  collectJson(events: AsyncIterable<GatewayStreamEvent>, turn: ParsedProtocolTurn): Promise<Record<string, unknown>>;
  streamSse(events: AsyncIterable<GatewayStreamEvent>, turn: ParsedProtocolTurn): AsyncGenerator<string, void, unknown>;
  formatSseErrorFrame(err: GatewayError): string;
}

/** Maps internal error codes onto the `type` vocabulary of the official OpenAI / Anthropic APIs (the precise code stays in `code`). */
export function officialErrorType(err: { status: number; code: string }, flavor: "openai" | "anthropic"): string {
  const s = err.status;
  if (s === 400 || s === 405 || s === 415 || s === 422) return "invalid_request_error";
  if (s === 401) return "authentication_error";
  if (s === 403) return "permission_error";
  if (s === 404) return flavor === "anthropic" ? "not_found_error" : "invalid_request_error";
  if (s === 413) return flavor === "anthropic" ? "request_too_large" : "invalid_request_error";
  if (s === 429) return "rate_limit_error";
  if (s === 529 || err.code === "overloaded") return flavor === "anthropic" ? "overloaded_error" : "server_error";
  return flavor === "anthropic" ? "api_error" : "server_error";
}

export function requireModelField(body: Record<string, unknown>): string {
  if (typeof body.model !== "string" || !body.model.trim()) {
    throw new GatewayError("`model` is required.", 400, "invalid_request_error", "model");
  }
  return body.model.trim();
}
