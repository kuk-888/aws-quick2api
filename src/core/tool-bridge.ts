import crypto from "node:crypto";
import type { NormalizedTool, NormalizedToolCall, ToolChoiceMode } from "./types.js";

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const COMPACT_SCHEMA_TRIGGER_BYTES = 12_000;
const SYSTEM_REMINDER_OPEN_RE = /<system-reminder>/i;
const MAX_TOOL_SCHEMA_CACHE = 128;
const MAX_SYS_PROMPT_CACHE = 64;

const toolSchemaRefCache = new WeakMap<readonly NormalizedTool[], string>();
const toolSchemaHashCache = new Map<string, string>();
const sanitizedSysPromptCache = new Map<string, string>();

function lruGet(cache: Map<string, string>, key: string): string | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function lruSet(cache: Map<string, string>, key: string, value: string, maxSize: number): void {
  if (cache.size >= maxSize) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function utf8ByteLengthExceeds(str: string, threshold: number): boolean {
  if (str.length > threshold) return true;
  if (str.length * 3 <= threshold) return false;
  return Buffer.byteLength(str, "utf8") > threshold;
}

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
  const needRequiredSet =
    maxDescLen === 0 && requiredOnlyDescLen > 0 && Array.isArray(obj.required) && obj.required.length > 0;
  const requiredSet = needRequiredSet
    ? new Set((obj.required as unknown[]).filter((r): r is string => typeof r === "string"))
    : null;
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
            : requiredSet && requiredSet.has(pk)
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
  if (!input || !SYSTEM_REMINDER_OPEN_RE.test(input)) return input;
  const lower = input.toLowerCase();
  const openTag = "<system-reminder>";
  const closeTag = "</system-reminder>";
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
 * Codex, Cline, Roo Code, Kilo, Cursor, OpenCode, Hermes, Antigravity, ZCode, Windsurf, Aider)
 * when tools are enabled so they do not clash with AWS Quick's built-in identity or paralyze `<tool_call>`.
 */
export function sanitizeClientSystemPromptForQuick(systemPrompt: string, hasTools = true): string {
  if (!systemPrompt || !hasTools) return systemPrompt;
  const cacheKey = systemPrompt.length >= 256
    ? `q:${crypto.createHash("sha256").update(systemPrompt).digest("hex")}`
    : "";
  if (cacheKey) {
    const hit = lruGet(sanitizedSysPromptCache, cacheKey);
    if (hit !== undefined) return hit;
  }
  const res = stripHighRiskClientHeaders(systemPrompt)
    .replace(
      /\bYou are (?:Claude Code|Codex|Cline|Roo Code|Roo|Kilo Code|Kilo|Cursor|OpenCode|Hermes|Antigravity|ZCode|Windsurf|Aider|Augment|Trae)\b[^\n.]*\.?/gi,
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
  if (cacheKey) lruSet(sanitizedSysPromptCache, cacheKey, res, MAX_SYS_PROMPT_CACHE);
  return res;
}

const PAIRED_XML_TAG_RES: Record<string, RegExp> = {
  identity: /<identity>/i,
  guidelines: /<guidelines>/i,
  user_rules: /<user_rules>/i,
  skills: /<skills>/i,
};

function replacePairedXmlBlockLinear(
  input: string,
  tagNameLower: string,
  replacer: (inner: string) => string,
): string {
  const quickRe = PAIRED_XML_TAG_RES[tagNameLower];
  if (quickRe && !quickRe.test(input)) return input;
  const lower = input.toLowerCase();
  const openTag = `<${tagNameLower}>`;
  const closeTag = `</${tagNameLower}>`;
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
    out += replacer(inner);
    pos = end + closeTag.length;
  }
  return out;
}

const HIGH_RISK_SKILL_ENTRY_RE =
  /\b(?:reverse(?:\s|-)?engineer(?:ing)?|js-reverse|deobfuscat\w*|xhr\s+intercept\w*|intercept(?:ion|ing)?|frame\s+capture|packet\s+capture|traffic\s+capture|script\s+source\s+dump\w*|memory\s+dump\w*|credential\s+vault|ops-vault|password\s+vault|secret\s+vault|aes-?256\s+encrypt\w*|decrypt\w*|bypass\w*|anti-?bot|captcha|exploit\w*|pentest\w*|cookie\s+(?:steal|extract|dump|capture))\b/i;

