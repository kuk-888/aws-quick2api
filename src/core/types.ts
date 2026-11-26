export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;
  retryAfter?: number;

  constructor(message: string, status = 500, code = "internal_error", param?: string, retryAfter?: number) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.param = param;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
      this.retryAfter = Math.ceil(retryAfter);
    }
  }
}

export type LbStrategy = "quota-aware" | "least-busy" | "round-robin";

export interface NormalizedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** OpenAI Responses API tool wire kind (defaults to `"function"`). */
  toolKind?: "function" | "custom" | "local_shell" | "shell";
  /** OpenAI Responses API namespace (used by Codex CLI for MCP / grouped tools). */
  toolNamespace?: string;
  /** Original unqualified tool name when bridged under a namespace prefix. */
  wireName?: string;
  /** Anthropic tool-search deferred tool flag (kept in whitelist, compacted in schema prompt). */
  deferLoading?: boolean;
}

export type NormalizedImage =
  | { url: string; dimension?: { width: number; height: number } }
  | { data: string; mimeType: string; dimension?: { width: number; height: number } };

export interface NormalizedFile {
  filename: string;
  mimeType: string;
  /** Base64-encoded raw bytes (without data: prefix). */
  data?: string;
  /** Remote http(s):// URL to fetch and upload out-of-band. */
  url?: string;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
  argsObject: Record<string, unknown>;
}

export interface NormalizedToolResult {
  toolCallId: string;
  name?: string;
  content: string;
  isError?: boolean;
  /** Images returned by the tool (inline base64 only; delivered to the parked SDK run). */
  images?: NormalizedImage[];
}

export type ToolChoiceMode =
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; name: string };

/**
 * Pure protocol-parsed turn representation (decoupled from upstream `apiKey` selection).
 */
export interface ParsedProtocolTurn {
  requestedModel: string;
  rawBody: Record<string, unknown>;
  /** Deterministic or header-derived conversation key for sticky session affinity. */
  conversationKey?: string;
  systemPrompt?: string;
  fullTranscriptText: string;
  priorPrefixHash?: string;
  currentInputPrefixHash?: string;
  incrementalUserText?: string;
  images: NormalizedImage[];
  incrementalImages?: NormalizedImage[];
  files?: NormalizedFile[];
  incrementalFiles?: NormalizedFile[];
  tools: NormalizedTool[];
  /** Native cloud tools requested by caller (reserved for compatibility). */
  nativeSdkTools?: Array<"webSearch" | "webFetch">;
  toolChoice: ToolChoiceMode;
  trailingToolResults: NormalizedToolResult[];
  trailingUserText?: string;
  /** Images attached to the trailing user message that follows tool results. */
  trailingImages?: NormalizedImage[];
  stream: boolean;
  includeStreamUsage?: boolean;
  hasToolResults?: boolean;
  estimatedInputTokens: number;
  signal?: AbortSignal;
  /** Client identity (sub-key id or "master"); isolates warm/parked sessions between clients. */
  scope?: string;
}

export interface TurnTokenMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Total tokens reported by AWS Quick (`total_tokens`, or sum of input/output/cache). */
  totalTokens?: number;
  /** Upstream model context window reported by AWS Quick `turn_usage` (e.g. `1000000`). */
  contextWindow?: number;
  /** Upstream context occupancy percentage (0–100, 1 decimal place). */
  contextPercent?: number;
  reasoningTokens?: number;
  /** Actual upstream model routed by AWS Quick (e.g. `us.anthropic.claude-sonnet-5-5`). */
  resolvedModel?: string;
}

export type GatewayStreamEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: NormalizedToolCall[] }
  | { type: "usage"; metrics: TurnTokenMetrics }
  | { type: "done"; stopReason: "stop" | "tool_calls" | "length" };

