import http from "node:http";
import { fileURLToPath } from "node:url";
import type { SDKModel } from "./aws-quick/types.js";
import { closeAllOAuthServers } from "./aws-quick/oauth-client.js";
import { findInsecurePlaceholderConfig, isPlaceholderSecret, loadConfigFromEnv, loadDotEnv } from "./core/config.js";
import { QuickExecutionEngine, mapSdkError, type AgentFactory } from "./core/engine.js";
import { UpstreamKeyPool } from "./core/key-pool.js";
import { GatewayError, type GatewayConfig, type GatewayStreamEvent } from "./core/types.js";
import {
  anthropicMessagesAdapter,
  estimateAnthropicTokens,
  formatAnthropicError
} from "./protocols/anthropic.js";
import type { ProtocolAdapter } from "./protocols/common.js";
import {
  formatOpenAiError,
  openAiChatAdapter,
  openAiResponsesAdapter
} from "./protocols/openai.js";
import { ClientGatewayKeyManager } from "./services/client-keys.js";
import { ModelAccessController, normalizeBaseModelId } from "./services/model-access.js";
import { formatOpenAiModelList, listLiveModels, resolveKnownModelId } from "./services/model-catalog.js";
import { fetchAllAccountQuotas } from "./services/quota-service.js";
import { RequestTraceLogger, type RequestProtocolTag } from "./services/request-logger.js";
import { readPackageVersion } from "./services/update-checker.js";
import { UsageLedger } from "./services/usage-ledger.js";
import { UsageTracker } from "./services/usage-tracker.js";
import { classifyClient, sanitizeUserAgent } from "./utils/user-agent.js";
import { AdminAuthManager, AuthFailureThrottle, clientIpOf, isDirectLoopbackRequest } from "./web/admin-auth.js";
import { localizeAdminError, resolveAdminLang } from "./web/admin-i18n.js";
import { tryHandleWebAdminRoute } from "./web/admin-routes.js";

export interface GatewayServerOptions {
  config: GatewayConfig;
  agentFactory?: AgentFactory;
  modelListFetcher?: (apiKey: string) => Promise<SDKModel[]>;
  quotaHttpFetcher?: typeof fetch;
  sessionRpcFetcher?: typeof fetch;
  meFetcher?: NonNullable<Parameters<typeof fetchAllAccountQuotas>[1]>["meFetcher"];
}

export interface GatewayServerInstance {
  server: http.Server;
  engine: QuickExecutionEngine;
  keyPool: UpstreamKeyPool;
  clientKeys: ClientGatewayKeyManager;
  modelAccess: ModelAccessController;
  usageTracker: UsageTracker;
  usageLedger: UsageLedger;
  traceLogger: RequestTraceLogger;
  close: () => Promise<void>;
}

const SSE_KEEPALIVE_INTERVAL_MS = 10_000;
const SSE_EARLY_FLUSH_BYTES = 16_384;

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow"
};

const PROTOCOL_ROUTES: Record<string, { adapter: ProtocolAdapter; tag: RequestProtocolTag }> = {
  "/v1/chat/completions": { adapter: openAiChatAdapter, tag: "openai-chat" },
  "/chat/completions": { adapter: openAiChatAdapter, tag: "openai-chat" },
  "/v1/responses": { adapter: openAiResponsesAdapter, tag: "openai-responses" },
  "/responses": { adapter: openAiResponsesAdapter, tag: "openai-responses" },
  "/v1/messages": { adapter: anthropicMessagesAdapter, tag: "anthropic-messages" },
  "/messages": { adapter: anthropicMessagesAdapter, tag: "anthropic-messages" }
};

function extractClientCredential(req: http.IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) {
    return xApiKey.trim();
  }
  return "";
}

function normalizeRoutePath(rawUrl: string | undefined): string {
  let pathname: string;
  try {
    pathname = new URL(rawUrl || "/", "http://localhost").pathname;
  } catch {
    // Malformed request target (e.g. `//[`): treat as an unknown route instead of crashing the process.
    pathname = "/__invalid__";
  }
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  if (trimmed.startsWith("/v1/v1/")) return trimmed.slice(3);
  return trimmed;
}

function isAdminSurfaceRoute(route: string, dashboardPath: string): boolean {
  return (
    route === dashboardPath ||
    route === "/dashboard" ||
    route.startsWith("/v1/admin") ||
    route === "/v1/quota" ||
    route === "/quota" ||
    route === "/v1/usage" ||
    route === "/usage"
  );
}

