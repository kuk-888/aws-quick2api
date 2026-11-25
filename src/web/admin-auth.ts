import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type http from "node:http";
import { persistAdminPasswordToEnvFile } from "../core/config.js";
import { GatewayError, type GatewayConfig } from "../core/types.js";
import { safeStringEquals } from "../utils/hash.js";

const SESSION_COOKIE_NAME = "cgw_admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isLoopbackAddress(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Best-effort client IP.
 * Only honors `X-Forwarded-For` / `X-Real-IP` when `trustProxy === "all"` or the socket peer is loopback
 * (`trustProxy === "loopback"`, the default). Set `TRUST_PROXY=off` when exposed directly without a proxy.
 */
export function clientIpOf(
  req: http.IncomingMessage,
  trustProxy: "loopback" | "all" | "off" = "loopback"
): string {
  const peer = req.socket?.remoteAddress || "unknown";
  const trusted = trustProxy === "all" || (trustProxy === "loopback" && isLoopbackAddress(peer));
  if (trusted) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff.join(",") : xff;
    if (raw) {
      const last = raw.split(",").map((s) => s.trim()).filter(Boolean).pop();
      if (last) return last.slice(0, 64);
    }
    const realIp = req.headers["x-real-ip"];
    const realRaw = Array.isArray(realIp) ? realIp[0] : realIp;
    if (realRaw?.trim()) return realRaw.trim().slice(0, 64);
  }
  return peer;
}

/** Sliding-window failure throttle for admin credentials, per IP. */
export class AuthFailureThrottle {
  private readonly perIp = new Map<string, number[]>();
  constructor(
    private readonly maxPerIp = 8,
    private readonly windowMs = 15 * 60 * 1000
  ) {}

  private prune(list: number[], now: number): number[] {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < list.length && list[i]! < cutoff) i++;
    return i ? list.slice(i) : list;
  }

  /** Throws 429 when this IP is over its failure budget. One attacker can never lock out other IPs. */
  assertAllowed(ip: string, now = Date.now()): void {
    const mine = this.prune(this.perIp.get(ip) ?? [], now);
    if (mine.length) this.perIp.set(ip, mine); else this.perIp.delete(ip);
    if (mine.length >= this.maxPerIp) {
      const retry = Math.max(1, Math.ceil((mine[0]! + this.windowMs - now) / 1000));
      const err = new GatewayError("Too many failed attempts. Try again later.", 429, "rate_limit_exceeded");
      (err as GatewayError & { retryAfter?: number }).retryAfter = retry;
      throw err;
    }
  }

  recordFailure(ip: string, now = Date.now()): void {
    const mine = this.prune(this.perIp.get(ip) ?? [], now);
    mine.push(now);
    // Re-insert so Map order tracks recency; evict only the single stalest IP when full
    // (never clear the whole map: an attacker spraying spoofed IPs must not reset their own counter).
    this.perIp.delete(ip);
    this.perIp.set(ip, mine);
    if (this.perIp.size > 5000) {
      const oldest = this.perIp.keys().next().value;
      if (oldest !== undefined) this.perIp.delete(oldest);
    }
  }

  recordSuccess(ip: string): void {
    this.perIp.delete(ip);
  }
}

const FORWARDED_PROXY_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
] as const;