export interface AutoDisabledState {
  /** `quota`: ran out of quota (recovers by itself); `auth`: upstream rejected the key (needs a manual re-check). */
  kind: "quota" | "auth";
  reason: string;
  /** Epoch ms of the expected recovery (billing cycle end), when known. */
  resetAtMs?: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  /** Trust X-Forwarded-For / X-Real-IP headers: "loopback" (default), "all", or "off". */
  trustProxy?: "loopback" | "all" | "off";
  gatewayTokens: Set<string>;
  /** Dedicated admin console password. If unset the admin console is disabled (never falls back to client tokens). */
  adminPassword?: string;
  /** Mount the optional Web Console & `/v1/admin/*` management API (default `true`; set `false` for pure headless proxy). */
  enableDashboard: boolean;
  /** Custom URL path for the management console (default `/dashboard`, e.g. `/adm-7f3c9a`). */
  dashboardPath: string;
  quickTokens: string[];
  disabledQuickTokens: string[];
  /** Disabled base model IDs persisted in `.env` as `DISABLED_MODELS`. */
  disabledModels: string[];
  /** Optional `slotId:label` map persisted in `.env` as `KEY_LABELS`. */
  keyLabels: Record<string, string>;
  /** Optional per-credential HTTP/HTTPS proxy URLs keyed by slotId (`KEY_PROXIES`). */
  keyProxies: Record<string, string>;
  /** Optional global default AWS Quick custom agent ID (`CHAT_AGENT_ID`) to bypass default built-in prompt/device checks. */
  chatAgentId?: string;
  /** Automatically discover or create & bind a minimal coding agent per account (`AUTO_ENSURE_CODING_AGENT`, default true). */
  autoEnsureCodingAgent?: boolean;
  /** Optional default instructions template used when auto-creating custom agents (`CUSTOM_AGENT_PROMPT`). */
  customAgentPrompt?: string;
  /** Optional: deeply sanitize heavy IDE/agent client framework wrappers in `systemPrompt` (`SANITIZE_CLIENT_SYSTEM_PROMPT`, default false so user system prompts stay untouched unless opted in). */
  sanitizeClientSystemPrompt?: boolean;
  /** Optional: automatically rephrase the latest user prompt into defensive engineering wording on upstream `content_filtered` and retry on the SAME requested model (`AUTO_REPHRASE_ON_CONTENT_FILTER`, default false). */
  autoRephraseOnContentFilter?: boolean;
  /** Optional custom instruction template used when auto-rephrasing after `content_filtered` (`CONTENT_FILTER_REPHRASE_PROMPT`). */
  contentFilterRephrasePrompt?: string;
  /** Optional helper model used strictly for short prompt rephrasing (`CONTENT_FILTER_REPHRASE_MODEL`, default `quick-fast`). Never replaces the user's answering model. */
  contentFilterRephraseModel?: string;
  /** Optional per-credential AWS Quick custom agent IDs keyed by slotId (`KEY_CHAT_AGENT_IDS`). */
  keyChatAgentIds?: Record<string, string>;
  /** Optional per-credential import timestamps (epoch ms) keyed by slotId (`KEY_ADDED_AT`). */
  keyAddedAt?: Record<string, number>;
  /** Persisted auto-disable state per slot (`KEY_AUTO_DISABLED`), so recovery survives restarts. */
  keyAutoDisabled?: Record<string, AutoDisabledState>;
  lbStrategy: LbStrategy;
  /** Sticky session affinity so multi-turn conversations stay on the same account. */
  sessionAffinityEnabled: boolean;
  sessionAffinityTtlMs: number;
  /** Automatically disable/trip accounts that run out of quota or return 401/402. */
  autoDisableExhaustedKeys: boolean;
  /** Privacy mode: when true, enables native AWS Quick incognito mode (default true). */
  incognitoMode: boolean;
  envFilePath?: string;
  /** Directory for persistent runtime state (`gateway-keys.json`, `admin-session.key`, `usage-ledger.json`). */
  dataDir?: string;
  /** Where the overview ledger (metadata only, no conversation text) is persisted; unset = memory only. */
  usageLedgerFile?: string;
  /** Record the client IP in the overview ledger (default `true`). */
  recordClientIp?: boolean;
  runIdleTimeoutMs: number;
  runMaxTimeoutMs: number;
  warmSessionTtlMs: number;
  maxWarmSessions: number;
  keyCooldownMs: number;
  /** Default max in-flight requests per managed client key when the key has no own limit (0 = unlimited). */
  clientKeyMaxConcurrent: number;
  maxBodyBytes: number;
}
