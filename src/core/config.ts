import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { AutoDisabledState, GatewayConfig, LbStrategy } from "./types.js";

export function loadDotEnv(explicitPath?: string): string | undefined {
  const candidates = [
    explicitPath,
    process.env.ENV_FILE_PATH?.trim(),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "data", ".env")
  ].filter((p): p is string => Boolean(p));

  const envPath = candidates.find((p) => existsSync(p));
  if (!envPath) return undefined;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return envPath;
}

function parseIntEnv(val: string | undefined, fallback: number): number {
  if (val === undefined || val === "") return fallback;
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseBoolEnv(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined || val === "") return fallback;
  const v = val.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseKeyAutoDisabled(raw: string | undefined): Record<string, AutoDisabledState> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, AutoDisabledState> = Object.create(null);
    for (const [slot, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || slot === "__proto__" || slot === "constructor" || slot === "prototype") continue;
      const r = v as Record<string, unknown>;
      if (r.kind !== "quota" && r.kind !== "auth") continue;
      out[slot] = {
        kind: r.kind,
        reason: typeof r.reason === "string" ? r.reason.slice(0, 120) : "",
        ...(typeof r.resetAtMs === "number" && Number.isFinite(r.resetAtMs) ? { resetAtMs: r.resetAtMs } : {})
      };
    }
    return out;
  } catch {
    return {};
  }
}

function parseKeyLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = Object.create(null);
      for (const [k, v] of Object.entries(parsed)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
        if (typeof v === "string" && v.trim()) out[k] = v.trim();
      }
      return out;
    }
  } catch {
    // Ignore malformed JSON
  }
  return {};
}

function parseKeyAddedAt(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = Object.create(null);
      for (const [k, v] of Object.entries(parsed)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
        if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
      }
      return out;
    }
  } catch {
    // Ignore malformed JSON
  }
  return {};
}

function parseTrustProxy(raw: string | undefined): "loopback" | "all" | "off" {
  const s = (raw || "").trim().toLowerCase();
  if (s === "all" || s === "true" || s === "1") return "all";
  if (s === "off" || s === "false" || s === "0") return "off";
  return "loopback";
}

function parseLbStrategy(raw: string | undefined): LbStrategy {
  const s = (raw || "").trim().toLowerCase();
  if (s === "round-robin" || s === "least-busy" || s === "quota-aware") return s;
  return "quota-aware";
}

export function normalizeDashboardPath(raw: string | undefined): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "/dashboard";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const cleaned = withSlash.replace(/\/+$/, "");
  if (!cleaned || cleaned === "/" || cleaned.startsWith("/v1")) {
    return "/dashboard";
  }
  return cleaned;
}

