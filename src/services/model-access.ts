import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SDKModel } from "../aws-quick/types.js";
import { persistDisabledModelsToEnvFile } from "../core/config.js";
import { classifyModelQuotaPool } from "../core/key-pool.js";
import { GatewayError, type GatewayConfig } from "../core/types.js";
import { normalizeBaseModelId as normalizeCanonicalBaseModelId } from "../utils/hash.js";
import { DEFAULT_MODEL } from "./model-catalog.js";

export interface ManagedModelEntry {
  id: string;
  displayName: string;
  pool: "auto" | "api";
  parameters: string[];
  parameterSpecs: Array<{ id: string; values: string[] }>;
  enabled: boolean;
}

/**
 * Normalize a requested model string (e.g. `quick-balanced[effort=high]` or `quick-smart-think`)
 * into its canonical base model ID (`quick-balanced`, `quick-smart-think`).
 */
export function normalizeBaseModelId(rawModel: string | undefined): string {
  const norm = normalizeCanonicalBaseModelId(rawModel || DEFAULT_MODEL);
  return norm || DEFAULT_MODEL;
}

/**
 * Per-model & batch Enable/Disable Access Controller (`DISABLED_MODELS`).
 * Filters disabled models out of `GET /v1/models` and rejects inference calls with HTTP 403.
 */
export class ModelAccessController {
  private readonly disabledSet = new Set<string>();
  private readonly envFilePath?: string;
  private readonly stateFilePath?: string;

  constructor(config: Pick<GatewayConfig, "disabledModels" | "envFilePath"> & Partial<Pick<GatewayConfig, "dataDir">>) {
    this.envFilePath = config.envFilePath;
    this.stateFilePath = config.dataDir ? path.join(config.dataDir, "model-access.json") : undefined;
    let loadedFromState = false;
    if (this.stateFilePath && existsSync(this.stateFilePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.stateFilePath, "utf8")) as { disabledModels?: unknown };
        if (Array.isArray(parsed?.disabledModels)) {
          loadedFromState = true;
          for (const m of parsed.disabledModels) {
            if (typeof m === "string") {
              const norm = normalizeBaseModelId(m);
              if (norm) this.disabledSet.add(norm);
            }
          }
        }
      } catch {
        // Fall back to env bootstrap on parse error
      }
    }
    if (!loadedFromState) {
      for (const m of config.disabledModels) {
        const norm = normalizeBaseModelId(m);
        if (norm) this.disabledSet.add(norm);
      }
    }
  }

  isModelEnabled(rawModel: string): boolean {
    const norm = normalizeBaseModelId(rawModel);
    return !this.disabledSet.has(norm);
  }

  assertModelAllowed(rawModel: string): void {
    const norm = normalizeBaseModelId(rawModel);
    if (this.disabledSet.has(norm)) {
      throw new GatewayError(
        `Model '${norm}' is currently disabled by gateway administrator.`,
        403,
        "model_disabled",
        "model"
      );
    }
  }

  filterOpenAiModels<T extends { id: string }>(models: readonly T[]): T[] {
    return models.filter((m) => this.isModelEnabled(m.id));
  }

  buildAdminCatalog(liveModels: readonly SDKModel[]): ManagedModelEntry[] {
    const seen = new Set<string>();
    const list: ManagedModelEntry[] = [];

    for (const m of liveModels) {
      if (!m.id) continue;
      const canonicalDisplayId = m.id === "default" ? "auto" : m.id;
      const norm = normalizeBaseModelId(canonicalDisplayId);
      if (seen.has(norm)) continue;
      seen.add(norm);
      const parameterSpecs = (m.parameters ?? []).map((p) => ({
        id: p.id,
        values: (p.values ?? []).map((v) =>
          typeof v === "object" && v !== null && "value" in v ? String(v.value) : String(v)
        )
      }));
      list.push({
        id: canonicalDisplayId,
        displayName: m.displayName || canonicalDisplayId,
        pool: classifyModelQuotaPool(canonicalDisplayId),
        parameters: parameterSpecs.map((p) =>
          p.values.length > 0 ? `${p.id}=[${p.values.join("|")}]` : p.id
        ),
        parameterSpecs,
        enabled: !this.disabledSet.has(norm)
      });
    }

    for (const disId of this.disabledSet) {
      if (seen.has(disId)) continue;
      list.push({
        id: disId,
        displayName: disId,
        pool: classifyModelQuotaPool(disId),
        parameters: [],
        parameterSpecs: [],
        enabled: false
      });
    }

    return list;
  }

  applyBatchUpdate(params: {
    action: "enable" | "disable" | "enable_all" | "set_only_enabled";
    models?: readonly string[];
    allCatalogIds?: readonly string[];
  }): { disabledCount: number; disabledModels: string[] } {
    const targets = (params.models ?? []).map((m) => normalizeBaseModelId(m)).filter(Boolean);

    if (params.action === "enable_all") {
      this.disabledSet.clear();
    } else if (params.action === "enable") {
      for (const id of targets) this.disabledSet.delete(id);
    } else if (params.action === "disable") {
      for (const id of targets) this.disabledSet.add(id);
    } else if (params.action === "set_only_enabled") {
      const keepSet = new Set(targets);
      const universe = (params.allCatalogIds ?? []).map((m) => normalizeBaseModelId(m)).filter(Boolean);
      this.disabledSet.clear();
      for (const id of universe) {
        if (!keepSet.has(id)) this.disabledSet.add(id);
      }
    }

    const sorted = [...this.disabledSet].sort();
    if (this.stateFilePath) {
      const dir = path.dirname(this.stateFilePath);
      const tmp = `${this.stateFilePath}.${process.pid}.tmp`;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(tmp, `${JSON.stringify({ version: 1, disabledModels: sorted, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
        try { chmodSync(tmp, 0o600); } catch { }
        renameSync(tmp, this.stateFilePath);
      } catch (err) {
        try { unlinkSync(tmp); } catch { }
        console.warn("[model-access] Failed to persist model-access.json:", err instanceof Error ? err.message : String(err));
      }
    } else {
      persistDisabledModelsToEnvFile(this.envFilePath, sorted);
    }
    return { disabledCount: sorted.length, disabledModels: sorted };
  }

  disabledSnapshot(): string[] {
    return [...this.disabledSet].sort();
  }
}