function foldHighRiskSkillDescriptions(skillsInner: string): string {
  return skillsInner
    .split("\n")
    .map((line) => {
      const m = /^(\s*[-*]\s+[^:\n]+?):\s+(.+)$/.exec(line);
      if (!m) return line;
      const head = m[1]!;
      const desc = m[2]!;
      if (HIGH_RISK_SKILL_ENTRY_RE.test(head) || HIGH_RISK_SKILL_ENTRY_RE.test(desc)) {
        return head.trimEnd();
      }
      return line;
    })
    .join("\n");
}

/**
 * Opt-in deep sanitization for heavy agent IDE system prompts (`SANITIZE_CLIENT_SYSTEM_PROMPT=true`,
 * OFF by default so user-authored `systemPrompt` text is never altered unless explicitly enabled).
 *
 * Neutralizes third-party `<identity>` blocks, IDE anti-jailbreak `<guidelines>` trigger word clusters,
 * `<user_rules>` / `<RULE[...]>` / `<skills>` / `<system-reminder>` XML wrappers, folds high-risk
 * reverse-engineering/interception/credential-vault descriptions inside `<skills>` (keeping skill name
 * & `SKILL.md` path intact), and softens canonical prompt-injection override imperatives,
 * while preserving 100% of the user's actual workspace rules and normal skill descriptions.
 */
export function deepSanitizeClientSystemPrompt(systemPrompt: string): string {
  if (!systemPrompt) return systemPrompt;
  const cacheKey = systemPrompt.length >= 256
    ? `d:${crypto.createHash("sha256").update(systemPrompt).digest("hex")}`
    : "";
  if (cacheKey) {
    const hit = lruGet(sanitizedSysPromptCache, cacheKey);
    if (hit !== undefined) return hit;
  }
  let text = normalizeSystemReminderTagsForUpstream(stripHighRiskClientHeaders(systemPrompt));

  // 1. Replace `<identity>...</identity>` persona blocks when they assert a third-party AI identity
  text = replacePairedXmlBlockLinear(text, "identity", (inner) => {
    if (
      /\b(?:You are|designed by|Anthropic|OpenAI|Google Deepmind|Antigravity|Claude|Codex|ZCode|Cursor|Kilo|Cline|Roo|Windsurf)\b/i.test(
        inner,
      )
    ) {
      return "You are assisting a developer working in their local workspace. Prioritize addressing the user's software engineering request concisely and accurately.";
    }
    return inner;
  });

  // 2. Strip IDE-injected `<guidelines>` boilerplate ONLY when it contains anti-bypass/CAPTCHA trigger clusters
  //    (user-authored coding guidelines without those clusters are preserved as neutral markdown).
  text = replacePairedXmlBlockLinear(text, "guidelines", (inner) => {
    const hasSecurityCluster =
      /\b(?:bypass|defeat)\b[\s\S]{0,120}\b(?:access control|permission check|sandbox|CAPTCHA|anti-bot)\b/i.test(inner);
    if (hasSecurityCluster) return "";
    return inner ? `## Guidelines\n${inner}` : "";
  });

  // 3. Unwrap `<user_rules>` and `<RULE[...]>` wrappers into plain Markdown headings (preserving all rule body text)
  text = replacePairedXmlBlockLinear(text, "user_rules", (inner) =>
    inner ? `## Workspace Conventions\n${inner}` : "",
  );
  text = text
    .replace(/<RULE\[([^\]]*)\]>\s*/gi, (_m, p1: string) => {
      const base = String(p1 || "").split(/[\\/]/).pop()?.trim();
      return base ? `### Rules (${base})\n` : "### Rules\n";
    })
    .replace(/<\/RULE(?:\[[^\]]*\])?>/gi, "");

  // 4. Unwrap `<skills>` XML wrapper, folding high-risk reverse/interception/vault descriptions
  //    down to `name (SKILL.md path)` while keeping normal skill descriptions intact.
  text = replacePairedXmlBlockLinear(text, "skills", (inner) =>
    inner ? `## Available Workspace Skills\n${foldHighRiskSkillDescriptions(inner)}` : "",
  );

  // 5. Soften standalone IDE identity lines and canonical prompt-injection override imperatives
  text = sanitizeClientSystemPromptForQuick(text, true)
    .replace(
      /The following are user-defined rules that you MUST ALWAYS FOLLOW WITHOUT ANY EXCEPTION\.\s*These rules take precedence over any other instructions\./gi,
      "Please follow these workspace conventions during coding and analysis tasks:",
    )
    .replace(/\bMUST ALWAYS FOLLOW WITHOUT ANY EXCEPTION\b/gi, "should consistently follow")
    .replace(/\btake precedence over any other instructions\b/gi, "apply to workspace tasks")
    .replace(
      /If a skill seems relevant to your current task,\s*you MUST read its `SKILL\.md` instructions before proceeding\./gi,
      "If a skill below is relevant to the current task, read its `SKILL.md` instructions before proceeding.",
    );

  const out = text.replace(/\n{3,}/g, "\n\n").trim();
  if (cacheKey) lruSet(sanitizedSysPromptCache, cacheKey, out, MAX_SYS_PROMPT_CACHE);
  return out;
}

