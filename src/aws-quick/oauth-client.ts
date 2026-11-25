import crypto from "node:crypto";
import http from "node:http";
import WebSocket from "ws";
import { fetchViaOptionalProxy, getProxyAgent } from "../utils/proxy-agent.js";
import { decodeCloudOutputFrame, drainEventStream, encodeCloudInputFrame } from "./event-stream-cbor.js";
import type { CloudSessionMeta, QuickQuotaUsage } from "./types.js";

export interface OAuthCredential {
  region: string;
  issuerUrl: string;
  wsHost: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number; // epoch ms
  accountId?: string;
  email?: string;
  name?: string;
}

export interface OAuthUserIdentity {
  email?: string;
  name?: string;
  accountId?: string;
}

export interface PendingOAuthFlow {
  flowId: string;
  region: string;
  issuerUrl: string;
  wsHost: string;
  accountId?: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
  state: string;
  authUrl: string;
  createdAt: number;
  status: "pending" | "completed" | "error";
  error?: string;
  credential?: OAuthCredential;
  proxyUrl?: string;
  server?: http.Server;
}

const activeFlows = new Map<string, PendingOAuthFlow>();
const tokenCache = new Map<string, { accessToken: string; refreshToken: string; expiresAt: number }>();
const inFlightRefresh = new Map<string, Promise<{ accessToken: string; expiresAt: number; rotatedRefreshToken?: string }>>();
const identityCache = new Map<string, OAuthUserIdentity>();

const AWS_QUICK_WSHOST_RE = /^(?:[a-z0-9-]+\.)+(?:plato\.ai\.aws\.dev|quick\.aws\.com|quicksight\.aws\.amazon\.com)$/i;

export function sanitizeAwsQuickWsHost(raw: string): string {
  const host = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:443$/, "").trim();
  if (!host || !AWS_QUICK_WSHOST_RE.test(host)) {
    throw new Error(`Invalid AWS Quick host: ${host || "(empty)"}`);
  }
  return host;
}

export function closeAllOAuthServers(): void {
  if (activeDiscoveryServer) {
    try { activeDiscoveryServer.close(); } catch {}
    activeDiscoveryServer = null;
  }
  for (const flow of activeFlows.values()) {
    try { flow.server?.close(); } catch {}
  }
  activeFlows.clear();
}

export function cacheOAuthUserIdentity(clientId: string, info: OAuthUserIdentity): void {
  if (!clientId) return;
  const prev = identityCache.get(clientId) || {};
  const next: OAuthUserIdentity = {
    ...(prev.email ? { email: prev.email } : {}),
    ...(prev.name ? { name: prev.name } : {}),
    ...(prev.accountId ? { accountId: prev.accountId } : {}),
    ...(info.email?.trim() ? { email: info.email.trim() } : {}),
    ...(info.name?.trim() ? { name: info.name.trim() } : {}),
    ...(info.accountId?.trim() ? { accountId: info.accountId.trim() } : {}),
  };
  if (next.email || next.name || next.accountId) {
    identityCache.set(clientId, next);
  }
}

export function getCachedOAuthUserIdentity(clientId: string): OAuthUserIdentity | undefined {
  return identityCache.get(clientId);
}

/**
 * Performs a single lightweight official WebSocket `session_connect` handshake to read the
 * server-pushed `connected.payload.user` profile (`email`, `name`, `aws_account_id`).
 * Results are cached per `clientId` so repeated quota syncs never open extra sockets.
 */
