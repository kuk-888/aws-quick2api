import crypto from "node:crypto";
import type http from "node:http";
import path from "node:path";
import {
  buildOAuthDiscoveryUrl,
  completeOAuthPkceCallback,
  getOAuthFlowStatus,
  listOAuthCloudSessions,
  serializeOAuthCredential,
  startOAuthPkceFlow,
} from "../aws-quick/oauth-client.js";
import { parseQuickCredential, withSharedOutpostLock } from "../aws-quick/outpost-singleton.js";
import { listWebCloudSessions } from "../aws-quick/web-client.js";
import type { SDKModel } from "../aws-quick/types.js";
import {
  DEFAULT_CODING_AGENT_INSTRUCTIONS,
  DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
  DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
  type QuickExecutionEngine,
} from "../core/engine.js";
import { normalizeAccountGroup, type PoolRoutingSettings, type UpstreamKeyPool } from "../core/key-pool.js";
import {
  GatewayError,
  parseRoutedModelThinkingMode,
  parseSanitizeClientSystemPromptMode,
  type GatewayConfig,
  type GatewayStreamEvent,
} from "../core/types.js";
import { isRecord } from "../protocols/common.js";
import { openAiChatAdapter } from "../protocols/openai.js";
import type { ClientGatewayKeyManager } from "../services/client-keys.js";
import type { ModelAccessController } from "../services/model-access.js";
import { listLiveModels, resolveKnownModelId } from "../services/model-catalog.js";
import type { UsageLedger, LedgerRange } from "../services/usage-ledger.js";
import type { AccountQuotaReport } from "../services/quota-service.js";
import type { RequestTraceLogger } from "../services/request-logger.js";
import {
  applySelfUpdate,
  getSelfUpdateCapability,
  isSelfUpdateInProgress,
  rollbackSelfUpdate,
} from "../services/self-updater.js";
import { checkLatestVersion } from "../services/update-checker.js";
import type { UsageTracker } from "../services/usage-tracker.js";
import { AdminAuthManager, clientIpOf, isDirectLoopbackRequest } from "./admin-auth.js";
import { resolveAdminLang } from "./admin-i18n.js";
import { renderDashboardHtml } from "./dashboard-ui.js";

export interface WebAdminContext {
  config: GatewayConfig;
  adminAuth: AdminAuthManager;
  engine: QuickExecutionEngine;
  keyPool: UpstreamKeyPool;
  clientKeys: ClientGatewayKeyManager;
  modelAccess: ModelAccessController;
  usageTracker: UsageTracker;
  usageLedger: UsageLedger;
  traceLogger: RequestTraceLogger;
  modelListFetcher?: (apiKey: string) => Promise<SDKModel[]>;
  sessionRpcFetcher?: typeof fetch;
  onDemandFetcher?: typeof fetch;
  selfUpdateFetcher?: typeof fetch;
  requestSelfUpdateRestart?: () => void;
  syncKeyQuotas: (opts: {
    includeDisabled?: boolean;
    forceRefresh?: boolean;
    includeRecoveryProbes?: boolean;
    slotIds?: string[];
  }) => Promise<AccountQuotaReport[]>;
  tapStreamWithTrace: (
    events: AsyncGenerator<GatewayStreamEvent, void, unknown>,
    traceId: string | null,
    clientKeyId?: string
  ) => AsyncGenerator<GatewayStreamEvent, void, unknown>;
  extractClientCredential: (req: http.IncomingMessage) => string;
  readJsonBody: (req: http.IncomingMessage, maxBytes: number) => Promise<unknown>;
  sendJson: (
    res: http.ServerResponse,
    status: number,
    payload: unknown,
    opts?: { allowCors?: boolean; extraHeaders?: Record<string, string> }
  ) => void;
  sendHtml: (res: http.ServerResponse, html: string, nonce?: string) => void;
}

/**
 * Isolated Web Console & Management API handler (`src/web/admin-routes.ts`).
 * Completely decoupled from the core OpenAI / Claude protocol proxy pipeline (`src/server.ts`).
 * Can be disabled entirely via `ENABLE_DASHBOARD=false` for pure headless deployments.
 */
