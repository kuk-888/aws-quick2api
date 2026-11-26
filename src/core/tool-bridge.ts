import crypto from "node:crypto";
import type { NormalizedTool, NormalizedToolCall, ToolChoiceMode } from "./types.js";

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const COMPACT_SCHEMA_TRIGGER_BYTES = 12_000;

function trimText(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function compactJsonSchema(
  node: unknown,
  maxDescLen: number,
  depth = 0,
  requiredOnlyDescLen = 0,
): unknown {
  if (depth > 8 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((item) => compactJsonSchema(item, maxDescLen, depth + 1, requiredOnlyDescLen));
  }
  const obj = node as Record<string, unknown>;
  const requiredSet = new Set(
    Array.isArray(obj.required) ? obj.required.filter((r): r is string => typeof r === "string") : [],
  );
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$schema" || k === "$id" || k === "title" || k === "examples" || k === "default") continue;
    if (k === "description" && typeof v === "string") {
      if (maxDescLen > 0) out[k] = trimText(v, maxDescLen);
      continue;
    }
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        const childDescLen =
          maxDescLen > 0
            ? maxDescLen
            : requiredOnlyDescLen > 0 && requiredSet.has(pk)
              ? requiredOnlyDescLen
              : 0;
        props[pk] = compactJsonSchema(pv, childDescLen, depth + 1, requiredOnlyDescLen);
      }
      out[k] = props;
      continue;
    }
    out[k] = compactJsonSchema(v, maxDescLen, depth + 1, requiredOnlyDescLen);
  }
  return out;
}

/**
 * Unconditionally strip forged/internal client billing headers (e.g. `x-anthropic-billing-header`)
 * that third-party CLI tools embed into system prompts and that trigger upstream prompt-injection alarms.
 */