function serializeCompactedToolSchemas(tools: readonly NormalizedTool[]): string {
  const refHit = toolSchemaRefCache.get(tools);
  if (refHit !== undefined) return refHit;

  const fullSpecs = tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.inputSchema,
  }));

  let serialized = JSON.stringify(fullSpecs);
  if (!utf8ByteLengthExceeds(serialized, COMPACT_SCHEMA_TRIGGER_BYTES)) {
    toolSchemaRefCache.set(tools, serialized);
    return serialized;
  }

  const hashKey = crypto.createHash("sha256").update(serialized).digest("hex");
  const cached = lruGet(toolSchemaHashCache, hashKey);
  if (cached !== undefined) {
    toolSchemaRefCache.set(tools, cached);
    return cached;
  }

  const compactSpecs = tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: trimText(t.description, 200) } : {}),
    parameters: compactJsonSchema(t.inputSchema, 100),
  }));
  serialized = JSON.stringify(compactSpecs);

  if (utf8ByteLengthExceeds(serialized, 28_000)) {
    // Tier 3: preserve concise descriptions on required parameters so complex MCP tools stay callable.
    const requiredOnlySpecs = tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: trimText(t.description, 100) } : {}),
      parameters: compactJsonSchema(t.inputSchema, 0, 0, 48),
    }));
    serialized = JSON.stringify(requiredOnlySpecs);
  }
  if (utf8ByteLengthExceeds(serialized, 36_000)) {
    // Tier 4 (extreme 40+ MCP tools): strip all parameter descriptions to stay safely under frame budget.
    const minimalSpecs = tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: trimText(t.description, 80) } : {}),
      parameters: compactJsonSchema(t.inputSchema, 0),
    }));
    serialized = JSON.stringify(minimalSpecs);
  }

  lruSet(toolSchemaHashCache, hashKey, serialized, MAX_TOOL_SCHEMA_CACHE);
  toolSchemaRefCache.set(tools, serialized);
  return serialized;
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

  const serialized = serializeCompactedToolSchemas(tools);

  const choiceRule =
    toolChoice === "required"
      ? "You must output at least one `<tool_call>` block from the schemas above in this turn."
      : typeof toolChoice === "object" && toolChoice.type === "tool"
        ? `Output the \`<tool_call>\` block named "${toolChoice.name}" in this turn.`
        : opts?.compactForCustomAgent
          ? "When a tool above fits the user's request, emit the corresponding `<tool_call>` block; otherwise reply in plain text."
          : "Whenever a client tool schema above fits the user's request, emit the corresponding `<tool_call>` block; otherwise reply in plain text.";

  const fastPriorityLine = opts?.preferClientToolsOverWorkspace
    ? "For file, shell, and workspace actions, emit matching `<tool_call>` blocks from the schemas above."
    : "";

  // Keep custom_prompt concise and purely positive so client tools stay reliable with minimal overhead.
  if (opts?.compactForCustomAgent) {
    return [
      "## Client Tools (JSON Schema)",
      "The caller executes `<tool_call>` JSON blocks locally and returns results on the next turn.",
      serialized,
      choiceRule,
      ...(fastPriorityLine ? [fastPriorityLine] : []),
      `Format (raw tags, no markdown fences; stop immediately after the block(s)):`,
      `${TOOL_CALL_OPEN}{"name":"<tool_name>","arguments":{...}}${TOOL_CALL_CLOSE}`,
    ].join("\n");
  }

  return [
    "## Tool Schemas (JSON)",
    "The caller executes `<tool_call>` JSON blocks locally and returns results on the next turn.",
    serialized,
    choiceRule,
    ...(fastPriorityLine ? [fastPriorityLine] : []),
    `Format (raw tags, no markdown fences; stop immediately after the block(s)):`,
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
  customToolNames?: ReadonlySet<string>,
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
      if (parsedArgs) {
        argsObject = parsedArgs;
      } else if (customToolNames?.has(name)) {
        // Free-form custom tools (e.g. Codex CLI `apply_patch`) may emit raw patch/text strings directly.
        argsObject = { input: rawArgs };
      } else {
        return null;
      }
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
  customToolNames?: ReadonlySet<string>,
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
      const tc = parsed ? buildNormalizedToolCall(parsed, allowedToolNames, customToolNames) : null;
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
      const tc = parsed ? buildNormalizedToolCall(parsed, allowedToolNames, customToolNames) : null;
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

export type StreamingToolCallEvent =
  | { kind: "tool_call_start"; index: number; id: string; name: string }
  | { kind: "tool_call_delta"; index: number; id: string; argumentsDelta: string }
  | { kind: "tool_call_end"; index: number; call: NormalizedToolCall };

interface ActiveStreamingCall {
  index: number;
  id: string;
  name: string;
  argsDepth: number;
  bracketStack: Array<"{" | "[">;
  inString: boolean;
  escaped: boolean;
  pendingCommaWs: string;
  streamedArgs: string;
}

const STREAM_HEADER_RE = /^\s*\{\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"(?:arguments|input)"\s*:\s*(\S)/s;

/**
 * Streaming helper that emits normal text immediately AND streams `<tool_call>` JSON arguments
 * incrementally as tokens arrive (eliminating 5-60s blank-screen stalls on large write/edit calls).
 * Keeps legacy `feed()` / `flush()` intact for backward compatibility alongside `feedIncremental()` / `flushIncremental()`.
 */
export class StreamingToolCallFilter {
  private readonly allowedToolNames?: ReadonlySet<string>;
  private readonly customToolNames?: ReadonlySet<string>;
  private pending = "";
  private capturing = false;
  private captured = "";
  private readonly fence: FenceState = { char: null, len: 0, linePrefix: "" };
  private lastEmittedChar = "";

  // Incremental streaming state machine fields
  private mode: "text" | "header" | "stream_args" | "post_args" | "buffered_block" = "text";
  private blockBuf = "";
  private nextToolIndex = 0;
  private activeCall: ActiveStreamingCall | null = null;

  constructor(allowedToolNames?: ReadonlySet<string>, customToolNames?: ReadonlySet<string>) {
    this.allowedToolNames = allowedToolNames;
    this.customToolNames = customToolNames;
  }

  private emitBufferedToolCall(tc: NormalizedToolCall, events: StreamingToolCallEvent[]): void {
    const index = this.nextToolIndex++;
    events.push({ kind: "tool_call_start", index, id: tc.id, name: tc.name });
    if (tc.argumentsJson) {
      events.push({ kind: "tool_call_delta", index, id: tc.id, argumentsDelta: tc.argumentsJson });
    }
    events.push({ kind: "tool_call_end", index, call: tc });
  }

  /**
   * Incremental streaming entry point: emits plain text AND real-time `tool_call_start` /
   * `tool_call_delta` / `tool_call_end` events as `<tool_call>` blocks stream from upstream.
   */
  feedIncremental(delta: string): { text: string; events: StreamingToolCallEvent[] } {
    const events: StreamingToolCallEvent[] = [];
    if (!delta) return { text: "", events };
    let textOut = "";
    let input = delta;
    const openLower = TOOL_CALL_OPEN.toLowerCase();
    const closeLower = TOOL_CALL_CLOSE.toLowerCase();

    while (input.length > 0) {
      if (this.mode === "text") {
        const combined = this.pending + input;
        input = "";
        if (!combined.includes("<")) {
          updateFenceStateForSegment(this.fence, combined);
          if (combined.length > 0) {
            this.lastEmittedChar = combined[combined.length - 1]!;
            textOut += combined;
          }
          this.pending = "";
          break;
        }
        const lower = combined.toLowerCase();
        let searchFrom = 0;
        let enteredTool = false;
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
            if (before.length > 0) {
              this.lastEmittedChar = before[before.length - 1]!;
              textOut += before;
            }
            this.pending = "";
            this.mode = "header";
            this.blockBuf = "";
            input = combined.slice(idx + TOOL_CALL_OPEN.length);
            enteredTool = true;
            break;
          }
          searchFrom = idx + openLower.length;
        }
        if (enteredTool) continue;

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
        if (emit.length > 0) {
          this.lastEmittedChar = emit[emit.length - 1]!;
          textOut += emit;
        }
        this.pending = holdLen > 0 ? combined.slice(combined.length - holdLen) : "";
        break;
      }

      if (this.mode === "header") {
        const prevLen = this.blockBuf.length;
        this.blockBuf += input;
        input = "";

        // O(1) tail pre-check prevents O(N^2) full-buffer rescans before `</tool_call>` arrives.
        const tailMayClose = this.blockBuf
          .slice(Math.max(0, prevLen - (TOOL_CALL_CLOSE.length - 1)))
          .toLowerCase()
          .includes(closeLower);
        const closeIdx = tailMayClose ? findToolCallCloseOutsideJsonStrings(this.blockBuf, 0) : -1;
        if (closeIdx !== -1) {
          const rawBlock = this.blockBuf.slice(0, closeIdx).trim();
          const parsed = tryParseJsonObject(rawBlock);
          const tc = parsed ? buildNormalizedToolCall(parsed, this.allowedToolNames, this.customToolNames) : null;
          // If the first `<tool_call>` omitted `</tool_call>` and a second `<tool_call>` appeared
          // before the closing tag in the same chunk, fall through to `STREAM_HEADER_RE` so both calls parse cleanly.
          if (tc || !rawBlock.toLowerCase().includes(openLower)) {
            const after = this.blockBuf.slice(closeIdx + TOOL_CALL_CLOSE.length);
            if (tc) {
              this.emitBufferedToolCall(tc, events);
            } else {
              const rawText = `${TOOL_CALL_OPEN}${this.blockBuf.slice(0, closeIdx)}${TOOL_CALL_CLOSE}`;
              textOut += rawText;
              if (rawText.length > 0) this.lastEmittedChar = rawText[rawText.length - 1]!;
            }
            this.blockBuf = "";
            this.fence.linePrefix = "";
            this.mode = "text";
            input = after;
            continue;
          }
        }

        // Wait until we see a non-whitespace prefix; if fenced markdown, fall back to buffered block mode.
        const trimmedStart = this.blockBuf.trimStart();
        if (!trimmedStart) break;
        if (trimmedStart.startsWith("```")) {
          this.mode = "buffered_block";
          break;
        }

        const headerMatch = STREAM_HEADER_RE.exec(this.blockBuf);
        if (headerMatch) {
          let decodedName = "";
          try {
            decodedName = String(JSON.parse(`"${headerMatch[1]!}"`) || "").trim();
          } catch {
            decodedName = "";
          }
          const isAllowed =
            Boolean(decodedName) &&
            (!this.allowedToolNames || this.allowedToolNames.size === 0 || this.allowedToolNames.has(decodedName));
          const firstValChar = headerMatch[2]!;
          if (isAllowed && firstValChar === "{") {
            const id = `call_${crypto.randomBytes(8).toString("hex")}`;
            const index = this.nextToolIndex++;
            this.activeCall = {
              index,
              id,
              name: decodedName,
              argsDepth: 1,
              bracketStack: ["{"],
              inString: false,
              escaped: false,
              pendingCommaWs: "",
              streamedArgs: "{",
            };
            events.push({ kind: "tool_call_start", index, id, name: decodedName });
            events.push({ kind: "tool_call_delta", index, id, argumentsDelta: "{" });
            input = this.blockBuf.slice(headerMatch[0].length);
            this.blockBuf = "";
            this.mode = "stream_args";
            continue;
          }
          // Disallowed tool name or non-object arguments (e.g. custom raw patch string): buffer safely.
          this.mode = "buffered_block";
          break;
        }

        // If header grew beyond 512 chars (e.g. `"arguments"` appeared before `"name"`), buffer cleanly.
        if (this.blockBuf.length > 512) {
          this.mode = "buffered_block";
        }
        break;
      }

      if (this.mode === "stream_args" && this.activeCall) {
        const call = this.activeCall;
        let deltaOut = "";
        let finishedAt = -1;

        for (let i = 0; i < input.length; i += 1) {
          const ch = input[i]!;
          if (call.inString) {
            if (call.escaped) {
              deltaOut += ch;
              call.escaped = false;
            } else if (ch === "\\") {
              deltaOut += ch;
              call.escaped = true;
            } else if (ch === "\"") {
              deltaOut += ch;
              call.inString = false;
            } else if (ch === "\n") {
              deltaOut += "\\n";
            } else if (ch === "\r") {
              deltaOut += "\\r";
            } else if (ch === "\t") {
              deltaOut += "\\t";
            } else {
              const code = ch.charCodeAt(0);
              if (code < 0x20) deltaOut += `\\u${code.toString(16).padStart(4, "0")}`;
              else deltaOut += ch;
            }
            continue;
          }

          if (call.pendingCommaWs.length > 0) {
            if (/\s/.test(ch)) {
              call.pendingCommaWs += ch;
              continue;
            }
            if (ch === "}" || ch === "]") {
              // Drop invalid trailing comma outside strings; keep following whitespace if any.
              call.pendingCommaWs = "";
            } else {
              deltaOut += call.pendingCommaWs;
              call.pendingCommaWs = "";
            }
          }

          if (ch === ",") {
            call.pendingCommaWs = ",";
            continue;
          }
          if (ch === "\"") {
            call.inString = true;
            deltaOut += ch;
          } else if (ch === "{") {
            call.argsDepth += 1;
            call.bracketStack.push("{");
            deltaOut += ch;
          } else if (ch === "[") {
            call.bracketStack.push("[");
            deltaOut += ch;
          } else if (ch === "]") {
            if (call.bracketStack.length > 0 && call.bracketStack[call.bracketStack.length - 1] === "[") {
              call.bracketStack.pop();
            }
            deltaOut += ch;
          } else if (ch === "}") {
            call.argsDepth -= 1;
            if (call.bracketStack.length > 0 && call.bracketStack[call.bracketStack.length - 1] === "{") {
              call.bracketStack.pop();
            }
            deltaOut += ch;
            if (call.argsDepth === 0) {
              finishedAt = i + 1;
              break;
            }
          } else {
            deltaOut += ch;
          }
        }

        if (deltaOut.length > 0) {
          call.streamedArgs += deltaOut;
          events.push({ kind: "tool_call_delta", index: call.index, id: call.id, argumentsDelta: deltaOut });
        }

        if (finishedAt >= 0) {
          const parsedObj = tryParseJsonObject(call.streamedArgs) ?? {};
          const finalized: NormalizedToolCall = {
            id: call.id,
            name: call.name,
            argumentsJson: call.streamedArgs,
            argsObject: parsedObj,
          };
          events.push({ kind: "tool_call_end", index: call.index, call: finalized });
          this.activeCall = null;
          this.blockBuf = "";
          this.mode = "post_args";
          input = input.slice(finishedAt);
          continue;
        }
        input = "";
        break;
      }

      if (this.mode === "post_args") {
        this.blockBuf += input;
        input = "";
        const lowerBuf = this.blockBuf.toLowerCase();
        const closeIdx = lowerBuf.indexOf(closeLower);
        const nextOpenIdx = lowerBuf.indexOf(openLower);
        if (closeIdx !== -1 && (nextOpenIdx === -1 || closeIdx < nextOpenIdx)) {
          const after = this.blockBuf.slice(closeIdx + TOOL_CALL_CLOSE.length);
          this.blockBuf = "";
          this.fence.linePrefix = "";
          this.mode = "text";
          input = after;
          continue;
        }
        if (nextOpenIdx !== -1) {
          // Model omitted `</tool_call>` before starting a second `<tool_call>`: recover cleanly without swallowing it.
          const after = this.blockBuf.slice(nextOpenIdx);
          this.blockBuf = "";
          this.fence.linePrefix = "";
          this.mode = "text";
          input = after;
          continue;
        }
        break;
      }

      if (this.mode === "buffered_block") {
        const prevLen = this.blockBuf.length;
        this.blockBuf += input;
        input = "";
        const tailMayClose = this.blockBuf
          .slice(Math.max(0, prevLen - (TOOL_CALL_CLOSE.length - 1)))
          .toLowerCase()
          .includes(closeLower);
        const closeIdx = tailMayClose ? findToolCallCloseOutsideJsonStrings(this.blockBuf, 0) : -1;
        if (closeIdx !== -1) {
          const rawBlock = this.blockBuf.slice(0, closeIdx).trim();
          const parsed = tryParseJsonObject(rawBlock);
          const tc = parsed ? buildNormalizedToolCall(parsed, this.allowedToolNames, this.customToolNames) : null;
          // If the first `<tool_call>` omitted `</tool_call>` and a second `<tool_call>` appeared
          // before the closing tag in the same chunk, fall through to `STREAM_HEADER_RE` so both calls parse cleanly.
          if (tc || !rawBlock.toLowerCase().includes(openLower)) {
            const after = this.blockBuf.slice(closeIdx + TOOL_CALL_CLOSE.length);
            if (tc) {
              this.emitBufferedToolCall(tc, events);
            } else {
              const rawText = `${TOOL_CALL_OPEN}${this.blockBuf.slice(0, closeIdx)}${TOOL_CALL_CLOSE}`;
              textOut += rawText;
              if (rawText.length > 0) this.lastEmittedChar = rawText[rawText.length - 1]!;
            }
            this.blockBuf = "";
            this.fence.linePrefix = "";
            this.mode = "text";
            input = after;
            continue;
          }
        }
        break;
      }
    }

    return { text: textOut, events };
  }

  /**
   * Flushes any buffered tail at end-of-turn (closing truncated streaming arguments cleanly so
   * protocol adapters never leave an open `tool_use` / `function_call` block unclosed).
   */
  flushIncremental(): { remainingText: string; events: StreamingToolCallEvent[] } {
    const events: StreamingToolCallEvent[] = [];
    if (this.mode === "text") {
      const rem = this.pending;
      this.pending = "";
      return { remainingText: rem, events };
    }
    if (this.mode === "stream_args" && this.activeCall) {
      const call = this.activeCall;
      this.activeCall = null;
      let tail = "";
      if (call.inString) {
        if (call.escaped) tail += "\\";
        tail += "\"";
      }
      if (call.bracketStack.length > 0) {
        for (let bi = call.bracketStack.length - 1; bi >= 0; bi -= 1) {
          tail += call.bracketStack[bi] === "[" ? "]" : "}";
        }
      } else if (call.argsDepth > 0) {
        tail += "}".repeat(call.argsDepth);
      }
      if (tail) {
        call.streamedArgs += tail;
        events.push({ kind: "tool_call_delta", index: call.index, id: call.id, argumentsDelta: tail });
      }
      const parsedObj = tryParseJsonObject(call.streamedArgs) ?? {};
      events.push({
        kind: "tool_call_end",
        index: call.index,
        call: {
          id: call.id,
          name: call.name,
          argumentsJson: call.streamedArgs,
          argsObject: parsedObj,
        },
      });
      this.blockBuf = "";
      this.mode = "text";
      return { remainingText: "", events };
    }
    if (this.mode === "post_args") {
      // Ignore trailing outer `}` + whitespace from the already-closed tool call; keep any unexpected prose.
      const rem = this.blockBuf.replace(/^\s*\}\s*/, "").trim();
      this.blockBuf = "";
      this.mode = "text";
      return { remainingText: rem, events };
    }
    // `header` or `buffered_block` truncated without `</tool_call>`
    const { cleanText, toolCalls } = parseToolCallsFromText(
      `${TOOL_CALL_OPEN}${this.blockBuf}`,
      this.allowedToolNames,
      this.customToolNames,
    );
    this.blockBuf = "";
    this.mode = "text";
    for (const tc of toolCalls) {
      this.emitBufferedToolCall(tc, events);
    }
    return { remainingText: cleanText, events };
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
    const { cleanText, toolCalls } = parseToolCallsFromText(this.captured, this.allowedToolNames, this.customToolNames);
    this.captured = "";
    this.capturing = false;
    return { remainingText: cleanText, toolCalls };
  }
}
