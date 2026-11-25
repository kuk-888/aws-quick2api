import type { ModelSelection, QuickThinkingEffort, SDKModel } from "../aws-quick/types.js";

export const DEFAULT_MODEL = "quick-balanced";

export const AWS_QUICK_MODELS: SDKModel[] = [
  {
    id: "quick-fast",
    name: "AWS Quick Fast (Haiku / GPT Luna)",
    displayName: "Quick Fast (Haiku)",
    description: "Fastest option for everyday tasks (typically routes to Haiku / GPT Luna)",
    agentMode: "fast",
    thinkingEffort: "off",
    parameters: [],
  },
  {
    id: "quick-balanced",
    name: "AWS Quick Balanced (Sonnet / GPT Terra)",
    displayName: "Quick Balanced (Sonnet)",
    description: "Balanced speed and depth (typically routes to Sonnet / GPT Terra; supports reasoning)",
    agentMode: "balanced",
    thinkingEffort: "off",
    parameters: [{ id: "effort", values: ["off", "low", "medium", "high", "max"] }],
  },
  {
    id: "quick-balanced-think",
    name: "AWS Quick Balanced Think (Sonnet)",
    displayName: "Quick Balanced Think (Sonnet)",
    description: "Balanced mode with reasoning enabled by default (typically routes to Sonnet)",
    agentMode: "balanced",
    thinkingEffort: "medium",
    parameters: [{ id: "effort", values: ["low", "medium", "high", "max"] }],
  },
  {
    id: "quick-smart",
    name: "AWS Quick Smart (Opus / GPT Sol)",
    displayName: "Quick Smart (Opus)",
    description: "Deeper reasoning and highest quality (typically routes to Opus / GPT Sol; supports reasoning)",
    agentMode: "smart",
    thinkingEffort: "off",
    parameters: [{ id: "effort", values: ["off", "low", "medium", "high", "max"] }],
  },
  {
    id: "quick-smart-think",
    name: "AWS Quick Smart Think (Opus)",
    displayName: "Quick Smart Think (Opus)",
    description: "Smart mode with high reasoning enabled by default (typically routes to Opus)",
    agentMode: "smart",
    thinkingEffort: "high",
    parameters: [{ id: "effort", values: ["low", "medium", "high", "max"] }],
  },
  {
    id: "quick-advanced",
    name: "AWS Quick Advanced (Opus Max)",
    displayName: "Quick Advanced",
    description: "Advanced mode with always-on deep reasoning (requires Advanced entitlement)",
    agentMode: "advanced",
    thinkingEffort: "high",
    parameters: [{ id: "effort", values: ["low", "medium", "high", "max"] }],
  },
];

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
  if (k === "high") return "high";
  if (k === "xhigh" || k === "max") return "max";
  return undefined;
}

function matchKnownModel(requestedModel: string | undefined): {
  found: SDKModel | undefined;
  bracketParams?: string;
  suffixEffort?: QuickThinkingEffort;
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

  const directMatch = AWS_QUICK_MODELS.find((m) => m.id === baseId);
  const aliasMatch =
    directMatch ??
    (/advanced/i.test(baseId)
      ? AWS_QUICK_MODELS.find((m) => m.id === "quick-advanced")
      : /opus|\bsmart\b/i.test(baseId)
        ? AWS_QUICK_MODELS.find((m) => m.id === (/think/i.test(baseId) ? "quick-smart-think" : "quick-smart"))
        : /haiku|\bfast\b/i.test(baseId)
          ? AWS_QUICK_MODELS.find((m) => m.id === "quick-fast")
          : /sonnet|\bbalanced\b/i.test(baseId)
            ? AWS_QUICK_MODELS.find((m) => m.id === (/think/i.test(baseId) ? "quick-balanced-think" : "quick-balanced"))
            : undefined);

  return { found: aliasMatch, bracketParams: match?.[2], suffixEffort };
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
  // Map `auto` / `default` to the actual default model (`quick-balanced`) so DISABLED_MODELS
  // and sub-key allowlists cannot be bypassed via `model: "auto"` or `model: "default"`.
  if (base === "auto" || base === "default") return AWS_QUICK_MODELS[1]!.id;
  return matchKnownModel(requestedModel).found?.id ?? null;
}

export function resolveModelSelection(
  requestedModel: string | undefined,
  body: Record<string, unknown> = {},
  _modelSchema?: SDKModel,
): { selection: ModelSelection; canonicalId: string } {
  const { found: matched, bracketParams, suffixEffort } = matchKnownModel(requestedModel);
  const found = matched ?? AWS_QUICK_MODELS[1]!;

  let effort: QuickThinkingEffort = suffixEffort ?? found.thinkingEffort;

  // Check bracket param e.g. quick-balanced[effort=high]
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
    ? (body.thinking as { type?: string; budget_tokens?: number })
    : undefined;
  const thinkingEffortFromObj: QuickThinkingEffort | undefined =
    thinkingObj?.type === "enabled"
      ? typeof thinkingObj.budget_tokens === "number" && thinkingObj.budget_tokens < 2048
        ? "low"
        : typeof thinkingObj.budget_tokens === "number" && thinkingObj.budget_tokens < 8192
          ? "medium"
          : "high"
      : thinkingObj?.type === "disabled"
        ? "off"
        : undefined;
  const enableThinkingEffort: QuickThinkingEffort | undefined =
    body.enable_thinking === true
      ? found.agentMode === "balanced"
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

  if (bodyEffort && found.agentMode !== "fast") {
    effort = found.agentMode === "advanced" && bodyEffort === "off" ? "high" : bodyEffort;
  }

  return {
    selection: {
      model: found.id,
      agentMode: found.agentMode,
      thinkingEffort: found.agentMode === "fast" ? "off" : effort,
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
    owned_by: "aws-quick",
    ...(m.displayName ? { name: m.displayName } : {}),
  }));
}