export async function tryHandleWebAdminRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: string,
  abortSignal: AbortSignal,
  ctx: WebAdminContext
): Promise<boolean> {
  const {
    config,
    adminAuth,
    engine,
    keyPool,
    clientKeys,
    modelAccess,
    usageTracker,
    traceLogger,
    readJsonBody,
    sendJson,
    sendHtml,
    extractClientCredential
  } = ctx;

  // CSRF defence: cookie-authenticated state-changing requests must carry the console header
  // (a custom header forces a CORS preflight, which cross-site pages cannot pass). Bearer callers are unaffected
  // because requireAdminAuth ignores cookies whenever Authorization / x-api-key headers are present.
  if (
    route.startsWith("/v1/admin/") &&
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    !req.headers.authorization &&
    !req.headers["x-api-key"] &&
    adminAuth.hasSessionCookie(req) &&
    req.headers["x-console-csrf"] !== "1"
  ) {
    throw new GatewayError("Missing CSRF header.", 403, "csrf_required");
  }

  // 1. Console UI HTML (`GET <DASHBOARD_PATH>`)
  if (route === config.dashboardPath && req.method === "GET") {
    const nonce = crypto.randomBytes(16).toString("base64");
    sendHtml(res, renderDashboardHtml(config.dashboardPath, nonce), nonce);
    return true;
  }

  // 2. First-Time Setup & Session Login / Logout / Probe
  if (route === "/v1/admin/setup-status" && req.method === "GET") {
    sendJson(res, 200, { ok: true, needsSetup: !adminAuth.isPasswordConfigured() });
    return true;
  }

  if (route === "/v1/admin/setup" && req.method === "POST") {
    if (!isDirectLoopbackRequest(req)) {
      throw new GatewayError(
        "First-time admin setup is only allowed from localhost (127.0.0.1 / ::1). For remote servers, configure ADMIN_PASSWORD in .env before starting.",
        403,
        "setup_localhost_only"
      );
    }
    const ip = clientIpOf(req, config.trustProxy);
    adminAuth.throttle.assertAllowed(ip);
    const body = await readJsonBody(req, 16_384);
    const pwd = isRecord(body) && typeof body.password === "string" ? body.password.trim() : "";
    if (pwd.length < 8 || pwd.length > 128) {
      adminAuth.throttle.recordFailure(ip);
      throw new GatewayError("Admin password must be between 8 and 128 characters.", 400, "invalid_password");
    }
    // Synchronous in-memory check + write (no await between guard and mutation) prevents TOCTOU races.
    const issued = adminAuth.setupInitialPassword(pwd);
    adminAuth.throttle.recordSuccess(ip);
    sendJson(
      res,
      200,
      { ok: true, token: issued.token },
      { extraHeaders: { "set-cookie": adminAuth.buildSetCookieHeader(req, issued.token, issued.maxAgeSeconds) } }
    );
    return true;
  }

  if (route === "/v1/admin/login" && req.method === "POST") {
    const body = await readJsonBody(req, 16_384);
    const pwd = isRecord(body) && typeof body.password === "string" ? body.password : "";
    const issued = adminAuth.verifyPasswordAndIssueSession(pwd, clientIpOf(req, config.trustProxy));
    sendJson(
      res,
      200,
      { ok: true, token: issued.token },
      { extraHeaders: { "set-cookie": adminAuth.buildSetCookieHeader(req, issued.token, issued.maxAgeSeconds) } }
    );
    return true;
  }

  if (route === "/v1/admin/logout" && req.method === "POST") {
    sendJson(res, 200, { ok: true }, { extraHeaders: { "set-cookie": adminAuth.buildClearCookieHeader(req) } });
    return true;
  }

  if (route === "/v1/admin/session" && req.method === "GET") {
    adminAuth.requireAdminAuth(req, extractClientCredential(req));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (route === "/v1/admin/version" && req.method === "GET") {
    adminAuth.requireAdminAuth(req, extractClientCredential(req));
    const force = new URL(req.url || "/", "http://localhost").searchParams.get("force") === "1";
    const info = await checkLatestVersion(force);
    const effectiveDataDir =
      process.env.AWS_QUICK_UPDATES_DATA_DIR?.trim() ||
      config.dataDir ||
      path.resolve(process.cwd(), "data");
    sendJson(res, 200, {
      ok: true,
      ...info,
      selfUpdate: getSelfUpdateCapability({ dataDir: effectiveDataDir }),
      updateInProgress: isSelfUpdateInProgress(),
    });
    return true;
  }

  if (route === "/v1/admin/update/apply" && req.method === "POST") {
    adminAuth.requireAdminAuth(req, extractClientCredential(req));
    const effectiveDataDir =
      process.env.AWS_QUICK_UPDATES_DATA_DIR?.trim() ||
      config.dataDir ||
      path.resolve(process.cwd(), "data");
    const result = await applySelfUpdate({
      dataDir: effectiveDataDir,
      fetcher: ctx.selfUpdateFetcher,
    });
    sendJson(res, 200, result);
    if (result.willRestart && ctx.requestSelfUpdateRestart) {
      setImmediate(() => ctx.requestSelfUpdateRestart?.());
    }
    return true;
  }

  if (route === "/v1/admin/update/rollback" && req.method === "POST") {
    adminAuth.requireAdminAuth(req, extractClientCredential(req));
    const effectiveDataDir =
      process.env.AWS_QUICK_UPDATES_DATA_DIR?.trim() ||
      config.dataDir ||
      path.resolve(process.cwd(), "data");
    const result = rollbackSelfUpdate({ dataDir: effectiveDataDir });
    sendJson(res, 200, result);
    if (result.willRestart && ctx.requestSelfUpdateRestart) {
      setImmediate(() => ctx.requestSelfUpdateRestart?.());
    }
    return true;
  }

  if (route === "/v1/admin/overview" && req.method === "GET") {
    adminAuth.requireAdminAuth(req, extractClientCredential(req));
    const r = new URL(req.url || "/", "http://localhost").searchParams.get("range");
    const range: LedgerRange = r === "7d" || r === "30d" ? r : "today";
    const persistenceError = keyPool.getPersistenceError();
    sendJson(res, 200, {
      object: "gateway.overview",
      ...ctx.usageLedger.overview(range),
      runtime: engine.runtimeStats(),
      ipRecorded: config.recordClientIp !== false,
      ...(persistenceError ? { storageWarning: persistenceError } : {}),
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
      keyPool: keyPool.statusSnapshot()
    });
    return true;
  }

  // 3. Usage & Quota Telemetry (`/v1/usage` & `/v1/quota`)
  if ((route === "/v1/usage" || route === "/usage") && req.method === "GET") {
    adminAuth.requireAdminAuth(req, extractClientCredential(req));
    sendJson(res, 200, {
      object: "gateway.usage",
      ...usageTracker.snapshot(),
      settings: {
        ...keyPool.getSettings(),
        defaultCustomAgentPrompt: DEFAULT_CODING_AGENT_INSTRUCTIONS,
        defaultContentFilterRephrasePrompt: DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
        defaultContentFilterRephraseModel: DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
      },
      runtime: engine.runtimeStats(),
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
      keyPool: keyPool.statusSnapshot(),
      affinities: keyPool.affinitySnapshot()
    });
    return true;
  }

  if ((route === "/v1/quota" || route === "/quota") && req.method === "GET") {
    const clientToken = extractClientCredential(req);
    adminAuth.requireAdminAuth(req, clientToken);
    const queryParams = new URL(req.url || "/", "http://localhost").searchParams;
    const includeDisabled = queryParams.get("includeDisabled") === "1";
    const forceRefresh = queryParams.get("force") === "1";
    const slotIdsParam = (queryParams.get("slotIds") || "").trim();
    const slotIds = slotIdsParam ? slotIdsParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    // A manual sync also probes keys the gateway tripped on quota, so a top-up brings them back.
    const accounts = await ctx.syncKeyQuotas({
      includeDisabled,
      forceRefresh,
      includeRecoveryProbes: forceRefresh && !slotIds?.length,
      ...(slotIds?.length ? { slotIds } : {}),
    });
    sendJson(res, 200, {
      object: "aws_quick.quota",
      accounts,
      settings: {
        ...keyPool.getSettings(),
        defaultCustomAgentPrompt: DEFAULT_CODING_AGENT_INSTRUCTIONS,
        defaultContentFilterRephrasePrompt: DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
        defaultContentFilterRephraseModel: DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
      },
      runtime: engine.runtimeStats(),
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
      keyPool: keyPool.statusSnapshot(),
      affinities: keyPool.affinitySnapshot(),
      gatewaySessionUsage: usageTracker.snapshot()
    });
    return true;
  }

  if (!route.startsWith("/v1/admin/")) {
    return false;
  }

  // All `/v1/admin/*` routes below require Admin Auth
  adminAuth.requireAdminAuth(req, extractClientCredential(req));

  // 5. Routing & Password Settings
  if (route === "/v1/admin/settings" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body)) throw new GatewayError("JSON object expected.", 400, "invalid_request_error");
    const patch: Partial<PoolRoutingSettings> = {};
    if (body.lbStrategy === "quota-aware" || body.lbStrategy === "least-busy" || body.lbStrategy === "round-robin") {
      patch.lbStrategy = body.lbStrategy;
    }
    if (typeof body.sessionAffinityEnabled === "boolean") patch.sessionAffinityEnabled = body.sessionAffinityEnabled;
    if (typeof body.sessionAffinityTtlSeconds === "number") patch.sessionAffinityTtlSeconds = body.sessionAffinityTtlSeconds;
    if (typeof body.autoDisableExhaustedKeys === "boolean") patch.autoDisableExhaustedKeys = body.autoDisableExhaustedKeys;
    if (typeof body.incognitoMode === "boolean") {
      patch.incognitoMode = body.incognitoMode;
    }
    if (typeof body.autoEnsureCodingAgent === "boolean") {
      patch.autoEnsureCodingAgent = body.autoEnsureCodingAgent;
    }
    if (typeof body.customAgentPrompt === "string") {
      patch.customAgentPrompt = body.customAgentPrompt;
    }
    if (body.sanitizeClientSystemPrompt !== undefined) {
      if (typeof body.sanitizeClientSystemPrompt === "boolean") {
        patch.sanitizeClientSystemPrompt = parseSanitizeClientSystemPromptMode(body.sanitizeClientSystemPrompt);
      } else if (typeof body.sanitizeClientSystemPrompt === "string") {
        const rawMode = body.sanitizeClientSystemPrompt.trim().toLowerCase();
        if (
          rawMode !== "false" &&
          rawMode !== "off" &&
          rawMode !== "true" &&
          rawMode !== "sanitize" &&
          rawMode !== "strip" &&
          rawMode !== "drop"
        ) {
          throw new GatewayError(
            "Invalid `sanitizeClientSystemPrompt` value (expected 'false', 'true', or 'strip').",
            400,
            "invalid_request_error",
          );
        }
        patch.sanitizeClientSystemPrompt = parseSanitizeClientSystemPromptMode(rawMode);
      } else {
        throw new GatewayError(
          "Invalid `sanitizeClientSystemPrompt` value (expected 'false', 'true', or 'strip').",
          400,
          "invalid_request_error",
        );
      }
    }
    if (body.showRoutedModelInThinking !== undefined) {
      if (typeof body.showRoutedModelInThinking === "boolean") {
        patch.showRoutedModelInThinking = parseRoutedModelThinkingMode(body.showRoutedModelInThinking);
      } else if (typeof body.showRoutedModelInThinking === "string") {
        const rawMode = body.showRoutedModelInThinking.trim().toLowerCase();
        if (
          rawMode !== "true" &&
          rawMode !== "auto" &&
          rawMode !== "always" &&
          rawMode !== "false" &&
          rawMode !== "off"
        ) {
          throw new GatewayError(
            "Invalid `showRoutedModelInThinking` value (expected 'true', 'always', or 'false').",
            400,
            "invalid_request_error",
          );
        }
        patch.showRoutedModelInThinking = parseRoutedModelThinkingMode(rawMode);
      } else {
        throw new GatewayError(
          "Invalid `showRoutedModelInThinking` value (expected 'true', 'always', or 'false').",
          400,
          "invalid_request_error",
        );
      }
    }
    if (typeof body.autoRephraseOnContentFilter === "boolean") {
      patch.autoRephraseOnContentFilter = body.autoRephraseOnContentFilter;
    }
    if (typeof body.contentFilterRephrasePrompt === "string") {
      patch.contentFilterRephrasePrompt = body.contentFilterRephrasePrompt;
    }
    if (body.contentFilterRephraseModel === "quick-fast" || body.contentFilterRephraseModel === "quick-balanced") {
      patch.contentFilterRephraseModel = body.contentFilterRephraseModel;
    }
    if (typeof body.chatAgentId === "string") {
      patch.chatAgentId = body.chatAgentId;
    }
    const prevSettings = keyPool.getSettings();
    keyPool.updateSettings(patch);
    const nextSettings = keyPool.getSettings();
    config.incognitoMode = nextSettings.incognitoMode;
    config.autoEnsureCodingAgent = nextSettings.autoEnsureCodingAgent;
    config.chatAgentId = nextSettings.chatAgentId;
    config.customAgentPrompt = nextSettings.customAgentPrompt;
    config.sanitizeClientSystemPrompt = nextSettings.sanitizeClientSystemPrompt;
    config.showRoutedModelInThinking = nextSettings.showRoutedModelInThinking;
    config.autoRephraseOnContentFilter = nextSettings.autoRephraseOnContentFilter;
    config.contentFilterRephrasePrompt = nextSettings.contentFilterRephrasePrompt;
    config.contentFilterRephraseModel = nextSettings.contentFilterRephraseModel;
    if (prevSettings.incognitoMode !== nextSettings.incognitoMode) {
      engine.invalidateWarmSessionsAll();
    } else if (
      (prevSettings.chatAgentId || "") !== (nextSettings.chatAgentId || "") ||
      prevSettings.sanitizeClientSystemPrompt !== nextSettings.sanitizeClientSystemPrompt
    ) {
      engine.invalidateWarmSessionsAll({ keepStandby: true });
    }
    sendJson(res, 200, {
      ok: true,
      settings: {
        ...keyPool.getSettings(),
        defaultCustomAgentPrompt: DEFAULT_CODING_AGENT_INSTRUCTIONS,
        defaultContentFilterRephrasePrompt: DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
        defaultContentFilterRephraseModel: DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
      },
    });
    return true;
  }

  if (route === "/v1/admin/affinity/clear" && req.method === "POST") {
    keyPool.clearAffinity();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (route === "/v1/admin/password" && req.method === "POST") {
    const body = await readJsonBody(req, 16_384);
    const newPassword = isRecord(body) && typeof body.newPassword === "string" ? body.newPassword : "";
    const issued = adminAuth.updatePassword(newPassword);
    sendJson(
      res,
      200,
      { ok: true, token: issued.token },
      { extraHeaders: { "set-cookie": adminAuth.buildSetCookieHeader(req, issued.token, issued.maxAgeSeconds) } }
    );
    return true;
  }

  // 6. Request Trace Logs
  if (route === "/v1/admin/logs" && req.method === "GET") {
    sendJson(res, 200, { logs: traceLogger.listSummaries(100) });
    return true;
  }

  if (route === "/v1/admin/logs/clear" && req.method === "POST") {
    traceLogger.clear();
    sendJson(res, 200, { ok: true });
    return true;
  }

  const logDetailMatch = /^\/v1\/admin\/logs\/(req_[a-f0-9]+)$/.exec(route);
  if (logDetailMatch && req.method === "GET") {
    const detail = traceLogger.getDetail(logDetailMatch[1]!);
    if (!detail) throw new GatewayError("Log entry not found.", 404, "not_found");
    sendJson(res, 200, detail);
    return true;
  }

  // 7. Model Access Control
  if (route === "/v1/admin/models" && req.method === "GET") {
    const catalogKey = keyPool.enabledKeyCount() > 0 ? keyPool.peekKeyForCatalog() : "";
    const live = await listLiveModels(catalogKey, ctx.modelListFetcher);
    sendJson(res, 200, {
      models: modelAccess.buildAdminCatalog(live),
      disabledModels: modelAccess.disabledSnapshot()
    });
    return true;
  }

  if (route === "/v1/admin/models/batch" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body) || typeof body.action !== "string") {
      throw new GatewayError("`action` string required.", 400, "invalid_request_error");
    }
    const action = body.action;
    if (action !== "enable" && action !== "disable" && action !== "enable_all" && action !== "set_only_enabled") {
      throw new GatewayError("Unsupported batch action.", 400, "invalid_request_error");
    }
    const models = Array.isArray(body.models) ? body.models.filter((x): x is string => typeof x === "string") : [];
    const allCatalogIds = Array.isArray(body.allCatalogIds)
      ? body.allCatalogIds.filter((x): x is string => typeof x === "string")
      : [];
    const updated = modelAccess.applyBatchUpdate({ action, models, allCatalogIds });
    sendJson(res, 200, { ok: true, ...updated });
    return true;
  }

  // 7.5 Account Groups (Issue #9: single-instance pool isolation)
  if (route === "/v1/admin/groups" && req.method === "GET") {
    sendJson(res, 200, { ok: true, groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()) });
    return true;
  }

  if (route === "/v1/admin/groups" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body) || typeof body.name !== "string") {
      throw new GatewayError("`name` string required.", 400, "invalid_request_error");
    }
    const name = keyPool.createGroup(body.name);
    sendJson(res, 200, {
      ok: true,
      name,
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
    });
    return true;
  }

  const adminGroupMatch = /^\/v1\/admin\/groups\/([^/]+)$/.exec(route);
  if (adminGroupMatch) {
    let rawGroupName: string;
    try {
      rawGroupName = decodeURIComponent(adminGroupMatch[1]!);
    } catch {
      throw new GatewayError("Invalid URL-encoded group name.", 400, "invalid_account_group");
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!isRecord(body) || typeof body.name !== "string") {
        throw new GatewayError("`name` string required.", 400, "invalid_request_error");
      }
      const boundGroups = new Set(clientKeys.countByAccountGroup().keys());
      const renamed = keyPool.renameGroup(rawGroupName, body.name, boundGroups);
      let updatedKeys = 0;
      try {
        updatedKeys = clientKeys.renameAccountGroup(renamed.oldName, renamed.newName);
      } catch (err) {
        if (renamed.oldName !== renamed.newName) {
          try {
            keyPool.renameGroup(renamed.newName, renamed.oldName);
          } catch {
            // Best-effort rollback if pool state cannot be reverted
          }
        }
        throw err;
      }
      sendJson(res, 200, {
        ok: true,
        ...renamed,
        updatedKeys,
        groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
        keyPool: keyPool.statusSnapshot(),
        clientKeys: clientKeys.listKeys(),
      });
      return true;
    }
    if (req.method === "DELETE") {
      const deleted = keyPool.deleteGroup(rawGroupName);
      sendJson(res, 200, {
        ok: true,
        ...deleted,
        groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
        keyPool: keyPool.statusSnapshot(),
      });
      return true;
    }
  }

  // 8. Client Gateway Sub-Keys
  if (route === "/v1/admin/client-keys" && req.method === "GET") {
    sendJson(res, 200, {
      clientKeys: clientKeys.listKeys(),
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
    });
    return true;
  }

  if (route === "/v1/admin/client-keys" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body)) throw new GatewayError("JSON object expected.", 400, "invalid_request_error");
    const lang = resolveAdminLang(req);
    const { view, rawToken } = clientKeys.createKey({
      name: typeof body.name === "string" ? body.name : (lang === "zh" ? "新建子密钥" : "New Sub-Key"),
      customToken: typeof body.customToken === "string" ? body.customToken : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
      allowAllModels: typeof body.allowAllModels === "boolean" ? body.allowAllModels : true,
      allowedModels: Array.isArray(body.allowedModels)
        ? body.allowedModels.filter((x): x is string => typeof x === "string")
        : [],
      accountGroup:
        body.accountGroup === null
          ? null
          : typeof body.accountGroup === "string"
            ? body.accountGroup
            : undefined,
      maxRequests: body.maxRequests,
      maxConcurrent: body.maxConcurrent,
      expiresAt: body.expiresAt
    });
    if (view.accountGroup) {
      keyPool.createGroup(view.accountGroup);
    }
    sendJson(res, 200, {
      ok: true,
      key: view,
      rawToken,
      clientKeys: clientKeys.listKeys(),
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
    });
    return true;
  }

  const clientKeyRevealMatch = /^\/v1\/admin\/client-keys\/(gk_[a-f0-9]+)\/reveal$/.exec(route);
  if (clientKeyRevealMatch && req.method === "GET") {
    const token = clientKeys.revealKeyToken(clientKeyRevealMatch[1]!);
    sendJson(res, 200, { ok: true, token });
    return true;
  }

  const clientKeyMatch = /^\/v1\/admin\/client-keys\/(gk_[a-f0-9]+)$/.exec(route);
  if (clientKeyMatch) {
    const keyId = clientKeyMatch[1]!;
    if (req.method === "DELETE") {
      const { source } = clientKeys.deleteKey(keyId);
      sendJson(res, 200, {
        ok: true,
        source,
        clientKeys: clientKeys.listKeys(),
        groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
      });
      return true;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!isRecord(body)) throw new GatewayError("JSON object expected.", 400, "invalid_request_error");
      const prevGroup = clientKeys.listKeys().find((k) => k.id === keyId)?.accountGroup ?? null;
      const updated = clientKeys.updateKey(keyId, {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.allowAllModels === "boolean" ? { allowAllModels: body.allowAllModels } : {}),
        ...(Array.isArray(body.allowedModels)
          ? { allowedModels: body.allowedModels.filter((x): x is string => typeof x === "string") }
          : {}),
        ...(body.accountGroup === null || typeof body.accountGroup === "string"
          ? { accountGroup: body.accountGroup }
          : {}),
        ...(body.maxRequests !== undefined ? { maxRequests: body.maxRequests } : {}),
        ...(body.maxConcurrent !== undefined ? { maxConcurrent: body.maxConcurrent } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        ...(body.resetRequests === true ? { resetRequests: true } : {})
      });
      if (typeof body.accountGroup === "string" && updated.accountGroup && updated.accountGroup !== prevGroup) {
        keyPool.createGroup(updated.accountGroup);
      }
      sendJson(res, 200, {
        ok: true,
        key: updated,
        clientKeys: clientKeys.listKeys(),
        groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
      });
      return true;
    }
  }

  // 9. Playground & Upstream AWS Quick Key Pool
  if (route === "/v1/admin/playground" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body) || typeof body.prompt !== "string") {
      throw new GatewayError("`prompt` string required.", 400, "invalid_request_error");
    }
    const chatBody = {
      model: typeof body.model === "string" ? body.model : "quick-balanced",
      stream: false,
      messages: [{ role: "user", content: body.prompt }]
    };
    const turn = openAiChatAdapter.parse(chatBody, {}, abortSignal);
    if (!resolveKnownModelId(turn.requestedModel)) {
      throw new GatewayError(`Model '${turn.requestedModel}' not found.`, 404, "model_not_found", "model");
    }
    turn.scope = "admin_playground";
    const lang = resolveAdminLang(req);
    const traceId = traceLogger.startTrace("playground", turn, { keyName: lang === "zh" ? "后台拨测台" : "Playground" });
    const rawEvents = engine.executeTurnWithPool(
      turn,
      keyPool,
      (meta) => traceLogger.bindExecutionMeta(traceId, meta)
    );
    const events = ctx.tapStreamWithTrace(rawEvents, traceId);
    const json = await openAiChatAdapter.collectJson(events, turn);
    sendJson(res, 200, json);
    return true;
  }

  const scheduleEagerEnsureAgents = (slotIds: string[]): void => {
    if (!keyPool.getSettings().autoEnsureCodingAgent || slotIds.length === 0) return;
    const managedMap = new Map(keyPool.allManagedKeys().map((k) => [k.slotId, k]));
    const queue = Array.from(new Set(slotIds))
      .map((id) => managedMap.get(id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m && m.enabled && !m.chatAgentId));
    if (queue.length === 0) return;
    const maxConc = 3;
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      while (cursor < queue.length) {
        const target = queue[cursor++]!;
        await engine.ensureCodingAgentForKey(target.rawKey, target.slotId, keyPool, target.proxyUrl).catch(() => undefined);
      }
    };
    for (let i = 0; i < Math.min(maxConc, queue.length); i += 1) {
      void runNext();
    }
  };

  if (route === "/v1/admin/keys" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body) || typeof body.apiKey !== "string") {
      throw new GatewayError("`apiKey` string required.", 400, "invalid_request_error");
    }
    const enabled = body.enabled !== false;
    const label = typeof body.label === "string" ? body.label : undefined;
    const proxyUrl = typeof body.proxyUrl === "string" ? body.proxyUrl : undefined;
    const chatAgentId = typeof body.chatAgentId === "string" ? body.chatAgentId : undefined;
    const group = body.group === null ? null : typeof body.group === "string" ? body.group : undefined;
    const slot = keyPool.addKey(body.apiKey, enabled, label, proxyUrl, chatAgentId, group);
    if (enabled) {
      await ctx.syncKeyQuotas({ includeDisabled: false }).catch(() => undefined);
      scheduleEagerEnsureAgents([slot.slotId]);
    }
    sendJson(res, 200, {
      ok: true,
      slot,
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
      keyPool: keyPool.statusSnapshot(),
    });
    return true;
  }

  if (route === "/v1/admin/keys/export" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const slotIds =
      isRecord(body) && Array.isArray(body.slotIds)
        ? new Set(body.slotIds.filter((x): x is string => typeof x === "string"))
        : null;
    const all = keyPool.allManagedKeys();
    const picked = slotIds && slotIds.size > 0 ? all.filter((k) => slotIds.has(k.slotId)) : all;
    sendJson(res, 200, {
      ok: true,
      exportedAt: new Date().toISOString(),
      version: 1,
      credentials: picked.map((k) => ({
        apiKey: k.rawKey,
        enabled: k.enabled,
        ...(k.label ? { label: k.label } : {}),
        ...(k.group ? { group: k.group } : {}),
        ...(k.proxyUrl ? { proxyUrl: k.proxyUrl } : {}),
        ...(k.chatAgentId ? { chatAgentId: k.chatAgentId } : {}),
      })),
    });
    return true;
  }

  if (route === "/v1/admin/keys/import-json" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const rawList = Array.isArray(body)
      ? body
      : isRecord(body) && Array.isArray(body.credentials)
        ? body.credentials
        : null;
    if (!rawList || rawList.length === 0) {
      throw new GatewayError("`credentials` array required.", 400, "invalid_request_error");
    }
    let imported = 0;
    const importedSlotIds: string[] = [];
    for (const item of rawList) {
      if (!isRecord(item) || typeof item.apiKey !== "string" || !item.apiKey.trim()) continue;
      const added = keyPool.addKey(
        item.apiKey,
        item.enabled !== false,
        typeof item.label === "string" ? item.label : undefined,
        typeof item.proxyUrl === "string" ? item.proxyUrl : undefined,
        typeof item.chatAgentId === "string" ? item.chatAgentId : undefined,
        typeof item.group === "string" ? item.group : undefined,
      );
      if (added.enabled && !added.chatAgentId) importedSlotIds.push(added.slotId);
      imported += 1;
    }
    if (imported === 0) {
      throw new GatewayError("No valid credentials found in JSON payload.", 400, "invalid_request_error");
    }
    await ctx.syncKeyQuotas({ includeDisabled: false }).catch(() => undefined);
    scheduleEagerEnsureAgents(importedSlotIds);
    sendJson(res, 200, {
      ok: true,
      imported,
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
      keyPool: keyPool.statusSnapshot(),
    });
    return true;
  }

  if (route === "/v1/admin/keys/batch" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body) || typeof body.action !== "string" || !Array.isArray(body.slotIds)) {
      throw new GatewayError("`action` and `slotIds` array required.", 400, "invalid_request_error");
    }
    const action = body.action;
    if (action !== "enable" && action !== "disable" && action !== "delete" && action !== "recheck" && action !== "set-group") {
      throw new GatewayError("Unsupported batch action.", 400, "invalid_request_error");
    }
    const ids = body.slotIds.filter((x): x is string => typeof x === "string");
    if (action === "set-group") {
      if (body.group !== null && typeof body.group !== "string") {
        throw new GatewayError("`group` must be a string or null.", 400, "invalid_account_group");
      }
      const normalizedTarget = normalizeAccountGroup(body.group) ?? null;
      let affected = 0;
      for (const id of ids) {
        try {
          keyPool.updateSlotMeta(id, { group: normalizedTarget });
          affected += 1;
        } catch (err) {
          if (err instanceof GatewayError && err.code === "invalid_account_group") throw err;
          // skip missing slotId
        }
      }
      sendJson(res, 200, {
        ok: true,
        affected,
        groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
        keyPool: keyPool.statusSnapshot(),
      });
      return true;
    }
    if (action === "recheck") {
      const validIds: string[] = [];
      for (const id of ids) {
        try {
          keyPool.recheckSlot(id);
          validIds.push(id);
        } catch {
          // skip missing slotId
        }
      }
      const reports = validIds.length
        ? await ctx.syncKeyQuotas({ includeDisabled: true, forceRefresh: true, slotIds: validIds }).catch(() => [] as AccountQuotaReport[])
        : [];
      const lang = resolveAdminLang(req);
      for (const id of validIds) {
        const target = keyPool.allManagedKeys().find((k) => k.slotId === id);
        if (!target) continue;
        const masked = keyPool.statusSnapshot().find((s) => s.slotId === id)?.maskedKey;
        const mine = reports.find((r) => r.maskedKey === masked);
        if (mine?.status === "error" && /HTTP (401|403)\b/.test(mine.error ?? "")) {
          keyPool.reportAuthFailure(
            target.rawKey,
            lang === "zh" ? "重新检测仍被上游拒绝" : "Recheck rejected by upstream (401/403)."
          );
        }
      }
      const snap = keyPool.statusSnapshot();
      const checked = snap.filter((s) => validIds.includes(s.slotId));
      const okCount = checked.filter((s) => s.enabled && !s.lastSyncError).length;
      const failedCount = checked.length - okCount;
      sendJson(res, 200, {
        ok: true,
        affected: validIds.length,
        okCount,
        failedCount,
        reports,
        groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
        keyPool: snap,
      });
      return true;
    }
    let affected = 0;
    for (const id of ids) {
      try {
        if (action === "delete") {
          keyPool.removeKey(id);
          engine.invalidateWarmSessionsForSlot(id);
        } else {
          keyPool.updateSlotMeta(id, { enabled: action === "enable" });
          if (action === "disable") engine.invalidateWarmSessionsForSlot(id);
        }
        affected += 1;
      } catch {
        // skip missing slotId
      }
    }
    if (action === "enable" && affected > 0) {
      await ctx.syncKeyQuotas({ includeDisabled: false }).catch(() => undefined);
    }
    sendJson(res, 200, {
      ok: true,
      affected,
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
      keyPool: keyPool.statusSnapshot(),
    });
    return true;
  }

  if (route === "/v1/admin/oauth/discovery-url" && req.method === "GET") {
    const disc = buildOAuthDiscoveryUrl(18080, {
      onCompleted: (oauthCred) => {
        try {
          const nextNum = keyPool.allManagedKeys().length + 1;
          const autoLabel = oauthCred.email || (oauthCred.accountId ? `AWS #${oauthCred.accountId.slice(-4)}` : `Account #${nextNum}`);
          const added = keyPool.addKey(serializeOAuthCredential(oauthCred), true, autoLabel);
          void ctx.syncKeyQuotas({ includeDisabled: false }).catch(() => undefined);
          scheduleEagerEnsureAgents([added.slotId]);
        } catch { }
      },
    });
    sendJson(res, 200, { ok: true, ...disc });
    return true;
  }

  if (route === "/v1/admin/oauth/start" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body)) {
      throw new GatewayError("JSON object expected.", 400, "invalid_request_error");
    }
    const discoveryCallbackUrl =
      typeof body.discoveryCallbackUrl === "string" && body.discoveryCallbackUrl.trim()
        ? body.discoveryCallbackUrl.trim()
        : undefined;
    const issuerUrl = typeof body.issuerUrl === "string" && body.issuerUrl.trim() ? body.issuerUrl.trim() : undefined;
    const wsHost = typeof body.wsHost === "string" && body.wsHost.trim() ? body.wsHost.trim() : undefined;
    const region = typeof body.region === "string" && body.region.trim() ? body.region.trim() : undefined;
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined;
    const proxyUrl = typeof body.proxyUrl === "string" && body.proxyUrl.trim() ? body.proxyUrl.trim() : undefined;
    const chatAgentId = typeof body.chatAgentId === "string" && body.chatAgentId.trim() ? body.chatAgentId.trim() : undefined;
    const started = await startOAuthPkceFlow({
      ...(discoveryCallbackUrl ? { discoveryCallbackUrl } : {}),
      ...(issuerUrl ? { issuerUrl } : {}),
      ...(wsHost ? { wsHost } : {}),
      ...(region ? { region } : {}),
      ...(proxyUrl ? { proxyUrl } : {}),
      onCompleted: (oauthCred) => {
        try {
          const nextNum = keyPool.allManagedKeys().length + 1;
          const autoLabel = oauthCred.email || (oauthCred.accountId ? `AWS #${oauthCred.accountId.slice(-4)}` : `Account #${nextNum}`);
          const added = keyPool.addKey(
            serializeOAuthCredential(oauthCred),
            true,
            label || autoLabel,
            proxyUrl,
            chatAgentId,
          );
          void ctx.syncKeyQuotas({ includeDisabled: false }).catch(() => undefined);
          scheduleEagerEnsureAgents([added.slotId]);
        } catch { }
      },
    });
    sendJson(res, 200, { ok: true, ...started });
    return true;
  }

  if (route === "/v1/admin/oauth/status" && req.method === "GET") {
    const flowId = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("flowId") || "";
    const status = getOAuthFlowStatus(flowId);
    sendJson(res, 200, { ok: true, ...status, ...(status.status === "completed" ? { keyPool: keyPool.statusSnapshot() } : {}) });
    return true;
  }

  if (route === "/v1/admin/oauth/complete" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body) || typeof body.flowId !== "string" || typeof body.callbackUrl !== "string") {
      throw new GatewayError("`flowId` and `callbackUrl` strings are required.", 400, "invalid_request_error");
    }
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined;
    const proxyUrl = typeof body.proxyUrl === "string" && body.proxyUrl.trim() ? body.proxyUrl.trim() : undefined;
    const chatAgentId = typeof body.chatAgentId === "string" && body.chatAgentId.trim() ? body.chatAgentId.trim() : undefined;
    const oauthCred = await completeOAuthPkceCallback(body.flowId, body.callbackUrl);
    const nextNum = keyPool.allManagedKeys().length + 1;
    const autoLabel = oauthCred.email || (oauthCred.accountId ? `AWS #${oauthCred.accountId.slice(-4)}` : `Account #${nextNum}`);
    const slot = keyPool.addKey(
      serializeOAuthCredential(oauthCred),
      true,
      label || autoLabel,
      proxyUrl,
      chatAgentId,
    );
    await ctx.syncKeyQuotas({ includeDisabled: false }).catch(() => undefined);
    scheduleEagerEnsureAgents([slot.slotId]);
    sendJson(res, 200, { ok: true, slot, keyPool: keyPool.statusSnapshot() });
    return true;
  }

  const listCloudSessionsForTarget = async (target: ReturnType<typeof keyPool.allManagedKeys>[number]) => {
    const cred = parseQuickCredential(target.rawKey);
    if (cred.mode === "oauth" && cred.oauth) {
      return listOAuthCloudSessions(cred.oauth, 100, target.proxyUrl);
    }
    if (cred.mode === "web" && cred.web) {
      return listWebCloudSessions(cred.web, 100, target.proxyUrl);
    }
    return withSharedOutpostLock(async (outpost) => {
      if (cred.mode === "token" && cred.jwt) {
        outpost.setImportedToken({ jwt: cred.jwt, wsHost: cred.wsHost, outpostId: cred.outpostId });
      } else {
        outpost.setImportedToken(null);
      }
      return outpost.listCloudSessions(100);
    });
  };

  const listCloudMatch = /^\/v1\/admin\/keys\/([a-f0-9]+)\/cloud-sessions$/.exec(route);
  if (listCloudMatch && req.method === "GET") {
    const slotId = listCloudMatch[1]!;
    const target = keyPool.allManagedKeys().find((k) => k.slotId === slotId);
    if (!target) throw new GatewayError(`Key slot '${slotId}' not found.`, 404, "not_found");
    const sessions = await listCloudSessionsForTarget(target);
    keyPool.updateSlotQuotaCache(target.rawKey, undefined, undefined, undefined, {
      cloudSessionCount: sessions.length,
    });
    sendJson(res, 200, { ok: true, count: sessions.length, sessions });
    return true;
  }

  const clearCloudForTarget = async (target: ReturnType<typeof keyPool.allManagedKeys>[number]) => {
    const list = await listCloudSessionsForTarget(target);
    const deleted = await engine.deleteCloudSessionsForKey(target.rawKey, list.map((s) => s.id), target.proxyUrl);
    const remaining = Math.max(0, list.length - deleted.length);
    keyPool.updateSlotQuotaCache(target.rawKey, undefined, undefined, undefined, {
      cloudSessionCount: remaining,
    });
    return { deleted: deleted.length, remaining };
  };

  if (route === "/v1/admin/keys/clear-cloud-sessions" && req.method === "POST") {
    const body = (await readJsonBody(req, config.maxBodyBytes)) as { slotIds?: string[] };
    const requestedIds = Array.isArray(body?.slotIds)
      ? body.slotIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const allKeys = keyPool.allManagedKeys();
    const targets = requestedIds.length > 0
      ? allKeys.filter((k) => requestedIds.includes(k.slotId))
      : allKeys;
    const settled: Array<PromiseSettledResult<{ slotId: string; label: string; deleted: number; remaining: number }>> =
      new Array(targets.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (cursor < targets.length) {
        const idx = cursor++;
        const target = targets[idx]!;
        try {
          const r = await clearCloudForTarget(target);
          settled[idx] = { status: "fulfilled", value: { slotId: target.slotId, label: target.label || target.slotId, ...r } };
        } catch (reason) {
          settled[idx] = { status: "rejected", reason };
        }
      }
    });
    await Promise.all(workers);
    let totalDeleted = 0;
    let okCount = 0;
    let failedCount = 0;
    const results = settled.map((item, idx) => {
      const target = targets[idx]!;
      if (item.status === "fulfilled") {
        okCount += 1;
        totalDeleted += item.value.deleted;
        return { ...item.value, status: "ok" as const };
      }
      failedCount += 1;
      return {
        slotId: target.slotId,
        label: target.label || target.slotId,
        deleted: 0,
        remaining: 0,
        status: "error" as const,
        error: item.reason instanceof Error ? item.reason.message : String(item.reason),
      };
    });
    sendJson(res, 200, {
      ok: true,
      totalDeleted,
      okCount,
      failedCount,
      results,
      keyPool: keyPool.statusSnapshot(),
    });
    return true;
  }

  const clearCloudMatch = /^\/v1\/admin\/keys\/([a-f0-9]+)\/clear-cloud-sessions$/.exec(route);
  if (clearCloudMatch && req.method === "POST") {
    const slotId = clearCloudMatch[1]!;
    const target = keyPool.allManagedKeys().find((k) => k.slotId === slotId);
    if (!target) throw new GatewayError(`Key slot '${slotId}' not found.`, 404, "not_found");
    const r = await clearCloudForTarget(target);
    sendJson(res, 200, { ok: true, deleted: r.deleted, remaining: r.remaining, keyPool: keyPool.statusSnapshot() });
    return true;
  }

  const recheckMatch = /^\/v1\/admin\/keys\/([a-f0-9]+)\/recheck$/.exec(route);
  if (recheckMatch && req.method === "POST") {
    const slotId = recheckMatch[1]!;
    const target = keyPool.allManagedKeys().find((k) => k.slotId === slotId);
    if (!target) throw new GatewayError("Key slot not found.", 404, "not_found");
    keyPool.recheckSlot(slotId);
    const reports = await ctx.syncKeyQuotas({ includeDisabled: false, forceRefresh: true, slotIds: [slotId] }).catch(() => [] as AccountQuotaReport[]);
    const masked = keyPool.statusSnapshot().find((s) => s.slotId === slotId)?.maskedKey;
    const mine = reports.find((r) => r.maskedKey === masked);
    // A rejected key is tripped again right away so the console shows the real reason instead of "enabled".
    if (mine?.status === "error" && /HTTP (401|403)\b/.test(mine.error ?? "")) {
      const lang = resolveAdminLang(req);
      keyPool.reportAuthFailure(
        target.rawKey,
        lang === "zh" ? "重新检测仍被上游拒绝" : "Recheck rejected by upstream (401/403)."
      );
    }
    const status = keyPool.statusSnapshot().find((s) => s.slotId === slotId);
    sendJson(res, 200, {
      ok: true,
      recovered: Boolean(status?.enabled),
      slot: status,
      groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
      keyPool: keyPool.statusSnapshot(),
    });
    return true;
  }

  if (route === "/v1/admin/keys/sync-agents" && req.method === "POST") {
    const rawBody = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(rawBody)) {
      throw new GatewayError("JSON object expected.", 400, "invalid_request_error");
    }
    const body = rawBody as {
      slotIds?: string[];
      mode?: string;
      name?: string;
      description?: string;
      instructions?: string;
      setAsDefault?: boolean;
    };
    const requestedIds = Array.isArray(body?.slotIds)
      ? body.slotIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const syncMode: "create" | "upgrade" = body?.mode === "upgrade" ? "upgrade" : "create";
    const syncName = typeof body?.name === "string" ? body.name.trim() : "";
    const syncDesc = typeof body?.description === "string" ? body.description.trim() : "";
    const syncInstructions = typeof body?.instructions === "string" ? body.instructions.trim() : "";
    const setAsDefault = body?.setAsDefault !== false;

    if (syncName.length > 120) {
      throw new GatewayError("Agent `name` must be 120 characters or fewer.", 400, "invalid_request_error");
    }
    if (syncDesc.length > 500) {
      throw new GatewayError("Agent `description` must be 500 characters or fewer.", 400, "invalid_request_error");
    }
    if (syncInstructions.length > 16_000) {
      throw new GatewayError("Agent `instructions` must be 16,000 characters or fewer.", 400, "invalid_request_error");
    }

    const allKeys = keyPool.allManagedKeys();
    const targets =
      requestedIds.length > 0
        ? allKeys.filter((k) => requestedIds.includes(k.slotId))
        : allKeys.filter((k) => k.enabled);

    const settled: Array<
      PromiseSettledResult<{
        slotId: string;
        label: string;
        agentId: string;
        name: string;
        action: "upgraded" | "created" | "unchanged";
        boundAsDefault: boolean;
        previousName?: string;
      }>
    > = new Array(targets.length);

    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, targets.length) }, async () => {
      while (cursor < targets.length) {
        const idx = cursor++;
        const target = targets[idx]!;
        try {
          const synced = await engine.syncCodingAgentForKey(
            target.rawKey,
            target.slotId,
            keyPool,
            target.proxyUrl,
            {
              mode: syncMode,
              ...(syncName ? { name: syncName } : {}),
              ...(syncDesc ? { description: syncDesc } : {}),
              ...(syncInstructions ? { instructions: syncInstructions } : {}),
              setAsDefault,
            },
          );
          settled[idx] = {
            status: "fulfilled",
            value: {
              slotId: target.slotId,
              label: target.label || target.slotId,
              ...synced,
            },
          };
        } catch (reason) {
          settled[idx] = { status: "rejected", reason };
        }
      }
    });
    await Promise.all(workers);

    let upgraded = 0;
    let created = 0;
    let unchanged = 0;
    let failedCount = 0;
    const results = settled.map((item, idx) => {
      const target = targets[idx]!;
      if (item.status === "fulfilled") {
        if (item.value.action === "upgraded") upgraded += 1;
        else if (item.value.action === "created") created += 1;
        else unchanged += 1;
        return { ...item.value, status: "ok" as const };
      }
      failedCount += 1;
      return {
        slotId: target.slotId,
        label: target.label || target.slotId,
        status: "error" as const,
        error: item.reason instanceof Error ? item.reason.message : String(item.reason),
      };
    });

    sendJson(res, 200, {
      ok: true,
      mode: syncMode,
      setAsDefault,
      total: targets.length,
      upgraded,
      created,
      unchanged,
      failedCount,
      results,
      keyPool: keyPool.statusSnapshot(),
    });
    return true;
  }

  const listAgentsMatch = /^\/v1\/admin\/keys\/([a-f0-9]+)\/agents$/.exec(route);
  if (listAgentsMatch && req.method === "GET") {
    const slotId = listAgentsMatch[1]!;
    const target = keyPool.allManagedKeys().find((k) => k.slotId === slotId);
    if (!target) throw new GatewayError(`Key slot '${slotId}' not found.`, 404, "not_found");
    const agents = await engine.listChatAgentsForKey(target.rawKey, target.proxyUrl);
    sendJson(res, 200, {
      ok: true,
      slotId,
      boundAgentId: target.chatAgentId || "",
      agents,
    });
    return true;
  }

  const ensureAgentMatch = /^\/v1\/admin\/keys\/([a-f0-9]+)\/agents\/ensure$/.exec(route);
  if (ensureAgentMatch && req.method === "POST") {
    const slotId = ensureAgentMatch[1]!;
    const target = keyPool.allManagedKeys().find((k) => k.slotId === slotId);
    if (!target) throw new GatewayError(`Key slot '${slotId}' not found.`, 404, "not_found");
    const body = await readJsonBody(req, 16_384);
    if (!isRecord(body)) {
      throw new GatewayError("JSON object expected.", 400, "invalid_request_error");
    }
    const upgrade = isRecord(body) && body.upgrade === true;
    if (upgrade) {
      const synced = await engine.syncCodingAgentForKey(
        target.rawKey,
        slotId,
        keyPool,
        target.proxyUrl,
        {
          mode: body.mode === "create" ? "create" : "upgrade",
          ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : {}),
          ...(typeof body.description === "string" && body.description.trim()
            ? { description: body.description.trim() }
            : {}),
          ...(typeof body.instructions === "string" && body.instructions.trim()
            ? { instructions: body.instructions.trim() }
            : {}),
          setAsDefault: body.setAsDefault !== false,
        },
      );
      const agents = await engine.listChatAgentsForKey(target.rawKey, target.proxyUrl).catch(() => []);
      sendJson(res, 200, {
        ok: true,
        slotId,
        chatAgentId: synced.agentId,
        action: synced.action,
        boundAsDefault: synced.boundAsDefault,
        ...(synced.previousName ? { previousName: synced.previousName } : {}),
        agents,
        keyPool: keyPool.statusSnapshot(),
      });
      return true;
    }
    const forceCreate = isRecord(body) && body.forceCreate === true;
    const chatAgentId = await engine.ensureCodingAgentForKey(
      target.rawKey,
      slotId,
      keyPool,
      target.proxyUrl,
      { forceCreate },
    );
    if (!chatAgentId) {
      throw new GatewayError(
        "Failed to list or create a custom AWS Quick agent for this credential.",
        502,
        "upstream_error",
      );
    }
    const agents = await engine.listChatAgentsForKey(target.rawKey, target.proxyUrl).catch(() => []);
    sendJson(res, 200, {
      ok: true,
      slotId,
      chatAgentId,
      agents,
      keyPool: keyPool.statusSnapshot(),
    });
    return true;
  }

  const updateAgentMatch = /^\/v1\/admin\/keys\/([a-f0-9]+)\/agents\/update$/.exec(route);
  if (updateAgentMatch && req.method === "POST") {
    const slotId = updateAgentMatch[1]!;
    const target = keyPool.allManagedKeys().find((k) => k.slotId === slotId);
    if (!target) throw new GatewayError(`Key slot '${slotId}' not found.`, 404, "not_found");
    const body = await readJsonBody(req, 32_768);
    if (!isRecord(body) || typeof body.agentId !== "string" || typeof body.instructions !== "string") {
      throw new GatewayError("`agentId` and `instructions` strings are required.", 400, "invalid_request_error");
    }
    if (typeof body.name === "string" && body.name.trim().length > 120) {
      throw new GatewayError("Agent `name` must be 120 characters or fewer.", 400, "invalid_request_error");
    }
    if (typeof body.description === "string" && body.description.trim().length > 500) {
      throw new GatewayError("Agent `description` must be 500 characters or fewer.", 400, "invalid_request_error");
    }
    if (body.instructions.trim().length > 16_000) {
      throw new GatewayError("Agent `instructions` must be 16,000 characters or fewer.", 400, "invalid_request_error");
    }
    const updated = await engine.updateAndPublishAgentForKey(
      target.rawKey,
      body.agentId,
      {
        instructions: body.instructions,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
      },
      target.proxyUrl,
    );
    if (body.setAsDefault === true) {
      keyPool.updateSlotMeta(slotId, { chatAgentId: updated.agentId });
    }
    // Always invalidate warm sessions for this slot so active threads pick up the newly published instructions/agentId immediately
    // while keeping healthy standby sockets open (`session_connect` does not bind `chat_agent_id`).
    engine.invalidateWarmSessionsForSlot(slotId, { keepStandby: true });
    const agents = await engine.listChatAgentsForKey(target.rawKey, target.proxyUrl).catch(() => []);
    sendJson(res, 200, {
      ok: true,
      slotId,
      agentId: updated.agentId,
      agents,
      keyPool: keyPool.statusSnapshot(),
    });
    return true;
  }

  const adminKeyMatch = /^\/v1\/admin\/keys\/([a-f0-9]+)$/.exec(route);
  if (adminKeyMatch) {
    const slotId = adminKeyMatch[1]!;
    if (req.method === "DELETE") {
      keyPool.removeKey(slotId);
      engine.invalidateWarmSessionsForSlot(slotId);
      sendJson(res, 200, {
        ok: true,
        groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
        keyPool: keyPool.statusSnapshot(),
      });
      return true;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!isRecord(body)) throw new GatewayError("JSON object expected.", 400, "invalid_request_error");
      const before = keyPool.allManagedKeys().find((k) => k.slotId === slotId);
      keyPool.updateSlotMeta(slotId, {
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        ...(body.group === null || typeof body.group === "string" ? { group: body.group } : {}),
        ...(typeof body.proxyUrl === "string" ? { proxyUrl: body.proxyUrl } : {}),
        ...(typeof body.chatAgentId === "string" ? { chatAgentId: body.chatAgentId } : {}),
        ...(body.clearCooldown === true ? { clearCooldown: true } : {})
      });
      const after = keyPool.allManagedKeys().find((k) => k.slotId === slotId);
      const proxyChanged = !before || !after || (before.proxyUrl || "") !== (after.proxyUrl || "");
      const disabledNow = Boolean(before && after && before.enabled && !after.enabled);
      if (proxyChanged || disabledNow) {
        engine.invalidateWarmSessionsForSlot(slotId);
      } else if (
        (before.chatAgentId || "") !== (after.chatAgentId || "") ||
        (before.group || "") !== (after.group || "")
      ) {
        engine.invalidateWarmSessionsForSlot(slotId, { keepStandby: true });
      }
      sendJson(res, 200, {
        ok: true,
        groups: keyPool.listGroupSummaries(clientKeys.countByAccountGroup()),
        keyPool: keyPool.statusSnapshot(),
      });
      return true;
    }
  }

  return false;
}