function assertJsonContentType(req: http.IncomingMessage): void {
  const raw = req.headers["content-type"];
  const ct = Array.isArray(raw) ? raw[0] : raw;
  if (!ct) return;
  const mime = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "application/json" || mime.endsWith("+json")) return;
  throw new GatewayError("Content-Type must be application/json.", 415, "unsupported_media_type");
}

async function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse, maxBytes: number): Promise<unknown> {
  const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.pause();
    res.once("finish", () => {
      if (!req.destroyed) req.destroy();
    });
    throw new GatewayError(`Request body exceeds limit of ${maxBytes} bytes.`, 413, "request_too_large");
  }
  assertJsonContentType(req);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        req.pause();
        res.once("finish", () => {
          if (!req.destroyed) req.destroy();
        });
        throw new GatewayError(`Request body exceeds limit of ${maxBytes} bytes.`, 413, "request_too_large");
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError("Failed to read request body.", 400, "invalid_request_error");
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GatewayError("Malformed JSON request body.", 400, "invalid_json");
  }
}

function isAnthropicCaller(req: http.IncomingMessage): boolean {
  return Boolean(req.headers["anthropic-version"]) || (!req.headers.authorization && Boolean(req.headers["x-api-key"]));
}

function anthropicModelEntry(m: { id: string; name?: string; created?: number }): Record<string, unknown> {
  return {
    type: "model",
    id: m.id,
    display_name: m.name || m.id,
    created_at: new Date((m.created || 0) * 1000).toISOString()
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  opts: { allowCors?: boolean; extraHeaders?: Record<string, string> } = {}
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
    ...(opts.allowCors ? { "access-control-allow-origin": "*" } : {}),
    ...opts.extraHeaders
  });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, html: string, nonce = ""): void {
  res.writeHead(200, {
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; "),
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    ...SECURITY_HEADERS
  });
  res.end(html);
}

/** Sampling / length hints AWS Quick cannot honour. Accepted for compatibility, but declared in a header. */
const IGNORED_REQUEST_PARAMS = [
  "temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens", "max_output_tokens",
  "stop", "stop_sequences", "seed", "presence_penalty", "frequency_penalty", "logit_bias", "logprobs"
] as const;

function ignoredParamsHeader(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null) return {};
  const hit = IGNORED_REQUEST_PARAMS.filter((k) => (body as Record<string, unknown>)[k] != null);
  return hit.length ? { "x-gateway-ignored-params": hit.join(",") } : {};
}

async function pipeSseStream(
  res: http.ServerResponse,
  chunks: AsyncIterable<string>,
  onErrorChunk: (err: GatewayError) => string,
  extraHeaders: Record<string, string> = {},
  opts: { flushEarly?: boolean; flushEarlyAfter?: Promise<void>; postStartKeepAliveFrame?: string } = {}
): Promise<void> {
  const iterator = chunks[Symbol.asyncIterator]();
  let headersCommitted = false;
  const commitHeaders = () => {
    if (headersCommitted) return;
    headersCommitted = true;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
      ...SECURITY_HEADERS,
      ...extraHeaders
    });
    res.flushHeaders();
  };

  let firstFrameSent = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const startKeepAlive = () => {
    if (keepAlive) return;
    keepAlive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        const frame =
          firstFrameSent && opts.postStartKeepAliveFrame
            ? opts.postStartKeepAliveFrame
            : ": keepalive\n\n";
        res.write(frame);
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);
    keepAlive.unref?.();
  };

  let first: IteratorResult<string>;
  if (opts.flushEarly && opts.flushEarlyAfter) {
    // Wait until an upstream slot lease is actually acquired before committing HTTP 200 + keepalive.
    // Pre-lease errors (429 pool full, 503 no keys, 400 empty/SSRF) propagate cleanly as real HTTP statuses
    // so SDKs like Claude Code can apply native HTTP 429 retry/backoff!
    let settled = false;
    const nextPromise = iterator.next();
    void opts.flushEarlyAfter.then(() => {
      if (!settled && !headersCommitted && !res.writableEnded && !res.destroyed) {
        commitHeaders();
        res.write(": keepalive\n\n");
        startKeepAlive();
      }
    });
    try {
      first = await nextPromise;
      settled = true;
    } catch (err) {
      settled = true;
      if (keepAlive) clearInterval(keepAlive);
      if (headersCommitted) {
        if (!res.writableEnded && !res.destroyed) {
          res.write(onErrorChunk(mapSdkError(err)));
          res.end();
        }
        await iterator.return?.().catch(() => undefined);
        return;
      }
      await iterator.return?.().catch(() => undefined);
      throw err;
    }
    commitHeaders();
    startKeepAlive();
  } else if (opts.flushEarly) {
    // For huge multi-chunk (>50KB) streaming prompts, flush 200 OK + SSE keepalive immediately
    // so reverse proxies like Cloudflare (100s 524 timeout) never drop the connection while chunking.
    commitHeaders();
    if (!res.writableEnded && !res.destroyed) res.write(": keepalive\n\n");
    startKeepAlive();
    try {
      first = await iterator.next();
    } catch (err) {
      if (keepAlive) clearInterval(keepAlive);
      if (!res.writableEnded && !res.destroyed) {
        res.write(onErrorChunk(mapSdkError(err)));
        res.end();
      }
      await iterator.return?.().catch(() => undefined);
      return;
    }
  } else {
    // Pull the first frame BEFORE committing to a 200: errors raised before any output
    // (no usable key, upstream 401/429, bad model) must surface as real HTTP statuses.
    // A throw here propagates to the route's catch, which sends JSON with the proper status.
    try {
      first = await iterator.next();
    } catch (err) {
      await iterator.return?.().catch(() => undefined);
      throw err;
    }
    commitHeaders();
    startKeepAlive();
  }

  const write = async (frame: string): Promise<boolean> => {
    if (res.writableEnded || res.destroyed) return false;
    if (!res.write(frame)) {
      // Resolve on drain OR close, otherwise a client that disconnects while we wait hangs forever.
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.once("drain", done);
        res.once("close", done);
      });
    }
    return !(res.writableEnded || res.destroyed);
  };

  try {
    let step = first;
    while (!step.done) {
      if (!(await write(step.value))) {
        await iterator.return?.().catch(() => undefined);
        break;
      }
      firstFrameSent = true;
      step = await iterator.next();
    }
  } catch (err) {
    const gwErr = mapSdkError(err);
    if (!res.writableEnded && !res.destroyed) {
      res.write(onErrorChunk(gwErr));
    }
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}