export function stripHighRiskClientHeaders(text: string): string {
  if (!text) return text;
  if (!/x-anthropic-billing-header/i.test(text)) return text;
  return text
    .replace(/^x-anthropic-billing-header[^\n]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Linearly convert `<system-reminder>...</system-reminder>` blocks in outbound prompt text into
 * neutral `[Context note: ...]` wrappers so AWS Quick's safety layer does not misclassify them
 * as system-tag spoofing / indirect prompt injection. Only applied to outbound wire text
 * (never alters conversation prefix hashes).
 */
export function normalizeSystemReminderTagsForUpstream(input: string): string {
  if (!input) return input;
  const lower = input.toLowerCase();
  const openTag = "<system-reminder>";
  const closeTag = "</system-reminder>";
  if (!lower.includes(openTag)) return input;
  let out = "";
  let pos = 0;
  while (pos < input.length) {
    const start = lower.indexOf(openTag, pos);
    if (start < 0) {
      out += input.slice(pos);
      break;
    }
    out += input.slice(pos, start);
    const end = lower.indexOf(closeTag, start + openTag.length);
    if (end < 0) {
      out += input.slice(start);
      break;
    }
    const inner = input.slice(start + openTag.length, end).trim();
    if (inner) {
      out += `[Context note]\n${inner}\n[/Context note]`;
    }
    pos = end + closeTag.length;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Soften direct identity-override phrases from third-party CLI/IDE agents (e.g. Claude Code,
 * Codex, Cline, Roo Code, Kilo, Cursor, OpenCode, Hermes) when tools are enabled so they do not
 * clash with AWS Quick's built-in identity or trigger false-positive prompt-injection refusals.
 */
export function sanitizeClientSystemPromptForQuick(systemPrompt: string, hasTools = true): string {
  if (!systemPrompt || !hasTools) return systemPrompt;
  return stripHighRiskClientHeaders(systemPrompt)
    .replace(
      /\bYou are (?:Claude Code|Codex|Cline|Roo Code|Roo|Kilo Code|Kilo|Cursor|OpenCode|Hermes)\b[^\n.]*\.?/gi,
      "You are assisting a developer through an external coding client.",
    )
    .replace(
      /\bYou are Claude,\s+Anthropic's[^\n.]*\.?/gi,
      "You are assisting a developer through an external coding client.",
    )
    .replace(
      /\bYou are an interactive CLI tool\b/gi,
      "You are assisting a developer using an interactive CLI client",
    )
    .replace(
      /\bYou are a coding agent running in[^\n.]*\.?/gi,
      "You are assisting a developer working in a local coding environment.",
    );
}

/**
 * Build a compact, unambiguous instruction block for client-defined tools.
 * Kept inside AWS Quick's native `custom_prompt` when `turn.tools.length > 0`.
 */
export function buildToolBridgePrompt(
  tools: readonly NormalizedTool[],
  toolChoice: ToolChoiceMode,
  opts?: { compactForCustomAgent?: boolean; preferClientToolsOverWorkspace?: boolean },
): string {
  if (!tools.length || toolChoice === "none") return "";

  const fullSpecs = tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.inputSchema,
  }));

  let serialized = JSON.stringify(fullSpecs);
  if (Buffer.byteLength(serialized, "utf8") > COMPACT_SCHEMA_TRIGGER_BYTES) {
    const compactSpecs = tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: trimText(t.description, 200) } : {}),
      parameters: compactJsonSchema(t.inputSchema, 100),
    }));
    serialized = JSON.stringify(compactSpecs);
  }
  if (Buffer.byteLength(serialized, "utf8") > 28_000) {
    // Tier 3: preserve concise descriptions on required parameters so complex MCP tools stay callable.
    const requiredOnlySpecs = tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: trimText(t.description, 100) } : {}),
      parameters: compactJsonSchema(t.inputSchema, 0, 0, 48),
    }));
    serialized = JSON.stringify(requiredOnlySpecs);
  }
  if (Buffer.byteLength(serialized, "utf8") > 36_000) {
    // Tier 4 (extreme 40+ MCP tools): strip all parameter descriptions to stay safely under frame budget.
    const minimalSpecs = tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: trimText(t.description, 80) } : {}),
      parameters: compactJsonSchema(t.inputSchema, 0),
    }));
    serialized = JSON.stringify(minimalSpecs);
  }

  const choiceRule =
    toolChoice === "required"
      ? "You must output at least one `<tool_call>` block from the schemas above in this turn."
      : typeof toolChoice === "object" && toolChoice.type === "tool"
        ? `Output the \`<tool_call>\` block named "${toolChoice.name}" in this turn.`
        : opts?.compactForCustomAgent
          ? "When a tool above fits the user's request, emit the corresponding `<tool_call>` block; otherwise reply in plain text."
          : "Whenever a client tool schema above fits the user's request, emit the corresponding `<tool_call>` block; otherwise reply in plain text.";

  const fastPriorityLine = opts?.preferClientToolsOverWorkspace
    ? "Prefer the `<tool_call>` schemas above over built-in workspace tools."
    : "";

  // When routed to a custom AWS Quick Agent whose own instructions already authorize client tool calls,
  // keep custom_prompt strictly minimal (zero anti-refusal boilerplate / prompt pollution).
  if (opts?.compactForCustomAgent) {
    return [
      "## Client Tools (JSON Schema)",
      serialized,
      choiceRule,
      ...(fastPriorityLine ? [fastPriorityLine] : []),
      `Format (raw tags, no markdown fences; stop immediately after the block(s)):`,
      `${TOOL_CALL_OPEN}{"name":"<tool_name>","arguments":{...}}${TOOL_CALL_CLOSE}`,
    ].join("\n");
  }

  return [
    "## Structured Tool Request Format",
    "The user is connected via an external API client. When a client tool below fits the user's request, emit a declarative `<tool_call>` JSON proposal; the user's local client handles review, execution, and returning the result on the next turn.",
    "Available external tool schemas (JSON):",
    serialized,
    choiceRule,
    ...(fastPriorityLine ? [fastPriorityLine] : []),
    `Output format (raw tags with no markdown code fences; stop immediately after the block(s) so the client can process them):`,
    `${TOOL_CALL_OPEN}{"name":"<tool_name>","arguments":{...}}${TOOL_CALL_CLOSE}`,
  ].join("\n");
}

