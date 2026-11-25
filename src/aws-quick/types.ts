export type QuickAgentMode = "fast" | "balanced" | "smart" | "advanced";
/**
 * Thinking-effort tiers forwarded to AWS Quick as `thinking_effort`.
 * `max` is passed through optimistically: the gateway probes it on first use and
 * auto-degrades to `high` for accounts that reject it (see services/effort-capability.ts).
 */
export type QuickThinkingEffort = "off" | "low" | "medium" | "high" | "max";

export interface SDKModelParameter {
  id: string;
  values: Array<string | { value: string; label?: string }>;
}

export interface SDKModel {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
  parameters?: SDKModelParameter[];
  agentMode: QuickAgentMode;
  thinkingEffort: QuickThinkingEffort;
}

export interface ModelSelection {
  model: string;
  parameters?: Record<string, string>;
  agentMode: QuickAgentMode;
  thinkingEffort: QuickThinkingEffort;
}

export interface CloudSessionMeta {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export interface QuickQuotaUsage {
  session?: {
    used: number;
    limit: number;
    percent: number;
    label?: string;
    resets_at?: number | string | null;
    resume_in_minutes?: number | null;
  };
  monthly?: {
    used: number;
    limit: number;
    percent?: number;
    label?: string;
    resets_at?: number | string | null;
    resume_in_minutes?: number | null;
  };
  subscription?: {
    subscription_type?: string;
    free_trial_metadata?: {
      status?: string;
      expiry_date?: number;
    };
  };
}