export async function fetchOAuthUserIdentity(
  cred: OAuthCredential,
  proxyUrl?: string,
): Promise<OAuthUserIdentity | null> {
  const cached = identityCache.get(cred.clientId);
  if (cached?.email) return cached;
  if (cred.email && cred.name) {
    const info: OAuthUserIdentity = {
      email: cred.email,
      name: cred.name,
      ...(cred.accountId ? { accountId: cred.accountId } : {}),
    };
    identityCache.set(cred.clientId, info);
    return info;
  }

  try {
    const tok = await resolveOAuthAccessToken(cred, false, proxyUrl);
    const outpostId = deriveStableOutpostId(cred.clientId);
    const surfaceType = process.platform === "win32" ? "QUICK_WORK_DESKTOP_WINDOWS" : "QUICK_WORK_DESKTOP_MAC";
    const qs = new URLSearchParams({
      surfaceType,
      token: tok.accessToken,
      outpostId,
      workingSessionId: crypto.randomUUID(),
      channel: "quickwork",
    });
    const wsUrl = `wss://${cred.wsHost}:443/streaming/quickwork-chat-bidirectional-stream?${qs.toString()}`;
    const effectiveProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const agent = getProxyAgent(effectiveProxy);

    const user = await new Promise<OAuthUserIdentity | null>((resolve) => {
      let settled = false;
      let buf: Buffer = Buffer.alloc(0);
      const ws = new WebSocket(wsUrl, {
        ...(agent ? { agent } : {}),
        headers: {
          "User-Agent": QUICK_DESKTOP_USER_AGENT,
          "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
        },
        handshakeTimeout: 5_000,
      });
      const finish = (val: OAuthUserIdentity | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(val);
      };
      const timer = setTimeout(() => finish(null), 5_500);
      ws.once("open", () => {
        try {
          ws.send(encodeCloudInputFrame({ type: "session_connect", payload: { capabilities: [] } }));
        } catch {
          finish(null);
        }
      });
      ws.on("message", (data) => {
        try {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          buf = Buffer.concat([buf, chunk]);
          const drained = drainEventStream(buf);
          buf = buf.subarray(drained.consumed);
          for (const frame of drained.messages) {
            const dec = decodeCloudOutputFrame(frame);
            if (dec?.type === "event" && dec.data && typeof dec.data === "object") {
              const inner = dec.data as { type?: string; payload?: { user?: Record<string, unknown> } };
              if (inner.type === "connected") {
                const u = inner.payload?.user;
                const email = typeof u?.email === "string" && u.email.trim() ? u.email.trim() : undefined;
                const name = typeof u?.name === "string" && u.name.trim() ? u.name.trim() : undefined;
                const accountId = typeof u?.aws_account_id === "string" && u.aws_account_id.trim()
                  ? u.aws_account_id.trim()
                  : undefined;
                if (email || name || accountId) {
                  const info: OAuthUserIdentity = {
                    ...(email ? { email } : {}),
                    ...(name ? { name } : {}),
                    ...(accountId ? { accountId } : {}),
                  };
                  cacheOAuthUserIdentity(cred.clientId, info);
                  finish(info);
                  return;
                }
                finish(null);
                return;
              }
            }
          }
        } catch {
          finish(null);
        }
      });
      ws.once("error", () => finish(null));
      ws.once("close", () => finish(null));
    });
    return user;
  } catch {
    return null;
  }
}

export const QUICK_APP_VERSION = process.env.AWS_QUICK_APP_VERSION?.trim() || "1.2.4660";
export const QUICK_DESKTOP_USER_AGENT =
  process.platform === "win32"
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AmazonQuick/${QUICK_APP_VERSION} Chrome/136.0.7103.113 Electron/36.3.2 Safari/537.36`
    : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AmazonQuick/${QUICK_APP_VERSION} Chrome/136.0.7103.113 Electron/36.3.2 Safari/537.36`;

/**
 * Derives a deterministic RFC 4122 UUID v4 outpostId from `clientId` so each credential
 * presents a stable UUID-formatted device identifier across reconnects.
 */