function repairJsonOutsideStrings(input: string): string {
  // Single pass: (1) escape literal \n/\r/\t inside JSON strings;
  // (2) strip trailing commas before `}` or `]` strictly OUTSIDE JSON strings so user code is never mutated.
  let escapedOut = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (!inString) {
      if (ch === "\"") inString = true;
      escapedOut += ch;
      continue;
    }
    if (escaped) {
      escapedOut += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escapedOut += ch;
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = false;
      escapedOut += ch;
      continue;
    }
    if (ch === "\n") escapedOut += "\\n";
    else if (ch === "\r") escapedOut += "\\r";
    else if (ch === "\t") escapedOut += "\\t";
    else {
      const code = ch.charCodeAt(0);
      if (code < 0x20) escapedOut += `\\u${code.toString(16).padStart(4, "0")}`;
      else escapedOut += ch;
    }
  }

  // Second pass: remove trailing commas strictly outside string literals.
  let finalOut = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < escapedOut.length; i += 1) {
    const ch = escapedOut[i]!;
    if (inString) {
      finalOut += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      finalOut += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < escapedOut.length && /\s/.test(escapedOut[j]!)) j += 1;
      if (j < escapedOut.length && (escapedOut[j] === "}" || escapedOut[j] === "]")) {
        continue; // drop trailing comma outside strings
      }
    }
    finalOut += ch;
  }
  return finalOut;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!unfenced) return null;

  const tryDirect = (s: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const direct = tryDirect(unfenced);
  if (direct) return direct;

  // Repair pass: isolate outermost {...}, escape literal newlines inside strings, strip trailing commas OUTSIDE strings.
  const firstBrace = unfenced.indexOf("{");
  if (firstBrace === -1) return null;
  const lastBrace = unfenced.lastIndexOf("}");
  const sliced = lastBrace > firstBrace ? unfenced.slice(firstBrace, lastBrace + 1) : unfenced.slice(firstBrace);
  const repaired = repairJsonOutsideStrings(sliced);
  const fromRepaired = tryDirect(repaired);
  if (fromRepaired) return fromRepaired;

  // Last resort: recover 1-2 missing closing braces/brackets on truncated tail objects.
  const openStack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < repaired.length; i += 1) {
    const ch = repaired[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
    } else {
      if (ch === "\"") inStr = true;
      else if (ch === "{") openStack.push("}");
      else if (ch === "[") openStack.push("]");
      else if (ch === "}" || ch === "]") {
        if (openStack.length > 0 && openStack[openStack.length - 1] === ch) {
          openStack.pop();
        }
      }
    }
  }
  if (!inStr && openStack.length > 0 && openStack.length <= 2) {
    return tryDirect(repaired + openStack.reverse().join(""));
  }
  return null;
}

function buildNormalizedToolCall(
  parsed: Record<string, unknown>,
  allowedToolNames?: ReadonlySet<string>,
): NormalizedToolCall | null {
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) return null;
  if (allowedToolNames && allowedToolNames.size > 0 && !allowedToolNames.has(name)) {
    return null;
  }
  const rawArgs = parsed.arguments ?? parsed.input;
  let argsObject: Record<string, unknown>;
  if (rawArgs === undefined || rawArgs === null) {
    argsObject = {};
  } else if (typeof rawArgs === "string") {
    if (!rawArgs.trim()) {
      argsObject = {};
    } else {
      const parsedArgs = tryParseJsonObject(rawArgs);
      if (!parsedArgs) return null;
      argsObject = parsedArgs;
    }
  } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    argsObject = rawArgs as Record<string, unknown>;
  } else {
    return null;
  }
  return {
    id: `call_${crypto.randomBytes(8).toString("hex")}`,
    name,
    argumentsJson: JSON.stringify(argsObject),
    argsObject,
  };
}

interface FenceState {
  char: "`" | "~" | null;
  len: number;
  linePrefix: string;
}

