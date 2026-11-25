import type { ModelSelection, QuickAgentMode, QuickThinkingEffort, SDKModel } from "../aws-quick/types.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const AWS_QUICK_MODELS: SDKModel[] = [
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    displayName: "Claude Haiku 5.5",
    description: "Fastest option for everyday tasks (AWS Quick fast mode)",
    agentMode: "fast",
    thinkingEffort: "off",
    parameters: [],
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    displayName: "Claude Sonnet 5.5",
    description: "Balanced speed and depth for coding and general tasks (AWS Quick balanced mode)",
    agentMode: "balanced",
    thinkingEffort: "off",
    parameters: [{ id: "effort", values: ["off", "low", "medium", "high"] }],
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    displayName: "Claude Opus 5.5",
    description: "Deep reasoning and highest quality for complex tasks (AWS Quick smart mode)",
    agentMode: "smart",
    thinkingEffort: "off",
    parameters: [{ id: "effort", values: ["off", "low", "medium", "high"] }],
  },
];

interface QuickModelAlias {
  id: string;
  agentMode?: QuickAgentMode;
  thinkingEffort?: QuickThinkingEffort;
}

/** Legacy request aliases stay usable, but only the three Claude IDs are advertised. */
const QUICK_MODEL_ALIASES: Record<string, QuickModelAlias> = {
  "quick-fast": { id: "claude-haiku-5-5" },
  "quick-balanced": { id: "claude-sonnet-5-5" },
  "quick-balanced-think": { id: "claude-sonnet-5-5", thinkingEffort: "medium" },
  "quick-smart": { id: "claude-opus-5-5" },
  "quick-smart-think": { id: "claude-opus-5-5", thinkingEffort: "high" },
  "quick-advanced": { id: "claude-opus-5-5", agentMode: "advanced", thinkingEffort: "high" },
};

const BUILT_IN_MODEL_IDS = new Set(AWS_QUICK_MODELS.map((model) => model.id));

export function isBuiltInModelId(modelId: string): boolean {
  return BUILT_IN_MODEL_IDS.has(modelId);
}

export function canonicalizeModelId(rawModel: string): string {
  const base = rawModel.trim().toLowerCase().split("[")[0]?.replace(/\([^)]*\)$/, "").trim() || DEFAULT_MODEL;
  return QUICK_MODEL_ALIASES[base]?.id ?? base;
}

export async function listLiveModels(
  _apiKey: string,
  fetcher?: (key: string) => Promise<SDKModel[]>,
): Promise<SDKModel[]> {
  if (fetcher) return fetcher(_apiKey);
  return AWS_QUICK_MODELS;
}

function parseEffort(raw: unknown): QuickThinkingEffort | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const k = raw.trim().toLowerCase();
  if (k === "off" || k === "none" || k === "disabled" || k === "false") return "off";
  if (k === "low" || k === "minimal") return "low";
  if (k === "medium" || k === "mid") return "medium";
  if (k === "high" || k === "xhigh" || k === "max") return "high";
  return undefined;
}

function matchKnownModel(requestedModel: string | undefined): {
  found: SDKModel | undefined;
  bracketParams?: string;
  suffixEffort?: QuickThinkingEffort;
  aliasAgentMode?: QuickAgentMode;
  aliasThinkingEffort?: QuickThinkingEffort;
} {
  const raw = (requestedModel || "").trim() || DEFAULT_MODEL;
  // Strip leading gateway/provider prefixes BEFORE bracket-param parsing so `[aws]-quick-smart` doesn't collide with `[effort=high]`
  const strippedRaw = raw.replace(/^(?:(?:amazon-)?quick\/|aws-quick\/|\[(?:quick|aws)\]-)+/i, "").trim() || DEFAULT_MODEL;
  const match = /^([^\[]+?)(?:\[(.*)\])?$/.exec(strippedRaw);
  let baseRaw = (match?.[1] || strippedRaw).trim().toLowerCase();

  // Extract optional parenthesized effort e.g. `quick-smart(high)` or `claude-opus-5.5(max)`
  let suffixEffort: QuickThinkingEffort | undefined;
  const parenMatch = /\(([^)]+)\)$/.exec(baseRaw);
  if (parenMatch) {
    suffixEffort = parseEffort(parenMatch[1]);
    baseRaw = baseRaw.slice(0, parenMatch.index).trim();
  }

  let baseId = baseRaw;

  // Extract optional hyphenated effort suffix e.g. `claude-opus-5-5-high`, `quick-smart-low`, `quick-balanced-thinking`
  if (!AWS_QUICK_MODELS.some((m) => m.id === baseId)) {
    const hypMatch = /^(.+?)-(off|none|low|medium|mid|high|xhigh|max|thinking)$/i.exec(baseId);
    if (hypMatch) {
      const parsed = hypMatch[2]!.toLowerCase() === "thinking" ? "high" : parseEffort(hypMatch[2]);
      if (parsed) {
        suffixEffort = suffixEffort ?? parsed;
        baseId = hypMatch[1]!.trim();
      }
    }
  }

  const exactMatch =
    AWS_QUICK_MODELS.find((m) => m.id === baseId) ??
    AWS_QUICK_MODELS.find((m) => m.id === baseId.replace(/\./g, "-"));
  const legacyAlias = exactMatch
    ? undefined
    : QUICK_MODEL_ALIASES[baseId] ?? QUICK_MODEL_ALIASES[baseId.replace(/\./g, "-")];
  const aliasTarget = legacyAlias ? AWS_QUICK_MODELS.find((m) => m.id === legacyAlias.id) : undefined;
  const directMatch = exactMatch ?? aliasTarget;
  // Family heuristics keep loosely-named requests (`opus`, `sonnet-think`, `haiku`) working
  // now that the catalog advertises only the three Claude 5.5 IDs.
  const aliasMatch =
    directMatch ??
    (/advanced|opus|\bsmart\b/i.test(baseId)
      ? AWS_QUICK_MODELS.find((m) => m.id === "claude-opus-5-5")
      : /haiku|\bfast\b/i.test(baseId)
        ? AWS_QUICK_MODELS.find((m) => m.id === "claude-haiku-5-5")
        : /sonnet|\bbalanced\b/i.test(baseId)
          ? AWS_QUICK_MODELS.find((m) => m.id === "claude-sonnet-5-5")
          : undefined);

  return {
    found: aliasMatch,
    bracketParams: match?.[2],
    suffixEffort,
    aliasAgentMode: aliasTarget ? legacyAlias?.agentMode : undefined,
    aliasThinkingEffort: aliasTarget ? legacyAlias?.thinkingEffort : undefined,
  };
}