export function deriveStableOutpostId(clientId: string): string {
  const hash = crypto.createHash("sha256").update(`aws-quick-outpost:${clientId}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Optional environment defaults for single-tenant or enterprise SSO deployments.
 * By default, each AWS Quick account discovers its own `issuerUrl`, `wsHost`, `region`, and `accountId`
 * via `buildOAuthDiscoveryUrl()` + `parseOAuthDiscoveryCallback()`.
 */
export const DEFAULT_OAUTH_ISSUER_URL = process.env.DEFAULT_OAUTH_ISSUER_URL?.trim() || "";
export const DEFAULT_OAUTH_WS_HOST = process.env.DEFAULT_OAUTH_WS_HOST?.trim() || "";

let activeDiscoveryServer: http.Server | null = null;

/**
 * Generates the universal AWS Quick desktop account discovery URL.
 * When `onCompleted` is provided on a local deployment, also binds a lightweight temporary
 * listener on `127.0.0.1:<port>` that catches `/callback?issuerUrl=...&tenantUrl=...`,
 * automatically starts OIDC PKCE, and 302-redirects the browser straight to the Allow Access page!
 */
export function buildOAuthDiscoveryUrl(
  port = 18080,
  opts?: { onCompleted?: (cred: OAuthCredential) => void },
): { nonce: string; discoveryUrl: string } {
  const nonce = base64Url(crypto.randomBytes(24));
  const surface = `desktop:${nonce}:${port}:${QUICK_APP_VERSION}`;
  const discoveryUrl = `https://quick.aws.com/sn?qwSurface=${encodeURIComponent(surface)}`;

  if (opts?.onCompleted) {
    try {
      activeDiscoveryServer?.close();
    } catch {}
    const srv = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        if (reqUrl.pathname === "/callback" && (reqUrl.searchParams.has("issuerUrl") || reqUrl.searchParams.has("tenantUrl"))) {
          // Close discovery server first so startOAuthPkceFlow can bind the same port cleanly
          try { srv.close(); } catch {}
          if (activeDiscoveryServer === srv) activeDiscoveryServer = null;
          const started = await startOAuthPkceFlow({
            discoveryCallbackUrl: reqUrl.toString(),
            callbackPort: port,
            onCompleted: opts.onCompleted,
          });
          res.writeHead(302, { Location: started.authUrl });
          res.end();
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Waiting for AWS Quick discovery callback...");
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`OAuth discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    srv.once("error", () => {
      // Port busy (e.g. another flow or remote cloud); ignore silently — manual paste works everywhere.
      if (activeDiscoveryServer === srv) activeDiscoveryServer = null;
    });
    srv.listen(port, "127.0.0.1");
    activeDiscoveryServer = srv;
    setTimeout(() => {
      try { srv.close(); } catch {}
      if (activeDiscoveryServer === srv) activeDiscoveryServer = null;
    }, 10 * 60 * 1000).unref?.();
  }

  return { nonce, discoveryUrl };
}

/**
 * Parses the discovery callback URL (`http://localhost:18080/callback?...`) returned by `quick.aws.com`
 * to extract the account's exact `issuerUrl`, `wsHost`, `region`, and `accountId`.
 */
export function parseOAuthDiscoveryCallback(rawUrl: string): {
  issuerUrl: string;
  wsHost: string;
  region: string;
  accountId?: string;
} {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) {
    throw new Error("Discovery callback URL is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid discovery callback URL. Please paste the full http://localhost:18080/callback?... URL.");
  }
  const sp = parsed.searchParams;
  const idcInstanceId = sp.get("idcInstanceId")?.trim() || "";
  const issuerUrl =
    sp.get("issuerUrl")?.trim() ||
    (idcInstanceId ? `https://identitycenter.amazonaws.com/${idcInstanceId}` : "");
  const tenantRaw = sp.get("tenantUrl")?.trim() || sp.get("wsHost")?.trim() || "";
  const wsHost = tenantRaw ? sanitizeAwsQuickWsHost(tenantRaw) : "";
  const region = sp.get("idcRegion")?.trim() || sp.get("region")?.trim() || "us-east-1";
  const accountId = sp.get("account")?.trim() || undefined;

  if (!issuerUrl || !wsHost) {
    throw new Error(
      "Discovery URL is missing `issuerUrl` or `tenantUrl`. Make sure you copied the full http://localhost:18080/callback?... URL.",
    );
  }
  return {
    issuerUrl,
    wsHost,
    region,
    ...(accountId ? { accountId } : {}),
  };
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function serializeOAuthCredential(cred: OAuthCredential): string {
  return `oauth:${Buffer.from(JSON.stringify(cred), "utf8").toString("base64url")}`;
}

export function parseOAuthCredential(raw: string): OAuthCredential | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("oauth:")) return null;
  try {
    const json = Buffer.from(trimmed.slice(6), "base64url").toString("utf8");
    const obj = JSON.parse(json) as Partial<OAuthCredential>;
    if (!obj.clientId || !obj.clientSecret || !obj.refreshToken || !obj.wsHost) return null;
    const wsHost = sanitizeAwsQuickWsHost(obj.wsHost);
    return {
      region: obj.region || "us-east-1",
      issuerUrl: obj.issuerUrl || "",
      wsHost,
      clientId: obj.clientId,
      clientSecret: obj.clientSecret,
      refreshToken: obj.refreshToken,
      ...(obj.accessToken ? { accessToken: obj.accessToken } : {}),
      ...(typeof obj.expiresAt === "number" ? { expiresAt: obj.expiresAt } : {}),
      ...(obj.accountId ? { accountId: obj.accountId } : {}),
      ...(obj.email ? { email: obj.email } : {}),
      ...(obj.name ? { name: obj.name } : {}),
    };
  } catch {
    return null;
  }
}

const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

function oidcBaseUrl(region: string): string {
  const clean = region.trim();
  if (!AWS_REGION_RE.test(clean)) {
    throw new Error(`Invalid AWS region: ${clean}`);
  }
  return `https://oidc.${clean}.amazonaws.com`;
}

function extractEmailFromIdToken(idToken?: string | null): string | undefined {
  if (!idToken || typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const k of ["email", "preferred_username", "name"]) {
      const v = claims[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {}
  return undefined;
}

async function exchangeAuthCode(flow: PendingOAuthFlow, code: string): Promise<OAuthCredential> {
  const resp = await fetchViaOptionalProxy(
    `${oidcBaseUrl(flow.region)}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        grantType: "authorization_code",
        code,
        redirectUri: flow.redirectUri,
        codeVerifier: flow.codeVerifier,
      }),
    },
    flow.proxyUrl,
  );
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`OIDC token exchange failed (${resp.status}): ${text.slice(0, 240)}`);
  }
  const data = JSON.parse(text) as {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string | null;
    expiresIn?: number;
  };
  if (!data.accessToken || !data.refreshToken) {
    throw new Error("OIDC token response missing accessToken or refreshToken.");
  }
  const expiresAt = Date.now() + Math.max(300, Number(data.expiresIn || 3600)) * 1000;
  const email = extractEmailFromIdToken(data.idToken);
  const cred: OAuthCredential = {
    region: flow.region,
    issuerUrl: flow.issuerUrl,
    wsHost: flow.wsHost,
    clientId: flow.clientId,
    clientSecret: flow.clientSecret,
    refreshToken: data.refreshToken,
    accessToken: data.accessToken,
    expiresAt,
    ...(flow.accountId ? { accountId: flow.accountId } : {}),
    ...(email ? { email } : {}),
  };
  tokenCache.set(flow.clientId, {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt,
  });
  // Best-effort single WS connected-frame handshake to capture real user email & display name
  const wsIdentity = await fetchOAuthUserIdentity(cred, flow.proxyUrl).catch(() => null);
  if (wsIdentity) {
    if (wsIdentity.email && !cred.email) cred.email = wsIdentity.email;
    if (wsIdentity.name && !cred.name) cred.name = wsIdentity.name;
    if (wsIdentity.accountId && !cred.accountId) cred.accountId = wsIdentity.accountId;
  }
  return cred;
}

/**
 * Start a cross-platform AWS IAM Identity Center OIDC PKCE login flow.
 * Works on macOS, Linux, Windows, and Docker without Amazon Quick.app.
 */
export async function startOAuthPkceFlow(params: {
  discoveryCallbackUrl?: string;
  issuerUrl?: string;
  wsHost?: string;
  region?: string;
  accountId?: string;
  callbackPort?: number;
  proxyUrl?: string;
  onCompleted?: (cred: OAuthCredential) => void;
}): Promise<{ flowId: string; authUrl: string; redirectUri: string; issuerUrl: string; wsHost: string; region: string; accountId?: string }> {
  const discovered = params.discoveryCallbackUrl?.trim()
    ? parseOAuthDiscoveryCallback(params.discoveryCallbackUrl)
    : null;
  const region = (params.region || discovered?.region || "us-east-1").trim();
  const issuerUrl = (params.issuerUrl || discovered?.issuerUrl || DEFAULT_OAUTH_ISSUER_URL).trim();
  const wsHostRaw = (params.wsHost || discovered?.wsHost || DEFAULT_OAUTH_WS_HOST).trim();
  const accountId = (params.accountId || discovered?.accountId || "").trim() || undefined;
  if (!issuerUrl || !wsHostRaw) {
    throw new Error(
      "Please paste the discovery callback URL (http://localhost:18080/callback?...) or provide issuerUrl & wsHost.",
    );
  }
  const wsHost = sanitizeAwsQuickWsHost(wsHostRaw);

  // Bind a temporary local HTTP server for automatic browser callback (falls back to ephemeral port)
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => {
      // Fallback to ephemeral port 0 if preferred port is busy
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.listen(params.callbackPort ?? 18080, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 18080;
  const redirectUri = `http://127.0.0.1:${port}`;

  // Step 1: Dynamic public client registration (90-day clientSecret)
  const grantedScopes = ["quicksight:read_write"];
  let reg: { clientId?: string; clientSecret?: string };
  try {
    const regResp = await fetchViaOptionalProxy(
      `${oidcBaseUrl(region)}/client/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: "AmazonQuick-Desktop",
          clientType: "public",
          scopes: grantedScopes,
          grantTypes: ["authorization_code", "refresh_token"],
          redirectUris: [redirectUri],
          issuerUrl,
        }),
      },
      params.proxyUrl,
    );
    const regText = await regResp.text();
    if (!regResp.ok) {
      throw new Error(`OIDC client/register failed (${regResp.status}): ${regText.slice(0, 240)}`);
    }
    reg = JSON.parse(regText) as { clientId?: string; clientSecret?: string };
    if (!reg.clientId || !reg.clientSecret) {
      throw new Error("OIDC client/register did not return clientId/clientSecret.");
    }
  } catch (err) {
    try { server.close(); } catch {}
    throw err;
  }

  // Step 2: PKCE S256 challenge + authorization URL
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(32));
  const flowId = `oauth_${crypto.randomBytes(6).toString("hex")}`;

  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: reg.clientId,
    redirect_uri: redirectUri,
    scopes: grantedScopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authUrl = `${oidcBaseUrl(region)}/authorize?${authParams.toString()}`;

  const flow: PendingOAuthFlow = {
    flowId,
    region,
    issuerUrl,
    wsHost,
    ...(accountId ? { accountId } : {}),
    clientId: reg.clientId,
    clientSecret: reg.clientSecret,
    redirectUri,
    codeVerifier,
    state,
    authUrl,
    createdAt: Date.now(),
    status: "pending",
    ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
    server,
  };
  activeFlows.set(flowId, flow);

  // Automatic local callback handler
  let callbackHandled = false;
  server.on("request", async (req, res) => {
    try {
      if (callbackHandled || flow.status === "completed") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h3>AWS Quick authorization complete! You can close this tab and return to aws-quick2api.</h3>");
        return;
      }
      const reqUrl = new URL(req.url || "/", redirectUri);
      const code = reqUrl.searchParams.get("code");
      const cbState = reqUrl.searchParams.get("state");
      if (!code || cbState !== flow.state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h3>Invalid OAuth callback (missing code or state mismatch).</h3>");
        return;
      }
      callbackHandled = true;
      const cred = await exchangeAuthCode(flow, code);
      flow.status = "completed";
      flow.credential = cred;
      params.onCompleted?.(cred);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h3>AWS Quick authorization complete! You can close this tab and return to aws-quick2api.</h3>");
      setTimeout(() => { try { server.close(); } catch {} }, 500);
    } catch (err) {
      callbackHandled = false;
      flow.status = "error";
      flow.error = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h3>Authorization failed: ${escapeHtml(flow.error)}</h3>`);
    }
  });

  // Auto-cleanup after 10 minutes
  setTimeout(() => {
    const cur = activeFlows.get(flowId);
    if (cur) {
      try { cur.server?.close(); } catch {}
      activeFlows.delete(flowId);
    }
  }, 10 * 60_000).unref();

  return {
    flowId,
    authUrl,
    redirectUri,
    issuerUrl,
    wsHost,
    region,
    ...(accountId ? { accountId } : {}),
  };
}

/**
 * Manual callback completion (for headless Linux / Docker / SSH where the browser redirects
 * on the user's laptop and the user pastes `http://127.0.0.1:<port>/?code=...&state=...`).
 */
export async function completeOAuthPkceCallback(
  flowId: string,
  callbackUrlOrCode: string,
): Promise<OAuthCredential> {
  const flow = activeFlows.get(flowId);
  if (!flow) {
    throw new Error("OAuth login session expired or not found. Please start a new login.");
  }
  if (flow.status === "completed" && flow.credential) {
    return flow.credential;
  }

  let code = callbackUrlOrCode.trim();
  if (code.includes("code=")) {
    const parsed = new URL(code.startsWith("http") ? code : `http://127.0.0.1/?${code.replace(/^\?/, "")}`);
    const cbState = parsed.searchParams.get("state");
    if (!cbState || cbState !== flow.state) {
      throw new Error("OAuth state mismatch. Please paste the full callback URL from the current login attempt.");
    }
    code = parsed.searchParams.get("code") || "";
  }
  if (!code) {
    throw new Error("Missing `code` parameter in callback URL.");
  }

  const cred = await exchangeAuthCode(flow, code);
  flow.status = "completed";
  flow.credential = cred;
  try { flow.server?.close(); } catch {}
  return cred;
}

export function getOAuthFlowStatus(flowId: string): {
  status: "pending" | "completed" | "error" | "not_found";
  error?: string;
} {
  const flow = activeFlows.get(flowId);
  if (!flow) return { status: "not_found" };
  return { status: flow.status, ...(flow.error ? { error: flow.error } : {}) };
}

/**
 * Resolve a valid `accessToken` for an `OAuthCredential`, automatically refreshing via
 * `POST https://oidc.<region>.amazonaws.com/token` (`grantType: "refresh_token"`) whenever expired.
 */
export async function resolveOAuthAccessToken(
  cred: OAuthCredential,
  forceRefresh = false,
  proxyUrl?: string,
): Promise<{ accessToken: string; expiresAt: number; rotatedRefreshToken?: string }> {
  const now = Date.now();
  const cached = tokenCache.get(cred.clientId);
  const currentAccess = cached?.accessToken || cred.accessToken;
  const currentRefresh = cached?.refreshToken || cred.refreshToken;
  const currentExpiry = cached?.expiresAt || cred.expiresAt || 0;

  if (!forceRefresh && currentAccess && currentExpiry > now + 300_000) {
    return { accessToken: currentAccess, expiresAt: currentExpiry };
  }

  const inflight = inFlightRefresh.get(cred.clientId);
  if (inflight) return inflight;

  const refreshPromise = (async () => {
    const resp = await fetchViaOptionalProxy(
      `${oidcBaseUrl(cred.region)}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: cred.clientId,
          clientSecret: cred.clientSecret,
          grantType: "refresh_token",
          refreshToken: currentRefresh,
        }),
      },
      proxyUrl,
    );
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`OIDC refresh_token failed (${resp.status}): ${text.slice(0, 240)}`);
    }
    const data = JSON.parse(text) as {
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
    };
    if (!data.accessToken) {
      throw new Error("OIDC refresh response missing accessToken.");
    }
    const nextRefresh = data.refreshToken || currentRefresh;
    const nextExpiry = Date.now() + Math.max(300, Number(data.expiresIn || 3600)) * 1000;
    tokenCache.set(cred.clientId, {
      accessToken: data.accessToken,
      refreshToken: nextRefresh,
      expiresAt: nextExpiry,
    });
    return {
      accessToken: data.accessToken,
      expiresAt: nextExpiry,
      ...(data.refreshToken && data.refreshToken !== cred.refreshToken
        ? { rotatedRefreshToken: data.refreshToken }
        : {}),
    };
  })().finally(() => {
    inFlightRefresh.delete(cred.clientId);
  });

  inFlightRefresh.set(cred.clientId, refreshPromise);
  return refreshPromise;
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Operation aborted by client.");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Operation aborted by client."));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    t.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function callOAuthQbsEvent(
  cred: OAuthCredential,
  path: string,
  httpMethod: "GET" | "POST",
  bodyObj?: Record<string, unknown>,
  proxyUrl?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let forceRefresh = false;
  let lastErr: Error | undefined;
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error(`qbs-event ${path} aborted by client.`);
    const { accessToken } = await resolveOAuthAccessToken(cred, forceRefresh, proxyUrl);
    forceRefresh = false;
    const surfaceType =
      process.platform === "win32" ? "QUICK_WORK_DESKTOP_WINDOWS" : "QUICK_WORK_DESKTOP_MAC";
    const outpostId = deriveStableOutpostId(cred.clientId);
    const resp = await fetchViaOptionalProxy(
      `https://${cred.wsHost}/integration/quick-work/qbs-event`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": QUICK_DESKTOP_USER_AGENT,
          Authorization: `Bearer ${accessToken}`,
          "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          eventType: "invokeAgent",
          eventBody: {
            invokeAgent: {
              path,
              queryParams: {
                surfaceType,
                appVersion: QUICK_APP_VERSION,
                _method: httpMethod,
              },
              body: bodyObj ?? {},
              outpostId,
            },
          },
        }),
        ...(signal ? { signal } : {}),
      },
      proxyUrl,
    );
    if (resp.status === 401 && attempt === 0) {
      forceRefresh = true;
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt + 1 < maxAttempts) {
      lastErr = new Error(`qbs-event ${path} failed (${resp.status})`);
      const jitterMs = 750 + Math.floor(Math.random() * 750);
      await sleepWithAbort(jitterMs * (attempt + 1), signal);
      continue;
    }
    if (!resp.ok) {
      throw new Error(`qbs-event ${path} failed (${resp.status})`);
    }
    const envelope = (await resp.json()) as { eventResponse?: { invokeAgentResponse?: string | { body?: string } } };
    const rawInv = envelope?.eventResponse?.invokeAgentResponse;
    const apiResp = typeof rawInv === "string" ? (JSON.parse(rawInv) as { body?: string }) : rawInv;
    return typeof apiResp?.body === "string" ? JSON.parse(apiResp.body) : {};
  }
  throw lastErr ?? new Error(`qbs-event ${path} failed after retries`);
}

export async function fetchOAuthProfileUsage(
  cred: OAuthCredential,
  proxyUrl?: string,
): Promise<QuickQuotaUsage> {
  const data = await callOAuthQbsEvent(cred, "profile/usage", "GET", undefined, proxyUrl);
  return (data && typeof data === "object" ? data : {}) as QuickQuotaUsage;
}

export interface QuickFileAttachment {
  type: "file";
  name: string;
  size: number;
  mimeType: string;
  path: string;
  attachmentId: string;
  contentSha256: string;
}

export type DlpPollDecision =
  | { state: "ready" }
  | { state: "pending" }
  | { state: "failed"; reason: string };

/**
 * Evaluates a single `attachment-dlp-status` JSON payload using official AWS Quick semantics:
 * - `COMPLETED` / `COMPLETE` / `SUCCESS` / `SKIPPED` / `NOT_APPLICABLE`: ready unless `policyAction` blocks/denies.
 * - `FAILED` / `ERROR` / `REJECTED` / `BLOCKED`: terminal failure (do not proceed to `files/upload`).
 * - Anything else (`PENDING` / `IN_PROGRESS` / `SCANNING` / empty): keep polling.
 */
export function evaluateDlpPollResponse(dlpJson: {
  dlpJobStatus?: string;
  status?: string;
  policyAction?: string;
  action?: string;
}): DlpPollDecision {
  const status = String(dlpJson.dlpJobStatus || dlpJson.status || "").trim().toUpperCase();
  const action = String(dlpJson.policyAction || dlpJson.action || "").trim().toUpperCase();
  if (action === "BLOCK" || action === "BLOCKED" || action === "DENY" || action === "REJECT") {
    return { state: "failed", reason: `Attachment blocked by AWS Quick DLP policy (${action}).` };
  }
  if (status === "FAILED" || status === "ERROR" || status === "REJECTED" || status === "BLOCKED") {
    return { state: "failed", reason: `Attachment DLP scan failed (${status}).` };
  }
  if (
    status === "COMPLETED" ||
    status === "COMPLETE" ||
    status === "SUCCESS" ||
    status === "SKIPPED" ||
    status === "NOT_APPLICABLE"
  ) {
    return { state: "ready" };
  }
  return { state: "pending" };
}

const MAX_DLP_POLL_ATTEMPTS = 40;
const DLP_POLL_INTERVAL_MS = 1_500;

/**
 * Upload an oversized UTF-8 text payload (>46KB) out-of-band via AWS Quick's official
 * 3-step AIDP attachment pipeline (`upload-attachment` -> `attachment-dlp-status` -> `files/upload/{threadId}`),
 * allowing 400KB+ contexts to be delivered in a single ~300-byte WS `user_message` frame
 * instead of multi-turn 50KB chunking.
 */
export async function uploadOAuthTextAttachment(
  cred: OAuthCredential,
  threadId: string,
  filename: string,
  textContent: string,
  proxyUrl?: string,
  signal?: AbortSignal,
): Promise<QuickFileAttachment> {
  if (signal?.aborted) throw new Error("Attachment upload aborted by client.");
  let { accessToken } = await resolveOAuthAccessToken(cred, false, proxyUrl);
  const buf = Buffer.from(textContent, "utf8");
  const contentSha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const mimeType = "text/plain";

  // Step 1: Upload raw bytes (with 1 forced-refresh retry on 401)
  const upUrl =
    `https://${cred.wsHost}/integration/quick-work/upload-attachment` +
    `?name=${encodeURIComponent(filename)}` +
    `&contentType=${encodeURIComponent(mimeType)}` +
    `&contentLength=${buf.byteLength}`;
  let upRes = await fetchViaOptionalProxy(
    upUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": QUICK_DESKTOP_USER_AGENT,
        "Content-Type": "application/octet-stream",
        "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
      },
      body: textContent,
      ...(signal ? { signal } : {}),
    },
    proxyUrl,
  );
  if (upRes.status === 401) {
    ({ accessToken } = await resolveOAuthAccessToken(cred, true, proxyUrl));
    upRes = await fetchViaOptionalProxy(
      upUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": QUICK_DESKTOP_USER_AGENT,
          "Content-Type": "application/octet-stream",
          "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
        },
        body: textContent,
        ...(signal ? { signal } : {}),
      },
      proxyUrl,
    );
  }
  if (!upRes.ok) {
    throw new Error(`upload-attachment failed (${upRes.status})`);
  }
  const upJson = (await upRes.json()) as { attachmentId?: string; id?: string };
  const attachmentId = (upJson.attachmentId || upJson.id || "").trim();
  if (!attachmentId) {
    throw new Error("upload-attachment returned empty attachmentId");
  }

  // Step 2: Poll DLP status (up to 40 × 1.5s = 60s; transient 429/5xx/network jitter retries;
  // terminal FAILED/ERROR/BLOCK or timeout throws cleanly instead of proceeding unscanned).
  const dlpUrl = `https://${cred.wsHost}/integration/quick-work/attachment-dlp-status?attachmentId=${encodeURIComponent(attachmentId)}`;
  let dlpReady = false;
  let refreshedOnDlp401 = false;
  for (let poll = 0; poll < MAX_DLP_POLL_ATTEMPTS; poll += 1) {
    if (signal?.aborted) throw new Error("Attachment DLP poll aborted by client.");
    let dlpRes: Awaited<ReturnType<typeof fetchViaOptionalProxy>>;
    try {
      dlpRes = await fetchViaOptionalProxy(
        dlpUrl,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": QUICK_DESKTOP_USER_AGENT,
            "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
          },
          ...(signal ? { signal } : {}),
        },
        proxyUrl,
      );
    } catch (err) {
      if (signal?.aborted || poll + 1 >= MAX_DLP_POLL_ATTEMPTS) throw err;
      const jitterMs = 750 + Math.floor(Math.random() * 750);
      await sleepWithAbort(jitterMs, signal);
      continue;
    }

    if (dlpRes.status === 401 && !refreshedOnDlp401) {
      refreshedOnDlp401 = true;
      ({ accessToken } = await resolveOAuthAccessToken(cred, true, proxyUrl));
      continue;
    }
    if (dlpRes.status === 429 || dlpRes.status >= 500) {
      if (poll + 1 >= MAX_DLP_POLL_ATTEMPTS) {
        throw new Error(`attachment-dlp-status failed (${dlpRes.status})`);
      }
      const jitterMs = 750 + Math.floor(Math.random() * 750);
      await sleepWithAbort(jitterMs, signal);
      continue;
    }
    if (!dlpRes.ok) {
      throw new Error(`attachment-dlp-status failed (${dlpRes.status})`);
    }
    const dlpJson = (await dlpRes.json()) as {
      dlpJobStatus?: string;
      status?: string;
      policyAction?: string;
      action?: string;
    };
    const decision = evaluateDlpPollResponse(dlpJson);
    if (decision.state === "failed") {
      throw new Error(decision.reason);
    }
    if (decision.state === "ready") {
      dlpReady = true;
      break;
    }
    if (poll + 1 < MAX_DLP_POLL_ATTEMPTS) {
      await sleepWithAbort(DLP_POLL_INTERVAL_MS, signal);
    }
  }
  if (!dlpReady) {
    throw new Error(`Attachment DLP scan timed out after ${Math.round((MAX_DLP_POLL_ATTEMPTS * DLP_POLL_INTERVAL_MS) / 1000)}s.`);
  }

  // Step 3: Bind attachment to the session workspace via qbs-event `files/upload/{threadId}`
  const bindData = (await callOAuthQbsEvent(
    cred,
    `files/upload/${threadId}`,
    "POST",
    { attachmentId },
    proxyUrl,
    signal,
  )) as { path?: string; files?: Array<{ path?: string }> };
  const serverPath = String(bindData?.path || bindData?.files?.[0]?.path || "").trim();
  if (!serverPath) {
    throw new Error("files/upload did not return a workspace serverPath");
  }

  return {
    type: "file",
    name: filename,
    size: buf.byteLength,
    mimeType,
    path: serverPath,
    attachmentId,
    contentSha256,
  };
}

export async function listOAuthCloudSessions(
  cred: OAuthCredential,
  limit = 50,
  proxyUrl?: string,
): Promise<CloudSessionMeta[]> {
  const data = (await callOAuthQbsEvent(
    cred,
    "api/ws-rpc",
    "POST",
    {
      type: "session_list",
      payload: { limit },
    },
    proxyUrl,
  )) as { frames?: Array<{ type?: string; payload?: { sessions?: CloudSessionMeta[] } }> };
  const frame = (data?.frames || []).find((f) => f.type === "session_list");
  return (frame?.payload?.sessions || []).map((s) => ({
    id: String(s.id),
    title: String(s.title || "(Untitled)"),
    created_at: Number(s.created_at || 0),
    updated_at: Number(s.updated_at || 0),
    message_count: Number(s.message_count || 0),
  }));
}