function updateFenceStateForSegment(state: FenceState, segment: string): void {
  if (!segment) return;
  const combined = state.linePrefix + segment;
  const lines = combined.split("\n");
  state.linePrefix = lines.pop() ?? "";
  for (const line of lines) {
    applyFenceLine(state, line);
  }
}

function applyFenceLine(state: FenceState, line: string): void {
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return;
  const marker = m[1]!;
  const rest = m[2] ?? "";
  const ch = marker[0] as "`" | "~";
  if (state.char === null) {
    // Opening fence: backtick fences cannot contain backticks in info string per CommonMark
    if (ch === "`" && rest.includes("`")) return;
    state.char = ch;
    state.len = marker.length;
  } else if (state.char === ch && marker.length >= state.len && rest.trim() === "") {
    // Closing fence: same char, >= opening length, no trailing info text
    state.char = null;
    state.len = 0;
  }
}

function isInsideOpenFence(state: FenceState): boolean {
  return state.char !== null;
}

/**
 * Finds the matching `</tool_call>` closing tag starting from `contentStart`,
 * skipping any `</tool_call>` that occurs inside a JSON double-quoted string literal
 * so editing source files containing `</tool_call>` never prematurely truncates tool arguments.
 */
function findToolCallCloseOutsideJsonStrings(text: string, contentStart: number): number {
  const lower = text.toLowerCase();
  const closeLower = TOOL_CALL_CLOSE.toLowerCase();
  const closeLen = closeLower.length;
  let inString = false;
  let escaped = false;
  for (let i = contentStart; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "<" && lower.startsWith(closeLower, i)) {
      return i;
    }
  }
  // Fallback: if JSON string was unclosed/malformed, locate the last closing tag so recovery still works.
  const fallback = lower.indexOf(closeLower, contentStart);
  return fallback >= 0 && fallback + closeLen <= text.length ? fallback : -1;
}

/**
 * Parse `<tool_call>{...}</tool_call>` blocks from model output text,
 * respecting Markdown fenced code blocks, inline backticks, and JSON string literals
 * (so `</tool_call>` inside a tool argument string never truncates the call),
 * with automatic recovery for minor JSON malformations and unclosed trailing `<tool_call>` tags.
 * When `allowedToolNames` is provided, undeclared tool names (e.g. documentation examples)
 * are preserved as plain text instead of being emitted as real tool calls.
 */