/**
 * Resolves a requested model ID, provider prefix, or Claude alias (e.g. `quick/claude-opus-5-5-high`,
 * `[aws]-quick-advanced`) to its canonical `AWS_QUICK_MODELS` ID, or `null` if unknown.
 * Used by route-level `DISABLED_MODELS`, Sub-Key allowlist, and `assertModelExists` checks so
 * aliases work on public routes and prefixes can never bypass model restrictions.
 */
export function resolveKnownModelId(requestedModel: string | undefined): string | null {
  if (!requestedModel || !requestedModel.trim()) return null;
  let stripped = requestedModel.trim().toLowerCase();
  stripped = stripped.replace(/^\[[^\]]+\][-_/]?/, "");
  stripped = stripped.replace(/^(?:amazon-quick|aws-quick|quick|aws|anthropic)\//, "");
  const base = stripped.split("[")[0]?.replace(/\([^)]*\)$/, "").trim() ?? "";
  // Map `auto` / `default` to the actual default model (`DEFAULT_MODEL`) so DISABLED_MODELS
  // and sub-key allowlists cannot be bypassed via `model: "auto"` or `model: "default"`.
  if (base === "auto" || base === "default") return AWS_QUICK_MODELS[1]!.id;
  return matchKnownModel(requestedModel).found?.id ?? null;
}

export function resolveModelSelection(
  requestedModel: string | undefined,
  body: Record<string, unknown> = {},
  _modelSchema?: SDKModel,
): { selection: ModelSelection; canonicalId: string } {
  const { found: matched, bracketParams, suffixEffort, aliasAgentMode, aliasThinkingEffort } =
    matchKnownModel(requestedModel);
  const found = matched ?? AWS_QUICK_MODELS[1]!;
  const agentMode = aliasAgentMode ?? found.agentMode;

  let effort: QuickThinkingEffort = suffixEffort ?? aliasThinkingEffort ?? found.thinkingEffort;

  // Check bracket param e.g. claude-sonnet-5-5[effort=high]
  if (bracketParams) {
    for (const part of bracketParams.split(",")) {
      const [k, v] = part.split("=").map((s) => s.trim());
      if (k === "effort" || k === "thinking_effort") {
        const parsed = parseEffort(v);
        if (parsed) effort = parsed;
      }
    }
  }

  // Check OpenAI reasoning_effort / Responses reasoning.effort / Anthropic & GLM thinking / Qwen enable_thinking
  const reasoningObj = body.reasoning && typeof body.reasoning === "object"
    ? (body.reasoning as { effort?: unknown })
    : undefined;
  const thinkingObj = body.thinking && typeof body.thinking === "object"
    ? (body.thinking as { type?: unknown; budget_tokens?: unknown })
    : undefined;
  const thinkingEffortFromObj =
    thinkingObj?.type === "enabled"
      ? typeof thinkingObj.budget_tokens === "number" && thinkingObj.budget_tokens < 2048
        ? "low"
        : typeof thinkingObj.budget_tokens === "number" && thinkingObj.budget_tokens < 8192
          ? "medium"
          : "high"
      : thinkingObj?.type === "disabled"
        ? "off"
        : undefined;
  const enableThinkingEffort =
    body.enable_thinking === true
      ? agentMode === "balanced"
        ? "medium"
        : "high"
      : body.enable_thinking === false
        ? "off"
        : undefined;

  const bodyEffort =
    parseEffort(body.reasoning_effort) ||
    parseEffort(body.effort) ||
    parseEffort(reasoningObj?.effort) ||
    thinkingEffortFromObj ||
    enableThinkingEffort;

  if (bodyEffort && agentMode !== "fast") {
    effort = agentMode === "advanced" && bodyEffort === "off" ? "high" : bodyEffort;
  }

  return {
    selection: {
      model: found.id,
      agentMode,
      thinkingEffort: agentMode === "fast" ? "off" : effort,
    },
    canonicalId: found.id,
  };
}

export function formatOpenAiModelList(models: SDKModel[]): Array<{
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name?: string;
}> {
  return models.map((m) => ({
    id: m.id,
    object: "model",
    created: 0,
    owned_by: "anthropic",
    ...(m.displayName ? { name: m.displayName } : {}),
  }));
}