export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath?: string
): GatewayConfig {
  const gatewayTokens = new Set([
    ...splitCsv(env.GATEWAY_TOKEN),
    ...splitCsv(env.GATEWAY_TOKENS)
  ]);

  const quickTokens = Array.from(
    new Set([
      ...splitCsv(env.QUICK_TOKENS),
      ...splitCsv(env.QUICK_TOKEN)
    ])
  );

  const disabledQuickTokens = Array.from(new Set(splitCsv(env.DISABLED_QUICK_TOKENS)));
  if (process.platform === "darwin" && quickTokens.length === 0 && disabledQuickTokens.length === 0) {
    quickTokens.push("local-outpost");
  }
  const disabledModels = Array.from(new Set(splitCsv(env.DISABLED_MODELS)));
  const adminPassword = env.ADMIN_PASSWORD?.trim() || undefined;
  const enableDashboard = parseBoolEnv(env.ENABLE_DASHBOARD, true);
  const dashboardPath = normalizeDashboardPath(env.DASHBOARD_PATH);

  const explicitDataDir = env.DATA_DIR?.trim() || undefined;
  const resolvedDataDir =
    explicitDataDir ??
    (envFilePath
      ? path.dirname(envFilePath)
      : env.ENV_FILE_PATH?.trim()
        ? path.dirname(env.ENV_FILE_PATH.trim())
        : existsSync(path.resolve(process.cwd(), "data"))
          ? path.resolve(process.cwd(), "data")
          : undefined);

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: parseIntEnv(env.PORT, 3456) || 3456,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    gatewayTokens,
    adminPassword,
    enableDashboard,
    dashboardPath,
    quickTokens,
    disabledQuickTokens,
    disabledModels,
    keyLabels: parseKeyLabels(env.KEY_LABELS),
    keyProxies: parseKeyLabels(env.KEY_PROXIES),
    chatAgentId: env.CHAT_AGENT_ID?.trim() || undefined,
    autoEnsureCodingAgent: parseBoolEnv(env.AUTO_ENSURE_CODING_AGENT, true),
    customAgentPrompt: env.CUSTOM_AGENT_PROMPT
      ? env.CUSTOM_AGENT_PROMPT.replace(/\\n/g, "\n").trim() || undefined
      : undefined,
    sanitizeClientSystemPrompt: parseBoolEnv(env.SANITIZE_CLIENT_SYSTEM_PROMPT, false),
    autoRephraseOnContentFilter: parseBoolEnv(env.AUTO_REPHRASE_ON_CONTENT_FILTER, false),
    contentFilterRephrasePrompt: env.CONTENT_FILTER_REPHRASE_PROMPT
      ? env.CONTENT_FILTER_REPHRASE_PROMPT.replace(/\\n/g, "\n").trim() || undefined
      : undefined,
    contentFilterRephraseModel:
      env.CONTENT_FILTER_REPHRASE_MODEL?.trim() === "quick-balanced" ? "quick-balanced" : "quick-fast",
    keyChatAgentIds: parseKeyLabels(env.KEY_CHAT_AGENT_IDS),
    keyAddedAt: parseKeyAddedAt(env.KEY_ADDED_AT),
    keyAutoDisabled: parseKeyAutoDisabled(env.KEY_AUTO_DISABLED),
    lbStrategy: parseLbStrategy(env.LB_STRATEGY),
    sessionAffinityEnabled: parseBoolEnv(env.SESSION_AFFINITY_ENABLED, true),
    sessionAffinityTtlMs: parseIntEnv(env.SESSION_AFFINITY_TTL_MS, 60 * 60 * 1000) || 60 * 60 * 1000,
    autoDisableExhaustedKeys: parseBoolEnv(env.AUTO_DISABLE_EXHAUSTED_KEYS, true),
    incognitoMode: parseBoolEnv(env.INCOGNITO, true),
    envFilePath,
    dataDir: resolvedDataDir,
    usageLedgerFile: env.USAGE_LEDGER_FILE?.trim() || (resolvedDataDir ? path.join(resolvedDataDir, "usage-ledger.json") : undefined),
    recordClientIp: parseBoolEnv(env.RECORD_CLIENT_IP, true),
    runIdleTimeoutMs: parseIntEnv(env.RUN_IDLE_TIMEOUT_MS, 10 * 60 * 1000) || 600_000,
    runMaxTimeoutMs: parseIntEnv(env.RUN_MAX_TIMEOUT_MS, 15 * 60 * 1000) || 900_000,
    warmSessionTtlMs: parseIntEnv(env.WARM_SESSION_TTL_MS, 30 * 60 * 1000) || 1_800_000,
    maxWarmSessions: Math.max(1, parseIntEnv(env.MAX_WARM_SESSIONS, 256)),
    keyCooldownMs: parseIntEnv(env.KEY_COOLDOWN_MS, 30 * 1000) || 30_000,
    clientKeyMaxConcurrent: Math.max(0, parseIntEnv(env.CLIENT_KEY_MAX_CONCURRENT, 0)),
    maxBodyBytes: parseIntEnv(env.MAX_BODY_BYTES, 16 * 1024 * 1024) || 16_777_216
  };
}

/** Placeholder-looking secrets copied verbatim from docs / `.env.example`; they are public and must never protect a real gateway. */
const PLACEHOLDER_SECRET_RE = /change[-_ ]?(?:me|this)|placeholder|your[-_](?:token|password|key|secret)|<[^>]+>/i;