export function createGatewayServer(options: GatewayServerOptions): GatewayServerInstance {
  const { config } = options;
  const adminAuth = new AdminAuthManager(config);
  const clientKeys = new ClientGatewayKeyManager(config);
  const protocolAuthThrottle = new AuthFailureThrottle();
  const authenticateProtocolClient = (req: http.IncomingMessage, opts: { checkQuotaCap?: boolean } = {}) => {
    const ip = clientIpOf(req, config.trustProxy);
    const cred = extractClientCredential(req);
    try {
      const auth = clientKeys.authenticateClient(cred, opts);
      protocolAuthThrottle.recordSuccess(ip);
      return auth;
    } catch (err) {
      const gwErr = mapSdkError(err);
      if (gwErr.status === 401) {
        protocolAuthThrottle.assertAllowed(ip);
        protocolAuthThrottle.recordFailure(ip);
      } else {
        // Locked-out IPs must not probe disabled/expired/exhausted keys to enumerate key metadata.
        protocolAuthThrottle.assertAllowed(ip);
      }
      throw err;
    }
  };
  const keyPool = new UpstreamKeyPool(config);
  const modelAccess = new ModelAccessController(config);
  const usageTracker = new UsageTracker();
  const usageLedger = new UsageLedger(config.usageLedgerFile, config.recordClientIp !== false);
  const traceLogger = new RequestTraceLogger(100);
  const engine = new QuickExecutionEngine({
    config,
    usageTracker,
    agentFactory: options.agentFactory,
    modelListFetcher: options.modelListFetcher
  });

  /** Reject unknown base model ids with 404 before any account-pool / spend-guard logic runs. Does not touch pool scheduling state. */
  async function assertModelExists(requestedModel: string): Promise<void> {
    const baseId = normalizeBaseModelId(requestedModel || "auto");
    if (!baseId || baseId === "auto" || baseId === "default") return;
    const probeKey = keyPool.allManagedKeys().find((k) => k.enabled)?.rawKey;
    if (!probeKey) return;
    let catalog: Awaited<ReturnType<typeof listLiveModels>>;
    try {
      catalog = await listLiveModels(probeKey, options.modelListFetcher);
    } catch {
      return;
    }
    if (!catalog.some((m) => m.id.toLowerCase() === baseId)) {
      throw new GatewayError(`Model '${requestedModel}' not found.`, 404, "model_not_found", "model");
    }
  }

  async function* tapStreamWithTrace(
    events: AsyncGenerator<GatewayStreamEvent, void, unknown>,
    traceId: string | null,
    clientKeyId?: string
  ): AsyncGenerator<GatewayStreamEvent, void, unknown> {
    if (!traceId && !clientKeyId) {
      yield* events;
      return;
    }
    let doneReason: string | undefined;
    let settled = false;
    try {
      for await (const ev of events) {
        if (ev.type === "thinking") traceLogger.recordThinkingDelta(traceId, ev.text);
        else if (ev.type === "text") traceLogger.recordTextDelta(traceId, ev.text);
        else if (ev.type === "tool_calls") traceLogger.recordToolCalls(traceId, ev.calls);
        else if (ev.type === "usage") {
          traceLogger.recordUsage(traceId, ev.metrics);
          clientKeys.recordUsage(clientKeyId, ev.metrics.inputTokens + ev.metrics.cacheReadTokens, ev.metrics.outputTokens);
        } else if (ev.type === "done") doneReason = ev.stopReason;
        yield ev;
      }
      settled = true;
      traceLogger.finishSuccess(traceId, doneReason);
    } catch (err) {
      settled = true;
      const gwErr = mapSdkError(err);
      traceLogger.finishError(traceId, gwErr.status, gwErr.message);
      throw gwErr;
    } finally {
      if (!settled) {
        traceLogger.finishError(traceId, 499, "Client disconnected before stream completed");
      }
    }
  }


  /** Records one metadata-only ledger row per finished request (success or failure); never message content. */
  async function* tapStreamWithLedger(
    events: AsyncGenerator<GatewayStreamEvent, void, unknown>,
    info: { model: string; key: string; ip: string; ua: string; protocol: string; stream: boolean; meta: { account: string; execMode: string; usedProxy: boolean; startedAt: number } }
  ): AsyncGenerator<GatewayStreamEvent, void, unknown> {
    let usage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    let routedModel: string | undefined;
    let ttftMs: number | undefined;
    let status = 200;
    let logged = false;
    const finish = () => {
      if (logged) return;
      logged = true;
      usageLedger.record({
        at: Date.now(),
        model: info.model,
        ...(routedModel ? { routedModel } : {}),
        key: info.key,
        ip: info.ip,
        ua: info.ua,
        client: classifyClient(info.ua),
        account: info.meta.account,
        ...(info.meta.execMode ? { execMode: info.meta.execMode } : {}),
        ...(info.meta.usedProxy ? { usedProxy: true } : {}),
        ok: status < 400,
        status,
        durationMs: Date.now() - info.meta.startedAt,
        ...(ttftMs !== undefined ? { ttftMs } : {}),
        protocol: info.protocol,
        stream: info.stream,
        ...usage
      });
    };
    try {
      for await (const ev of events) {
        if (ttftMs === undefined && (ev.type === "text" || ev.type === "thinking" || ev.type === "tool_calls")) {
          ttftMs = Date.now() - info.meta.startedAt;
        }
        if (ev.type === "usage") {
          if (ev.metrics.resolvedModel) routedModel = ev.metrics.resolvedModel;
          usage = {
            // Include cacheWriteTokens in uncached inputTokens so prompt cache hit rate
            // reflects cacheRead / (input + cacheWrite + cacheRead) instead of inflating to 100%.
            inputTokens: (ev.metrics.inputTokens || 0) + (ev.metrics.cacheWriteTokens || 0),
            cacheReadTokens: ev.metrics.cacheReadTokens || 0,
            outputTokens: ev.metrics.outputTokens || 0
          };
        }
        yield ev;
      }
    } catch (err) {
      status = mapSdkError(err).status;
      throw err;
    } finally {
      // Also covers a client that disconnects mid-stream (generator return()).
      finish();
    }
  }

  const syncKeyQuotas = async (opts: {
    includeDisabled?: boolean;
    forceRefresh?: boolean;
    includeRecoveryProbes?: boolean;
    slotIds?: string[];
  } = {}) => {
    const managed = keyPool.allManagedKeys();
    const slotFilter = opts.slotIds?.length ? new Set(opts.slotIds) : null;
    const targetManaged = slotFilter
      ? managed.filter((m) => slotFilter.has(m.slotId))
      : opts.includeDisabled
        ? managed
        : managed.filter((m) => m.enabled);
    const rawKeys = targetManaged.length > 0
      ? targetManaged.map((m) => m.rawKey)
      : [];
    if (opts.includeRecoveryProbes && !slotFilter) {
      for (const k of keyPool.recoveryProbeKeys()) if (!rawKeys.includes(k)) rawKeys.push(k);
    }

    const reports = await fetchAllAccountQuotas(rawKeys, {
      forceRefresh: opts.forceRefresh,
      fetcher: options.quotaHttpFetcher,
      meFetcher: options.meFetcher,
      proxyByKey: (k) => keyPool.proxyUrlForKey(k),
    });

    rawKeys.forEach((rawKey, idx) => {
      const rep = reports[idx];
      if (rep) {
        keyPool.updateSlotQuotaCache(rawKey, rep.identity, rep.quota, rep.bot, {
          cloudSessionCount: rep.cloudSessionCount,
          tokenRemainingSec: rep.tokenRemainingSec,
          syncError: rep.status === "error" ? (rep.error || "Sync failed") : null,
        });
        if (
          rep.status === "error" &&
          /invalid_grant|invalid_client|unauthorized_client|expired_token|access_denied|invalid refresh token/i.test(rep.error || "")
        ) {
          keyPool.reportAuthFailure(rawKey, "OAuth token revoked/expired — please re-authorize");
        }
        const detectedEmail = rep.identity?.userEmail;
        if (detectedEmail && detectedEmail.includes("@")) {
          const slot = keyPool.allManagedKeys().find((m) => m.rawKey === rawKey);
          const curLabel = (slot?.label || "").trim();
          if (slot && (!curLabel || /^(Account #\d+|AWS #[A-Za-z0-9]+)$/i.test(curLabel))) {
            keyPool.updateSlotMeta(slot.slotId, { label: detectedEmail });
          }
        }
      }
    });
    return reports;
  };

  // Upstream quota is fetched on explicit admin action AND as a single debounced one-shot probe
  // when an account trips runtime quota exhaustion (so 5h burst trips immediately learn AWS's exact resume_in_minutes).
  keyPool.setOnQuotaExhausted((slotId) => {
    void syncKeyQuotas({ includeDisabled: true, forceRefresh: true, slotIds: [slotId] }).catch(() => undefined);
  });

  const activeByClientKey = new Map<string, number>();
  const server = http.createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    const route = normalizeRoutePath(req.url);
    const adminSurface = isAdminSurfaceRoute(route, config.dashboardPath);

    if (req.method === "OPTIONS") {
      if (adminSurface) {
        res.writeHead(204, SECURITY_HEADERS);
      } else {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers":
            "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, openai-beta, openai-organization, openai-project, x-session-id, session-id, x-conversation-id, openai-conversation-id, x-session-affinity, x-stainless-lang, x-stainless-package-version, x-stainless-os, x-stainless-arch, x-stainless-runtime, x-stainless-runtime-version, x-stainless-retry-count, x-stainless-timeout, x-stainless-helper-method",
          ...SECURITY_HEADERS
        });
      }
      res.end();
      return;
    }

    const protocolEntry = PROTOCOL_ROUTES[route];
    const protocolAdapter = protocolEntry?.adapter;
    const isModelsRoute = /^(?:\/v1)?\/models(?:\/.+)?$/.test(route);
    const anthropicModels = isModelsRoute && isAnthropicCaller(req);
    const useAnthropicError = protocolAdapter?.errorFormat === "anthropic"
      || anthropicModels
      || route === "/v1/messages/count_tokens"
      || route === "/messages/count_tokens";

    const abortController = new AbortController();
    req.on("aborted", () => abortController.abort(new Error("Client aborted HTTP request")));
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort(new Error("Client closed HTTP connection before response completed"));
      }
    });

    try {
      if (route === "/favicon.ico" && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(204);
        res.end();
        return;
      }

      // 1. Liveness Probe (`/health` & `/healthz`)
      if ((route === "/health" || route === "/healthz") && (req.method === "GET" || req.method === "HEAD")) {
        const detailed = isDirectLoopbackRequest(req);
        sendJson(res, 200, {
          ok: true,
          ...(detailed
            ? {
              service: "aws-quick2api",
              version: readPackageVersion(),
              uptimeSeconds: Math.floor(process.uptime()),
              enabledKeys: keyPool.enabledKeyCount(),
              ...engine.runtimeStats()
            }
            : {})
        });
        return;
      }

      // 2. Optional Decoupled Web Console & Admin API (`src/web/admin-routes.ts`)
      if (config.enableDashboard) {
        const handledByWeb = await tryHandleWebAdminRoute(req, res, route, abortController.signal, {
          config,
          adminAuth,
          engine,
          keyPool,
          clientKeys,
          modelAccess,
          usageTracker,
          usageLedger,
          traceLogger,
          modelListFetcher: options.modelListFetcher,
          sessionRpcFetcher: options.sessionRpcFetcher,
          onDemandFetcher: options.quotaHttpFetcher,
          syncKeyQuotas,
          tapStreamWithTrace,
          extractClientCredential,
          readJsonBody: (r, max) => readJsonBody(r, res, max),
          sendJson,
          sendHtml
        });
        if (handledByWeb) return;
      }

      // 3. Standard Protocol Layer: Models Catalog (`GET /v1/models` & `/v1/models/:id`)
      if ((route === "/v1/models" || route === "/models") && req.method === "GET") {
        const clientAuth = authenticateProtocolClient(req, { checkQuotaCap: false });
        const catalogKey = keyPool.enabledKeyCount() > 0 ? keyPool.peekKeyForCatalog() : "";
        const models = await listLiveModels(catalogKey, options.modelListFetcher);
        const globallyEnabled = modelAccess.filterOpenAiModels(formatOpenAiModelList(models));
        const permittedForKey = clientKeys.filterModelsForClient(clientAuth, globallyEnabled);
        if (isAnthropicCaller(req)) {
          const data = permittedForKey.map(anthropicModelEntry);
          sendJson(
            res,
            200,
            { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null },
            { allowCors: true }
          );
          return;
        }
        sendJson(res, 200, { object: "list", data: permittedForKey }, { allowCors: true });
        return;
      }

      const modelDetailMatch = /^(?:\/v1)?\/models\/(.+)$/.exec(route);
      if (modelDetailMatch && req.method === "GET") {
        const clientAuth = authenticateProtocolClient(req, { checkQuotaCap: false });
        let targetId: string;
        try {
          targetId = decodeURIComponent(modelDetailMatch[1]!);
        } catch {
          throw new GatewayError("Malformed model identifier.", 400, "invalid_request_error", "model");
        }
        const catalogKey = keyPool.enabledKeyCount() > 0 ? keyPool.peekKeyForCatalog() : "";
        const rawModels = await listLiveModels(catalogKey, options.modelListFetcher);
        const canonicalId = resolveKnownModelId(targetId) ?? normalizeBaseModelId(targetId);
        modelAccess.assertModelAllowed(canonicalId);
        clientKeys.assertModelPermitted(clientAuth, canonicalId);
        const models = formatOpenAiModelList(rawModels);
        // Variant/alias ids such as `claude-sonnet-5-5[effort=high]` or `quick-balanced[effort=high]` are accepted by POST; accept them here too.
        const found =
          models.find((m) => m.id === targetId) ??
          (() => {
            const base = models.find((m) => m.id === canonicalId);
            return base ? { ...base, id: targetId } : undefined;
          })();
        if (!found) {
          throw new GatewayError(`Model '${targetId}' not found.`, 404, "model_not_found", "model");
        }
        sendJson(res, 200, anthropicModels ? anthropicModelEntry(found) : found, { allowCors: true });
        return;
      }

      // 4. Standard Protocol Layer: Anthropic Token Estimation (`POST /v1/messages/count_tokens`)
      if ((route === "/v1/messages/count_tokens" || route === "/messages/count_tokens") && req.method === "POST") {
        const clientAuth = authenticateProtocolClient(req, { checkQuotaCap: false });
        const body = await readJsonBody(req, res, Math.min(config.maxBodyBytes, 4 * 1024 * 1024));
        if (clientAuth.kind === "gateway_key") {
          const limit = clientKeys.concurrencyLimitFor(clientAuth.keyId, config.clientKeyMaxConcurrent);
          if (limit > 0 && (activeByClientKey.get(clientAuth.keyId) ?? 0) >= limit) {
            throw Object.assign(
              new GatewayError(`Too many concurrent requests for this API key (limit ${limit}).`, 429, "concurrency_limit_exceeded"),
              { retryAfter: 2 }
            );
          }
        }
        sendJson(res, 200, { input_tokens: estimateAnthropicTokens(body) }, { allowCors: true });
        return;
      }

      // 5. Standard Protocol Layer: OpenAI Chat, OpenAI Responses & Anthropic Messages
      if (protocolEntry && protocolAdapter && req.method === "POST") {
        const clientAuth = authenticateProtocolClient(req, { checkQuotaCap: true });
        const body = await readJsonBody(req, res, config.maxBodyBytes);
        const turn = protocolAdapter.parse(body, req.headers, abortController.signal);
        const clientKeyId = clientAuth.kind === "gateway_key" ? clientAuth.keyId : undefined;
        turn.scope = clientKeyId ?? "master";
        if (turn.conversationKey) turn.conversationKey = `${turn.scope}:${turn.conversationKey}`;
        const concurrencyLimit = clientKeyId ? clientKeys.concurrencyLimitFor(clientKeyId, config.clientKeyMaxConcurrent) : 0;
        if (clientKeyId && concurrencyLimit > 0) {
          const active = activeByClientKey.get(clientKeyId) ?? 0;
          if (active >= concurrencyLimit) {
            throw Object.assign(
              new GatewayError(
                `Too many concurrent requests for this API key (limit ${concurrencyLimit}).`,
                429,
                "concurrency_limit_exceeded"
              ),
              { retryAfter: 2 }
            );
          }
          activeByClientKey.set(clientKeyId, active + 1);
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            const n = (activeByClientKey.get(clientKeyId) ?? 1) - 1;
            if (n <= 0) activeByClientKey.delete(clientKeyId);
            else activeByClientKey.set(clientKeyId, n);
          };
          res.once("close", release);
          res.once("finish", release);
        }
        const ua = sanitizeUserAgent(req.headers["user-agent"]);
        const recordedIp = config.recordClientIp !== false ? clientIpOf(req, config.trustProxy) : "";
        const traceId = config.enableDashboard
          ? traceLogger.startTrace(protocolEntry.tag, turn, { keyId: clientKeyId, keyName: clientAuth.keyName, clientIp: recordedIp, userAgent: ua })
          : null;
        try {
          const canonicalModelId = resolveKnownModelId(turn.requestedModel) ?? turn.requestedModel;
          modelAccess.assertModelAllowed(canonicalModelId);
          clientKeys.assertModelPermitted(clientAuth, canonicalModelId);
          await assertModelExists(canonicalModelId);
          clientKeys.tryReserveRequest(clientKeyId);
        } catch (err) {
          const gwErr = mapSdkError(err);
          traceLogger.finishError(traceId, gwErr.status, gwErr.message);
          throw gwErr;
        }
        const ledgerMeta = { account: "", execMode: "", usedProxy: false, startedAt: Date.now() };
        let resolveLeaseReady!: () => void;
        const leaseReadyPromise = new Promise<void>((r) => {
          resolveLeaseReady = r;
        });
        const rawEvents = engine.executeTurnWithPool(turn, keyPool, (meta) => {
          traceLogger.bindExecutionMeta(traceId, meta);
          ledgerMeta.account = meta.accountLabel || meta.maskedKey;
          ledgerMeta.execMode = meta.execMode;
          ledgerMeta.usedProxy = Boolean(meta.usedProxy);
          resolveLeaseReady();
        });
        const events = tapStreamWithLedger(
          tapStreamWithTrace(rawEvents, traceId, clientKeyId),
          {
            model: turn.requestedModel,
            key: clientAuth.keyName || "master",
            ip: recordedIp,
            ua,
            protocol: protocolEntry.tag,
            stream: Boolean(turn.stream),
            meta: ledgerMeta
          }
        );

        if (turn.stream) {
          const approxPayloadBytes =
            Buffer.byteLength(turn.fullTranscriptText || "", "utf8") +
            Buffer.byteLength(turn.systemPrompt || "", "utf8") +
            (turn.tools.length > 0 ? Buffer.byteLength(JSON.stringify(turn.tools), "utf8") : 0);
          const flushEarly =
            keyPool.enabledKeyCount() > 0 &&
            (approxPayloadBytes > SSE_EARLY_FLUSH_BYTES ||
              (protocolEntry.tag === "anthropic-messages" && turn.tools.length > 0));
          await pipeSseStream(
            res,
            protocolAdapter.streamSse(events, turn),
            (err) => protocolAdapter.formatSseErrorFrame(err),
            ignoredParamsHeader(turn.rawBody),
            {
              flushEarly,
              ...(flushEarly ? { flushEarlyAfter: leaseReadyPromise } : {}),
              ...(protocolEntry.tag === "anthropic-messages"
                ? { postStartKeepAliveFrame: 'event: ping\ndata: {"type":"ping"}\n\n' }
                : {}),
            }
          );
        } else {
          const json = await protocolAdapter.collectJson(events, turn);
          sendJson(res, 200, json, { allowCors: true, extraHeaders: ignoredParamsHeader(turn.rawBody) });
        }
        return;
      }

      const allow = isModelsRoute
        ? "GET, OPTIONS"
        : protocolEntry || route === "/v1/messages/count_tokens" || route === "/messages/count_tokens"
          ? "POST, OPTIONS"
          : "";
      if (allow) {
        throw Object.assign(new GatewayError(`Method ${req.method} not allowed for ${route}.`, 405, "method_not_allowed"), { allow });
      }
      throw new GatewayError(`Unsupported endpoint: ${req.method} ${route}`, 404, "not_found");
    } catch (err) {
      let gwErr = mapSdkError(err);
      if (adminSurface) {
        gwErr = localizeAdminError(gwErr, resolveAdminLang(req));
      }
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      sendJson(
        res,
        gwErr.status,
        useAnthropicError ? formatAnthropicError(gwErr) : formatOpenAiError(gwErr),
        {
          allowCors: !adminSurface,
          extraHeaders: {
            ...(gwErr.status === 429
              ? { "retry-after": String((gwErr as { retryAfter?: number }).retryAfter ?? (gwErr.code === "api_key_quota_exceeded" ? 3600 : 5)) }
              : {}),
            ...((gwErr as { allow?: string }).allow ? { allow: (gwErr as { allow?: string }).allow! } : {})
          }
        }
      );
    }
  });

  server.headersTimeout = 30_000;
  server.requestTimeout = Math.max(120_000, config.runMaxTimeoutMs + 30_000);
  server.keepAliveTimeout = 65_000;

  return {
    server,
    engine,
    keyPool,
    clientKeys,
    modelAccess,
    usageTracker,
    usageLedger,
    traceLogger,
    close: async () => {
      closeAllOAuthServers();
      await engine.disposeAll();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clientKeys.flushStatsToDisk();
      usageLedger.flush();
    }
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let envFilePath: string | undefined;
  let config: GatewayConfig;
  try {
    envFilePath = loadDotEnv();
    config = loadConfigFromEnv(process.env, envFilePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    console.error(
      JSON.stringify({
        event: "gateway_refused_to_start",
        reason: err instanceof Error ? err.message : String(err),
        ...(code === "EACCES"
          ? { hint: "Permission denied reading .env/data. If upgrading Docker to v0.1.16+ (non-root uid 1000), run: chown -R 1000:1000 data .env" }
          : {}),
      }),
    );
    process.exit(1);
  }
  const insecureIssues = findInsecurePlaceholderConfig(config);
  if (insecureIssues.length > 0) {
    console.error(
      JSON.stringify({
        event: "gateway_refused_to_start",
        reason: "Refusing to start with documented placeholder secrets.",
        issues: insecureIssues
      })
    );
    process.exit(1);
  }
  let instance: ReturnType<typeof createGatewayServer>;
  try {
    instance = createGatewayServer({ config });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    console.error(
      JSON.stringify({
        event: "gateway_refused_to_start",
        reason: err instanceof Error ? err.message : String(err),
        ...(code === "EACCES"
          ? { hint: "Permission denied accessing data directory or .env. If upgrading Docker to v0.1.16+ (non-root uid 1000), run: chown -R 1000:1000 data .env" }
          : {}),
      }),
    );
    process.exit(1);
  }
  const storedPlaceholderKeys = instance.clientKeys
    .listKeys()
    .filter((k) => k.enabled && isPlaceholderSecret(instance.clientKeys.revealKeyToken(k.id)));
  if (storedPlaceholderKeys.length > 0) {
    console.error(
      JSON.stringify({
        event: "gateway_refused_to_start",
        reason: "Refusing to start with an enabled placeholder key still stored in gateway-keys.json.",
        keyNames: storedPlaceholderKeys.map((k) => k.name),
        hint: "Delete or disable the placeholder key in gateway-keys.json (or remove the file to auto-generate a strong random key).",
      }),
    );
    process.exit(1);
  }
  for (const ev of instance.clientKeys.startupEvents) {
    console.log(JSON.stringify(ev));
  }
  if (instance.clientKeys.listKeys().length === 0) {
    if (config.enableDashboard) {
      instance.clientKeys.createKey({ name: "Default Key (Auto-Generated)" });
      console.log(
        JSON.stringify({
          event: "gateway_default_key_generated",
          note: "No GATEWAY_TOKEN set; generated a random sk-aq- key. View/copy it in the Web Console -> Sub-Keys."
        })
      );
    } else {
      console.error(
        JSON.stringify({
          event: "gateway_refused_to_start",
          reason: "No client API key configured (open mode is not supported). Set GATEWAY_TOKEN or ADMIN_PASSWORD in .env first."
        })
      );
      process.exit(1);
    }
  }

  instance.server.listen({ port: config.port, host: config.host, backlog: 512 }, () => {
    console.log(
      JSON.stringify({
        event: "gateway_listening",
        host: config.host,
        port: config.port,
        baseUrl: `http://${config.host}:${config.port}/v1`,
        dashboardEnabled: config.enableDashboard,
        ...(config.enableDashboard
          ? { dashboardUrl: `http://${config.host}:${config.port}${config.dashboardPath}` }
          : {}),
        enabledKeys: instance.keyPool.enabledKeyCount(),
        lbStrategy: config.lbStrategy
      })
    );
  });

  process.on("unhandledRejection", (reason) => {
    console.error(JSON.stringify({ event: "unhandled_rejection", message: reason instanceof Error ? reason.message : String(reason) }));
  });
  process.on("uncaughtException", (err) => {
    console.error(JSON.stringify({ event: "uncaught_exception", message: err.message }));
  });

  const shutdown = async (sig: string) => {
    console.log(JSON.stringify({ event: "gateway_shutdown", signal: sig }));
    await instance.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