export function parseToolCallsFromText(
  text: string,
  allowedToolNames?: ReadonlySet<string>,
): {
  cleanText: string;
  toolCalls: NormalizedToolCall[];
} {
  const toolCalls: NormalizedToolCall[] = [];
  const textParts: string[] = [];
  const lower = text.toLowerCase();
  const openLower = TOOL_CALL_OPEN.toLowerCase();
  const closeLen = TOOL_CALL_CLOSE.length;

  const fence: FenceState = { char: null, len: 0, linePrefix: "" };
  let cursor = 0;
  let scanFrom = 0;

  while (scanFrom < text.length) {
    const idx = lower.indexOf(openLower, scanFrom);
    if (idx === -1) break;

    updateFenceStateForSegment(fence, text.slice(scanFrom, idx));
    // Also check if the current incomplete line itself opens a fence right before `<tool_call>` (e.g. ```` ```xml<tool_call> ````)
    const inlineFenceCheck = /^\s*(`{3,}|~{3,})/.test(fence.linePrefix);
    const isInlineCode = idx > 0 && text[idx - 1] === "`";
    if (isInsideOpenFence(fence) || inlineFenceCheck || isInlineCode) {
      scanFrom = idx + openLower.length;
      continue;
    }

    const contentStart = idx + openLower.length;
    const closeIdx = findToolCallCloseOutsideJsonStrings(text, contentStart);
    if (closeIdx !== -1) {
      const rawBlock = text.slice(contentStart, closeIdx).trim();
      const parsed = tryParseJsonObject(rawBlock);
      const tc = parsed ? buildNormalizedToolCall(parsed, allowedToolNames) : null;
      textParts.push(text.slice(cursor, idx));
      const blockEnd = closeIdx + closeLen;
      if (tc) {
        toolCalls.push(tc);
      } else {
        // Unrecoverable malformed JSON or undeclared tool name: preserve raw block as text.
        textParts.push(text.slice(idx, blockEnd));
      }
      cursor = blockEnd;
      scanFrom = blockEnd;
      fence.linePrefix = "";
    } else {
      // Unclosed trailing `<tool_call>...`
      const rawTail = text.slice(contentStart);
      const parsed = tryParseJsonObject(rawTail);
      const tc = parsed ? buildNormalizedToolCall(parsed, allowedToolNames) : null;
      if (tc) {
        textParts.push(text.slice(cursor, idx));
        toolCalls.push(tc);
        cursor = text.length;
      }
      break;
    }
  }

  if (cursor < text.length) {
    textParts.push(text.slice(cursor));
  }

  return {
    cleanText: textParts.join("").trim(),
    toolCalls,
  };
}

/**
 * Streaming helper that emits normal text immediately while buffering once `<tool_call` begins.
 * Zero buffering overhead when a response never emits `<tool_call>`.
 */
export class StreamingToolCallFilter {
  private readonly allowedToolNames?: ReadonlySet<string>;
  private pending = "";
  private capturing = false;
  private captured = "";
  private readonly fence: FenceState = { char: null, len: 0, linePrefix: "" };
  private lastEmittedChar = "";

  constructor(allowedToolNames?: ReadonlySet<string>) {
    this.allowedToolNames = allowedToolNames;
  }

  feed(delta: string): string {
    if (!delta) return "";
    if (this.capturing) {
      this.captured += delta;
      return "";
    }
    const combined = this.pending + delta;
    const lower = combined.toLowerCase();
    const openLower = TOOL_CALL_OPEN.toLowerCase();

    // Scan combined while tracking Markdown code fences (``` and ~~~) and inline backticks
    // so `<tool_call>` inside documentation/code examples is never mistaken for a real tool invocation.
    let searchFrom = 0;
    while (searchFrom < combined.length) {
      const idx = lower.indexOf(openLower, searchFrom);
      if (idx === -1) break;
      const prefix = combined.slice(searchFrom, idx);
      updateFenceStateForSegment(this.fence, prefix);
      const prevChar = idx > 0 ? combined[idx - 1] : this.lastEmittedChar;
      const isInlineCode = prevChar === "`";
      const inlineFenceLine = /^\s*(`{3,}|~{3,})/.test(this.fence.linePrefix);
      if (!isInsideOpenFence(this.fence) && !inlineFenceLine && !isInlineCode) {
        const before = combined.slice(0, idx);
        if (before.length > 0) this.lastEmittedChar = before[before.length - 1]!;
        this.capturing = true;
        this.captured = combined.slice(idx);
        this.pending = "";
        return before;
      }
      searchFrom = idx + openLower.length;
    }

    // Hold back a potential partial prefix of `<tool_call>` (case-insensitive) at the tail of the chunk.
    let holdLen = 0;
    const maxCheck = Math.min(combined.length, openLower.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      if (openLower.startsWith(lower.slice(lower.length - len))) {
        holdLen = len;
        break;
      }
    }
    const emit = holdLen > 0 ? combined.slice(0, combined.length - holdLen) : combined;
    updateFenceStateForSegment(this.fence, emit.slice(searchFrom));
    if (emit.length > 0) this.lastEmittedChar = emit[emit.length - 1]!;
    this.pending = holdLen > 0 ? combined.slice(combined.length - holdLen) : "";
    return emit;
  }

  flush(): { remainingText: string; toolCalls: NormalizedToolCall[] } {
    if (!this.capturing) {
      const rem = this.pending;
      this.pending = "";
      return { remainingText: rem, toolCalls: [] };
    }
    const { cleanText, toolCalls } = parseToolCallsFromText(this.captured, this.allowedToolNames);
    this.captured = "";
    this.capturing = false;
    return { remainingText: cleanText, toolCalls };
  }
}