export function isPlaceholderSecret(val: string | undefined): boolean {
  if (!val) return false;
  return PLACEHOLDER_SECRET_RE.test(val.trim());
}

/**
 * Returns human-readable problems for secrets that still hold documented placeholder values
 * (e.g. `sk-aq-change-me`, `sk-aq-<generate-your-own>`, `change-this-admin-password`). Never includes the secret values themselves.
 */
export function findInsecurePlaceholderConfig(config: Pick<GatewayConfig, "gatewayTokens" | "adminPassword">): string[] {
  const issues: string[] = [];
  for (const tok of config.gatewayTokens) {
    if (isPlaceholderSecret(tok)) {
      issues.push("GATEWAY_TOKEN still contains a placeholder value from .env.example; remove it (a random key is auto-generated) or set your own secret.");
      break;
    }
  }
  if (config.adminPassword && isPlaceholderSecret(config.adminPassword)) {
    issues.push("ADMIN_PASSWORD still contains a placeholder value from .env.example; set a strong password or leave it unset to initialize it from localhost.");
  }
  return issues;
}

function stripEnvNewlines(val: string): string {
  return val.replace(/[\r\n]/g, "");
}

function writeEnvFileAtomic(envFilePath: string, content: string): void {
  const dir = path.dirname(envFilePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${envFilePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore on platforms/filesystems without POSIX chmod
  }
  try {
    renameSync(tmpPath, envFilePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EBUSY" || code === "EXDEV" || code === "EPERM") {
      writeFileSync(envFilePath, content, { mode: 0o600 });
      try {
        chmodSync(envFilePath, 0o600);
      } catch {
        // Ignore
      }
      return;
    }
    throw err;
  }
}

export function buildUpdatedPoolEnvContent(
  content: string,
  state: {
    activeKeys: string[];
    disabledKeys: string[];
    keyLabels: Record<string, string>;
    keyProxies?: Record<string, string>;
    chatAgentId?: string;
    keyChatAgentIds?: Record<string, string>;
    keyAddedAt?: Record<string, number>;
    keyAutoDisabled: Record<string, AutoDisabledState>;
    lbStrategy: LbStrategy;
    sessionAffinityEnabled: boolean;
    sessionAffinityTtlMs: number;
    autoDisableExhaustedKeys: boolean;
    incognitoMode?: boolean;
    autoEnsureCodingAgent?: boolean;
    customAgentPrompt?: string;
    sanitizeClientSystemPrompt?: boolean;
    autoRephraseOnContentFilter?: boolean;
    contentFilterRephrasePrompt?: string;
    contentFilterRephraseModel?: string;
  },
): string {
  const updates: Record<string, string> = {
    QUICK_TOKENS: stripEnvNewlines(state.activeKeys.join(",")),
    DISABLED_QUICK_TOKENS: stripEnvNewlines(state.disabledKeys.join(",")),
    KEY_LABELS: stripEnvNewlines(JSON.stringify(state.keyLabels)),
    ...(state.keyProxies ? { KEY_PROXIES: stripEnvNewlines(JSON.stringify(state.keyProxies)) } : {}),
    ...(typeof state.chatAgentId === "string" ? { CHAT_AGENT_ID: stripEnvNewlines(state.chatAgentId) } : {}),
    ...(state.keyChatAgentIds ? { KEY_CHAT_AGENT_IDS: stripEnvNewlines(JSON.stringify(state.keyChatAgentIds)) } : {}),
    ...(state.keyAddedAt ? { KEY_ADDED_AT: stripEnvNewlines(JSON.stringify(state.keyAddedAt)) } : {}),
    KEY_AUTO_DISABLED: stripEnvNewlines(JSON.stringify(state.keyAutoDisabled)),
    LB_STRATEGY: state.lbStrategy,
    SESSION_AFFINITY_ENABLED: String(state.sessionAffinityEnabled),
    SESSION_AFFINITY_TTL_MS: String(state.sessionAffinityTtlMs),
    AUTO_DISABLE_EXHAUSTED_KEYS: String(state.autoDisableExhaustedKeys),
    ...(typeof state.incognitoMode === "boolean"
      ? { INCOGNITO: String(state.incognitoMode) }
      : {}),
    ...(typeof state.autoEnsureCodingAgent === "boolean"
      ? { AUTO_ENSURE_CODING_AGENT: String(state.autoEnsureCodingAgent) }
      : {}),
    ...(typeof state.customAgentPrompt === "string"
      ? { CUSTOM_AGENT_PROMPT: stripEnvNewlines(state.customAgentPrompt.replace(/\r?\n/g, "\\n")) }
      : {}),
    ...(typeof state.sanitizeClientSystemPrompt === "boolean"
      ? { SANITIZE_CLIENT_SYSTEM_PROMPT: String(state.sanitizeClientSystemPrompt) }
      : {}),
    ...(typeof state.autoRephraseOnContentFilter === "boolean"
      ? { AUTO_REPHRASE_ON_CONTENT_FILTER: String(state.autoRephraseOnContentFilter) }
      : {}),
    ...(typeof state.contentFilterRephrasePrompt === "string"
      ? { CONTENT_FILTER_REPHRASE_PROMPT: stripEnvNewlines(state.contentFilterRephrasePrompt.replace(/\r?\n/g, "\\n")) }
      : {}),
    ...(typeof state.contentFilterRephraseModel === "string"
      ? { CONTENT_FILTER_REPHRASE_MODEL: stripEnvNewlines(state.contentFilterRephraseModel) }
      : {})
  };
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key === "QUICK_TOKEN") return "";
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }

  return lines.filter((l, idx, arr) => !(l === "" && arr[idx - 1] === "")).join("\n").trimEnd() + "\n";
}

