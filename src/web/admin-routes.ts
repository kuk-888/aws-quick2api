import crypto from "node:crypto";
import type http from "node:http";
import {
  buildOAuthDiscoveryUrl,
  completeOAuthPkceCallback,
  getOAuthFlowStatus,
  listOAuthCloudSessions,
  serializeOAuthCredential,
  startOAuthPkceFlow,
} from "../aws-quick/oauth-client.js";
import { getSharedOutpost, parseQuickCredential } from "../aws-quick/outpost-singleton.js";
import { listWebCloudSessions } from "../aws-quick/web-client.js";
import type { SDKModel } from "../aws-quick/types.js";
import {
  DEFAULT_CODING_AGENT_INSTRUCTIONS,
  DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
  DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
  type QuickExecutionEngine,
} from "../core/engine.js";
import type { PoolRoutingSettings, UpstreamKeyPool } from "../core/key-pool.js";
import { GatewayError, type GatewayConfig, type GatewayStreamEvent } from "../core/types.js";
import { isRecord } from "../protocols/common.js";
import { openAiChatAdapter } from "../protocols/openai.js";
import type { ClientGatewayKeyManager } from "../services/client-keys.js";
import type { ModelAccessController } from "../services/model-access.js";
import { listLiveModels } from "../services/model-catalog.js";
import type { UsageLedger, LedgerRange } from "../services/usage-ledger.js";
import type { AccountQuotaReport } from "../services/quota-service.js";
import type { RequestTraceLogger } from "../services/request-logger.js";
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
    sendJson(res, 200, { ok: true, ...info });
    return true;
  }

  if (route === "/v1/admin/overview" && req.method === "GET") {
    adminAuth.requireAdminAuth(req, extractClientCredential(req));
    const r = new URL(req.url || "/", "http://localhost").searchParams.get("range");
    const range: LedgerRange = r === "7d" || r === "30d" ? r : "today";
    sendJson(res, 200, {
      object: "gateway.overview",
      ...ctx.usageLedger.overview(range),
      ipRecorded: config.recordClientIp !== false,
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
      settings: keyPool.getSettings(),
      runtime: engine.runtimeStats(),
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
      config.incognitoMode = body.incognitoMode;
    }
    if (typeof body.autoEnsureCodingAgent === "boolean") {
      patch.autoEnsureCodingAgent = body.autoEnsureCodingAgent;
      config.autoEnsureCodingAgent = body.autoEnsureCodingAgent;
    }
    if (typeof body.customAgentPrompt === "string") {
      patch.customAgentPrompt = body.customAgentPrompt;
    }
    if (typeof body.autoRephraseOnContentFilter === "boolean") {
      patch.autoRephraseOnContentFilter = body.autoRephraseOnContentFilter;
      config.autoRephraseOnContentFilter = body.autoRephraseOnContentFilter;
    }
    if (typeof body.contentFilterRephrasePrompt === "string") {
      patch.contentFilterRephrasePrompt = body.contentFilterRephrasePrompt;
    }
    if (body.contentFilterRephraseModel === "quick-fast" || body.contentFilterRephraseModel === "quick-balanced") {
      patch.contentFilterRephraseModel = body.contentFilterRephraseModel;
      config.contentFilterRephraseModel = body.contentFilterRephraseModel;
    }
    if (typeof body.chatAgentId === "string") {
      patch.chatAgentId = body.chatAgentId;
    }
    keyPool.updateSettings(patch);
    config.chatAgentId = keyPool.getSettings().chatAgentId;
    config.customAgentPrompt = keyPool.getSettings().customAgentPrompt;
    config.autoRephraseOnContentFilter = keyPool.getSettings().autoRephraseOnContentFilter;
    config.contentFilterRephrasePrompt = keyPool.getSettings().contentFilterRephrasePrompt;
    config.contentFilterRephraseModel = keyPool.getSettings().contentFilterRephraseModel;
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

  // 8. Client Gateway Sub-Keys
  if (route === "/v1/admin/client-keys" && req.method === "GET") {
    sendJson(res, 200, { clientKeys: clientKeys.listKeys() });
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
      maxRequests: body.maxRequests,
      maxConcurrent: body.maxConcurrent,
      expiresAt: body.expiresAt
    });
    sendJson(res, 200, { ok: true, key: view, rawToken, clientKeys: clientKeys.listKeys() });
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
      sendJson(res, 200, { ok: true, source, clientKeys: clientKeys.listKeys() });
      return true;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!isRecord(body)) throw new GatewayError("JSON object expected.", 400, "invalid_request_error");
      const updated = clientKeys.updateKey(keyId, {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.allowAllModels === "boolean" ? { allowAllModels: body.allowAllModels } : {}),
        ...(Array.isArray(body.allowedModels)
          ? { allowedModels: body.allowedModels.filter((x): x is string => typeof x === "string") }
          : {}),
        ...(body.maxRequests !== undefined ? { maxRequests: body.maxRequests } : {}),
        ...(body.maxConcurrent !== undefined ? { maxConcurrent: body.maxConcurrent } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        ...(body.resetRequests === true ? { resetRequests: true } : {})
      });
      sendJson(res, 200, { ok: true, key: updated, clientKeys: clientKeys.listKeys() });
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
    const slot = keyPool.addKey(body.apiKey, enabled, label, proxyUrl, chatAgentId);
    if (enabled) {
      await ctx.syncKeyQuotas({ includeDisabled: false }).catch(() => undefined);
      scheduleEagerEnsureAgents([slot.slotId]);
    }
    sendJson(res, 200, { ok: true, slot, keyPool: keyPool.statusSnapshot() });
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
      );
      if (added.enabled && !added.chatAgentId) importedSlotIds.push(added.slotId);
      imported += 1;
    }
    if (imported === 0) {
      throw new GatewayError("No valid credentials found in JSON payload.", 400, "invalid_request_error");
    }
    await ctx.syncKeyQuotas({ includeDisabled: false }).catch(() => undefined);
    scheduleEagerEnsureAgents(importedSlotIds);
    sendJson(res, 200, { ok: true, imported, keyPool: keyPool.statusSnapshot() });
    return true;
  }

  if (route === "/v1/admin/keys/batch" && req.method === "POST") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!isRecord(body) || typeof body.action !== "string" || !Array.isArray(body.slotIds)) {
      throw new GatewayError("`action` and `slotIds` array required.", 400, "invalid_request_error");
    }
    const action = body.action;
    if (action !== "enable" && action !== "disable" && action !== "delete" && action !== "recheck") {
      throw new GatewayError("Unsupported batch action.", 400, "invalid_request_error");
    }
    const ids = body.slotIds.filter((x): x is string => typeof x === "string");
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
      sendJson(res, 200, { ok: true, affected: validIds.length, okCount, failedCount, reports, keyPool: snap });
      return true;
    }
    let affected = 0;
    for (const id of ids) {
      try {
        if (action === "delete") {
          keyPool.removeKey(id);
        } else {
          keyPool.updateSlotMeta(id, { enabled: action === "enable" });
        }
        affected += 1;
      } catch {
        // skip missing slotId
      }
    }
    if (action === "enable" && affected > 0) {
      await ctx.syncKeyQuotas({ includeDisabled: false }).catch(() => undefined);
    }
    sendJson(res, 200, { ok: true, affected, keyPool: keyPool.statusSnapshot() });
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
        } catch {}
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
        } catch {}
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

  const listCloudMatch = /^\/v1\/admin\/keys\/([a-f0-9]+)\/cloud-sessions$/.exec(route);
  if (listCloudMatch && req.method === "GET") {
    const slotId = listCloudMatch[1]!;
    const target = keyPool.allManagedKeys().find((k) => k.slotId === slotId);
    if (!target) throw new GatewayError(`Key slot '${slotId}' not found.`, 404, "not_found");
    const cred = parseQuickCredential(target.rawKey);
    let sessions;
    if (cred.mode === "oauth" && cred.oauth) {
      sessions = await listOAuthCloudSessions(cred.oauth, 100, target.proxyUrl);
    } else if (cred.mode === "web" && cred.web) {
      sessions = await listWebCloudSessions(cred.web, 100, target.proxyUrl);
    } else {
      const outpost = await getSharedOutpost();
      if (cred.mode === "token" && cred.jwt) {
        outpost.setImportedToken({ jwt: cred.jwt, wsHost: cred.wsHost, outpostId: cred.outpostId });
      } else {
        outpost.setImportedToken(null);
      }
      sessions = await outpost.listCloudSessions(100);
    }
    keyPool.updateSlotQuotaCache(target.rawKey, undefined, undefined, undefined, {
      cloudSessionCount: sessions.length,
    });
    sendJson(res, 200, { ok: true, count: sessions.length, sessions });
    return true;
  }

  const clearCloudForTarget = async (target: ReturnType<typeof keyPool.allManagedKeys>[number]) => {
    const cred = parseQuickCredential(target.rawKey);
    let list;
    if (cred.mode === "oauth" && cred.oauth) {
      list = await listOAuthCloudSessions(cred.oauth, 100, target.proxyUrl);
    } else if (cred.mode === "web" && cred.web) {
      list = await listWebCloudSessions(cred.web, 100, target.proxyUrl);
    } else {
      const outpost = await getSharedOutpost();
      if (cred.mode === "token" && cred.jwt) {
        outpost.setImportedToken({ jwt: cred.jwt, wsHost: cred.wsHost, outpostId: cred.outpostId });
      } else {
        outpost.setImportedToken(null);
      }
      list = await outpost.listCloudSessions(100);
    }
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
    const settled = await Promise.allSettled(
      targets.map(async (target) => {
        const r = await clearCloudForTarget(target);
        return { slotId: target.slotId, label: target.label || target.slotId, ...r };
      }),
    );
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
    const reports = await ctx.syncKeyQuotas({ includeDisabled: false, forceRefresh: true }).catch(() => [] as AccountQuotaReport[]);
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
    sendJson(res, 200, { ok: true, recovered: Boolean(status?.enabled), slot: status, keyPool: keyPool.statusSnapshot() });
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
    const body = await readJsonBody(req, 16_384).catch(() => ({}));
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
    const agents = await engine.listChatAgentsForKey(target.rawKey, target.proxyUrl).catch(() => []);
    sendJson(res, 200, { ok: true, slotId, agentId: updated.agentId, agents });
    return true;
  }

  const adminKeyMatch = /^\/v1\/admin\/keys\/([a-f0-9]+)$/.exec(route);
  if (adminKeyMatch) {
    const slotId = adminKeyMatch[1]!;
    if (req.method === "DELETE") {
      keyPool.removeKey(slotId);
      sendJson(res, 200, { ok: true, keyPool: keyPool.statusSnapshot() });
      return true;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!isRecord(body)) throw new GatewayError("JSON object expected.", 400, "invalid_request_error");
      keyPool.updateSlotMeta(slotId, {
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        ...(typeof body.proxyUrl === "string" ? { proxyUrl: body.proxyUrl } : {}),
        ...(typeof body.chatAgentId === "string" ? { chatAgentId: body.chatAgentId } : {}),
        ...(body.clearCooldown === true ? { clearCooldown: true } : {})
      });
      sendJson(res, 200, { ok: true, keyPool: keyPool.statusSnapshot() });
      return true;
    }
  }

  return false;
}