export function isDirectLoopbackRequest(req: http.IncomingMessage): boolean {
  for (const h of FORWARDED_PROXY_HEADERS) {
    if (req.headers[h]) return false;
  }
  const hostHeader = typeof req.headers.host === "string" ? req.headers.host.trim().toLowerCase() : "";
  if (hostHeader) {
    const hostWithoutPort = hostHeader.startsWith("[")
      ? hostHeader.slice(1, hostHeader.indexOf("]") > 0 ? hostHeader.indexOf("]") : undefined)
      : hostHeader.split(":")[0]!;
    if (hostWithoutPort !== "127.0.0.1" && hostWithoutPort !== "localhost" && hostWithoutPort !== "::1") {
      return false;
    }
  }
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function isLoopbackPeer(req: http.IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Secure cookies only for TLS sockets or a same-host reverse proxy (loopback + forwarded IP). Client-forged `x-forwarded-proto` on a direct HTTP socket is ignored. */
export function requestIsHttps(
  req: http.IncomingMessage,
  trustProxy: "loopback" | "all" | "off" = "loopback"
): boolean {
  const sock = req.socket as { encrypted?: boolean } | undefined;
  if (sock?.encrypted) return true;
  if (trustProxy === "off") return false;
  const proto = req.headers["x-forwarded-proto"];
  const protoVal = (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim().toLowerCase();
  if (protoVal !== "https") return false;
  if (trustProxy === "loopback" && !isLoopbackPeer(req)) return false;
  return Boolean(req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
}

/**
 * Lightweight, pure HMAC session authenticator for the optional Web Console (`src/web/`).
 * Per-IP login failure throttling lives here; coarse network limits belong to the proxy (Caddy / fail2ban).
 */
export class AdminAuthManager {
  private signingSecret: Buffer;
  private adminPassword?: string;
  private readonly envFilePath?: string;
  private readonly trustProxy: "loopback" | "all" | "off";
  readonly throttle = new AuthFailureThrottle();
  /** Bearer attempts against admin routes are counted apart from the login form, so API-client probing cannot lock the admin out. */
  readonly bearerThrottle = new AuthFailureThrottle();

  constructor(
    config: Pick<GatewayConfig, "adminPassword" | "envFilePath"> &
      Partial<Pick<GatewayConfig, "gatewayTokens" | "dataDir" | "trustProxy">>
  ) {
    this.adminPassword = config.adminPassword;
    this.envFilePath = config.envFilePath;
    this.trustProxy = config.trustProxy ?? "loopback";
    const stateDir = config.dataDir ?? (this.envFilePath ? path.dirname(this.envFilePath) : undefined);
    // Random secret (never derived from the password) persisted beside state files so sessions survive restarts.
    this.secretFilePath = stateDir ? path.join(stateDir, "admin-session.key") : undefined;
    this.signingSecret = this.loadOrCreateSecret();
  }

  private readonly secretFilePath?: string;

  private loadOrCreateSecret(): Buffer {
    if (this.secretFilePath && existsSync(this.secretFilePath)) {
      try {
        const buf = Buffer.from(readFileSync(this.secretFilePath, "utf8").trim(), "hex");
        if (buf.length === 32) return buf;
      } catch {
        // fall through and regenerate
      }
    }
    return this.rotateSecret();
  }

  /** Generate (and persist when possible) a fresh signing secret; invalidates every existing session. */
  private rotateSecret(): Buffer {
    const secret = crypto.randomBytes(32);
    if (this.secretFilePath) {
      try {
        mkdirSync(path.dirname(this.secretFilePath), { recursive: true });
        writeFileSync(this.secretFilePath, secret.toString("hex") + "\n", { mode: 0o600 });
        chmodSync(this.secretFilePath, 0o600);
      } catch {
        // read-only dir: sessions simply won't survive a restart
      }
    }
    return secret;
  }

  isPasswordConfigured(): boolean {
    return Boolean(this.adminPassword);
  }

  verifyPasswordAndIssueSession(candidatePassword: string, ip = "unknown"): {
    token: string;
    maxAgeSeconds: number;
  } {
    if (!this.adminPassword) {
      throw new GatewayError(
        "Admin console is disabled: set ADMIN_PASSWORD in .env and restart.",
        503,
        "admin_disabled"
      );
    }
    this.throttle.assertAllowed(ip);
    const trimmed = candidatePassword.trim();
    if (!trimmed) {
      throw new GatewayError("Please enter the admin password.", 401, "invalid_password");
    }

    const matched = safeStringEquals(trimmed, this.adminPassword);

    if (!matched) {
      this.throttle.recordFailure(ip);
      throw new GatewayError("Invalid admin password.", 401, "invalid_password");
    }

    this.throttle.recordSuccess(ip);
    return this.issueSessionToken();
  }

  private issueSessionToken(): { token: string; maxAgeSeconds: number } {
    const expMs = Date.now() + SESSION_TTL_MS;
    const nonce = crypto.randomBytes(8).toString("hex");
    const payload = `v1.${expMs}.${nonce}`;
    const sig = crypto.createHmac("sha256", this.signingSecret).update(payload).digest("base64url");
    return {
      token: `adm_${payload}.${sig}`,
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000)
    };
  }

  updatePassword(newPassword: string): { token: string; maxAgeSeconds: number } {
    const trimmed = newPassword.trim();
    if (trimmed.length < 8) {
      throw new GatewayError("New admin password must be at least 8 characters.", 400, "invalid_password");
    }
    if (/[\x00-\x1f\x7f]/.test(trimmed) || trimmed.length > 128) {
      throw new GatewayError("New admin password must be 128 chars or fewer with no control characters.", 400, "invalid_password");
    }
    this.adminPassword = trimmed;
    this.signingSecret = this.rotateSecret();
    persistAdminPasswordToEnvFile(this.envFilePath, trimmed);
    return this.issueSessionToken();
  }

  setupInitialPassword(newPassword: string): { token: string; maxAgeSeconds: number } {
    if (this.isPasswordConfigured()) {
      throw new GatewayError("Initial setup has already been completed.", 403, "setup_already_completed");
    }
    return this.updatePassword(newPassword);
  }

  verifySignedSessionToken(token: string): boolean {
    if (!token.startsWith("adm_")) return false;
    const body = token.slice(4);
    const lastDot = body.lastIndexOf(".");
    if (lastDot <= 0) return false;
    const payload = body.slice(0, lastDot);
    const sig = body.slice(lastDot + 1);
    const expectedSig = crypto.createHmac("sha256", this.signingSecret).update(payload).digest("base64url");
    if (!safeStringEquals(sig, expectedSig)) return false;

    const parts = payload.split(".");
    const expMs = Number(parts[1]);
    return Number.isFinite(expMs) && expMs > Date.now();
  }

  extractSessionFromCookie(req: http.IncomingMessage): string {
    const rawCookie = req.headers.cookie;
    if (typeof rawCookie !== "string" || !rawCookie) return "";
    for (const pair of rawCookie.split(";")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const k = pair.slice(0, eq).trim();
      if (k === SESSION_COOKIE_NAME) {
        try {
          return decodeURIComponent(pair.slice(eq + 1).trim());
        } catch {
          return "";
        }
      }
    }
    return "";
  }

  hasSessionCookie(req: http.IncomingMessage): boolean {
    return Boolean(this.extractSessionFromCookie(req));
  }

  buildSetCookieHeader(req: http.IncomingMessage, sessionToken: string, maxAgeSeconds: number): string {
    const isHttps = requestIsHttps(req, this.trustProxy);
    return [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAgeSeconds}`,
      ...(isHttps ? ["Secure"] : [])
    ].join("; ");
  }

  buildClearCookieHeader(req: http.IncomingMessage): string {
    const isHttps = requestIsHttps(req, this.trustProxy);
    return [
      `${SESSION_COOKIE_NAME}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
      ...(isHttps ? ["Secure"] : [])
    ].join("; ");
  }

  requireAdminAuth(req: http.IncomingMessage, extractedToken: string, ip = clientIpOf(req, this.trustProxy)): void {
    if (!this.isPasswordConfigured()) {
      throw new GatewayError("Admin console is disabled: set ADMIN_PASSWORD in .env and restart.", 401, "authentication_error");
    }

    const hasExplicitHeaderCred = Boolean(req.headers.authorization || req.headers["x-api-key"]);
    if (!hasExplicitHeaderCred) {
      const cookieTok = this.extractSessionFromCookie(req);
      if (cookieTok && this.verifySignedSessionToken(cookieTok)) {
        if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-console-csrf"] !== "1") {
          throw new GatewayError("Missing CSRF header.", 403, "csrf_required");
        }
        return;
      }
    }

    if (extractedToken && this.verifySignedSessionToken(extractedToken)) return;

    if (extractedToken) this.bearerThrottle.assertAllowed(ip);

    if (extractedToken && safeStringEquals(extractedToken, this.adminPassword!)) return;
    if (extractedToken) this.bearerThrottle.recordFailure(ip);
    throw new GatewayError("Unauthorized: administrator credentials required.", 401, "authentication_error");
  }
}