export function persistPoolConfigToEnvFile(
  envFilePath: string | undefined,
  state: Parameters<typeof buildUpdatedPoolEnvContent>[1]
): void {
  if (!envFilePath || !existsSync(envFilePath)) return;
  const content = readFileSync(envFilePath, "utf8");
  const cleaned = buildUpdatedPoolEnvContent(content, state);
  // Atomic replace: a crash mid-write must never leave a truncated .env (it holds the upstream keys).
  writeEnvFileAtomic(envFilePath, cleaned);
}

function isWritableEnvFileSync(envFilePath: string): boolean {
  try {
    accessSync(envFilePath, fsConstants.W_OK);
    const st = statSync(envFilePath);
    if ((st.mode & 0o222) === 0) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous best-effort mirror of pool state back to `.env` (used during graceful shutdown).
 * Silently skips if `.env` is read-only (`0444`, `:ro`, `EACCES`, `EROFS`) so `pool-state.json`
 * remains unaffected and read-only `.env` mounts are never touched.
 */
export function mirrorPoolConfigToEnvFileSyncBestEffort(
  envFilePath: string | undefined,
  state: Parameters<typeof buildUpdatedPoolEnvContent>[1],
): boolean {
  if (!envFilePath || !existsSync(envFilePath) || !isWritableEnvFileSync(envFilePath)) return false;
  try {
    const content = readFileSync(envFilePath, "utf8");
    const cleaned = buildUpdatedPoolEnvContent(content, state);
    if (cleaned === content) return true;
    writeEnvFileAtomic(envFilePath, cleaned);
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-blocking best-effort async mirror of pool state back to `.env`.
 * Protects users who mounted only `.env` (without `/app/data`) or who later downgrade to `<= v0.1.20`.
 * Silently no-ops if `.env` is mounted read-only (`0444`, `:ro`, `EACCES`, `EROFS`), since
 * `${DATA_DIR}/pool-state.json` is already the authoritative atomic store.
 */
export async function mirrorPoolConfigToEnvFileAsync(
  envFilePath: string | undefined,
  state: Parameters<typeof buildUpdatedPoolEnvContent>[1],
): Promise<boolean> {
  if (!envFilePath || !existsSync(envFilePath)) return false;
  const tmpPath = `${envFilePath}.${process.pid}.${Date.now()}.mirror.tmp`;
  try {
    await fsPromises.access(envFilePath, fsConstants.W_OK);
    const st = await fsPromises.stat(envFilePath);
    if ((st.mode & 0o222) === 0) return false;
    const content = await fsPromises.readFile(envFilePath, "utf8");
    const cleaned = buildUpdatedPoolEnvContent(content, state);
    if (cleaned === content) return true;
    await fsPromises.writeFile(tmpPath, cleaned, { encoding: "utf8", mode: 0o600 });
    try { await fsPromises.chmod(tmpPath, 0o600); } catch { }
    try {
      await fsPromises.rename(tmpPath, envFilePath);
      return true;
    } catch (renameErr) {
      try { await fsPromises.unlink(tmpPath); } catch { }
      const code = (renameErr as NodeJS.ErrnoException)?.code;
      if (code === "EBUSY" || code === "EXDEV" || code === "EPERM") {
        await fsPromises.writeFile(envFilePath, cleaned, { encoding: "utf8", mode: 0o600 });
        try { await fsPromises.chmod(envFilePath, 0o600); } catch { }
        return true;
      }
      return false;
    }
  } catch {
    try { await fsPromises.unlink(tmpPath); } catch { }
    return false;
  }
}

/**
 * Verifies that `dataDir` is writable at startup so non-root Docker containers with a root-owned
 * `./data` bind mount fail fast with an actionable `chown` hint instead of silently dropping writes later.
 */
export function assertDataDirWritable(dataDir: string | undefined): void {
  if (!dataDir) return;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const probePath = path.join(dataDir, `.write-probe-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(probePath, "ok\n", { mode: 0o600 });
  } finally {
    try {
      unlinkSync(probePath);
    } catch {
      // Ignore if probe was never created
    }
  }
}

/**
 * On Linux inside Docker (`/.dockerenv` present), checks `/proc/self/mountinfo` to detect whether
 * `dataDir` is backed by a dedicated mount point (e.g. `-v ./data:/app/data`).
 * Returns `false` only when running inside Docker AND `dataDir` sits on the ephemeral container rootfs.
 */
export function isDockerDataDirMounted(dataDir: string | undefined): boolean {
  if (!dataDir || process.platform !== "linux" || !existsSync("/.dockerenv")) return true;
  try {
    const resolved = path.resolve(dataDir).replace(/\/+$/, "") || "/";
    const mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
    for (const line of mountinfo.split("\n")) {
      const parts = line.split(" ");
      const mountPoint = parts[4];
      if (!mountPoint || mountPoint === "/") continue;
      if (resolved === mountPoint || resolved.startsWith(`${mountPoint}/`)) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function persistAdminPasswordToEnvFile(envFilePath: string | undefined, newPassword: string): void {
  if (!envFilePath || !existsSync(envFilePath)) return;
  if (/[\r\n]/.test(newPassword)) {
    throw new Error("Admin password must not contain newline characters.");
  }
  const content = readFileSync(envFilePath, "utf8");
  let found = false;
  const lines = content.split(/\r?\n/).map((line) => {
    if (line.trim().startsWith("ADMIN_PASSWORD=")) {
      found = true;
      return `ADMIN_PASSWORD=${newPassword}`;
    }
    return line;
  });
  if (!found) lines.push(`ADMIN_PASSWORD=${newPassword}`);
  writeEnvFileAtomic(envFilePath, lines.join("\n").trimEnd() + "\n");
}

export function persistDisabledModelsToEnvFile(envFilePath: string | undefined, disabledModels: string[]): void {
  if (!envFilePath || !existsSync(envFilePath)) return;
  const content = readFileSync(envFilePath, "utf8");
  const serialized = stripEnvNewlines(disabledModels.join(","));
  let found = false;
  const lines = content.split(/\r?\n/).map((line) => {
    if (line.trim().startsWith("DISABLED_MODELS=")) {
      found = true;
      return `DISABLED_MODELS=${serialized}`;
    }
    return line;
  });
  if (!found) lines.push(`DISABLED_MODELS=${serialized}`);
  writeEnvFileAtomic(envFilePath, lines.join("\n").trimEnd() + "\n");
}
