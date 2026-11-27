import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);

// Bounded TTL DNS cache (30s) strictly for upstream AWS Quick & proxy hosts (never used for user SSRF URL checks).
const UPSTREAM_DNS_TTL_MS = 30_000;
const MAX_UPSTREAM_DNS_CACHE = 256;
interface CachedDnsEntry {
  expiresAt: number;
  addresses: dns.LookupAddress[];
}
const upstreamDnsCache = new Map<string, CachedDnsEntry>();

function cachedUpstreamLookup(
  hostname: string,
  options: dns.LookupAllOptions | dns.LookupOneOptions | number,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  const opts = typeof options === "number" ? { family: options } : options || {};
  const wantAll = Boolean((opts as dns.LookupAllOptions).all);
  const reqFamily = opts.family === 4 || opts.family === 6 ? opts.family : 0;
  const cacheKey = `${hostname.toLowerCase()}|${reqFamily}`;
  const now = Date.now();
  const hit = upstreamDnsCache.get(cacheKey);
  if (hit && hit.expiresAt > now && hit.addresses.length > 0) {
    if (wantAll) {
      callback(null, hit.addresses.map((a) => ({ address: a.address, family: a.family })));
    } else {
      const first = hit.addresses[0]!;
      callback(null, first.address, first.family);
    }
    return;
  }
  dns.lookup(hostname, { ...(reqFamily ? { family: reqFamily } : {}), all: true }, (err, addresses) => {
    if (err || !Array.isArray(addresses) || addresses.length === 0) {
      callback(err, wantAll ? [] : "", 0);
      return;
    }
    if (upstreamDnsCache.size >= MAX_UPSTREAM_DNS_CACHE) {
      const oldest = upstreamDnsCache.keys().next().value;
      if (oldest) upstreamDnsCache.delete(oldest);
    }
    upstreamDnsCache.set(cacheKey, {
      expiresAt: Date.now() + UPSTREAM_DNS_TTL_MS,
      addresses,
    });
    if (wantAll) {
      callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    } else {
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    }
  });
}

// Bounded single-use TLS 1.3 session ticket cache for tunneled proxy connections (enables 1-RTT TLS resumption).
const MAX_TLS_SESSION_HOSTS = 128;
const MAX_TLS_TICKETS_PER_HOST = 4;
const proxyTlsSessions = new Map<string, Buffer[]>();

function popProxyTlsSession(key: string): Buffer | undefined {
  const list = proxyTlsSessions.get(key);
  if (!list || list.length === 0) return undefined;
  const ticket = list.pop();
  if (list.length === 0) proxyTlsSessions.delete(key);
  return ticket;
}

function pushProxyTlsSession(key: string, session: Buffer): void {
  let list = proxyTlsSessions.get(key);
  if (!list) {
    if (proxyTlsSessions.size >= MAX_TLS_SESSION_HOSTS) {
      const oldest = proxyTlsSessions.keys().next().value;
      if (oldest) proxyTlsSessions.delete(oldest);
    }
    list = [];
    proxyTlsSessions.set(key, list);
  }
  if (list.length >= MAX_TLS_TICKETS_PER_HOST) list.shift();
  list.push(session);
}

function connectTunneledTls(socket: Duplex, servername: string, targetPort: number): tls.TLSSocket {
  const sessionKey = `${servername.toLowerCase()}:${targetPort}`;
  const session = popProxyTlsSession(sessionKey);
  const tlsSocket = tls.connect({
    socket,
    servername,
    ...(session ? { session } : {}),
  });
  tlsSocket.setNoDelay?.(true);
  tlsSocket.on("session", (newSession: Buffer) => {
    pushProxyTlsSession(sessionKey, newSession);
  });
  tlsSocket.once("error", () => {
    proxyTlsSessions.delete(sessionKey);
  });
  return tlsSocket;
}

// Shared direct-upstream agents: keeps direct HTTPS connections warm for 60s (vs undici's 4s drop)
// and gives direct WebSocket dials 1-RTT TLS session resumption + cached DNS.
const directHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  timeout: 60_000,
  maxSockets: 64,
  maxFreeSockets: 16,
  maxCachedSessions: 128,
  lookup: cachedUpstreamLookup as unknown as typeof dns.lookup,
});

const directHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  timeout: 60_000,
  maxSockets: 64,
  maxFreeSockets: 16,
  lookup: cachedUpstreamLookup as unknown as typeof dns.lookup,
});

const directWsAgent = new https.Agent({
  keepAlive: false,
  maxCachedSessions: 128,
  lookup: cachedUpstreamLookup as unknown as typeof dns.lookup,
});

export function getDirectWsAgent(): https.Agent {
  return directWsAgent;
}

/**
 * Mask credentials in a proxy URL for safe display/logging (`http://user:pass@1.2.3.4:8080` -> `http://***@1.2.3.4:8080`).
 */
export function maskProxyUrl(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  try {
    const normalized = validateProxyUrl(raw) || raw.trim();
    const u = new URL(normalized);
    if (u.username || u.password) {
      return `${u.protocol}//***@${u.host}`;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return "***";
  }
}

/**
 * Normalizes and validates a proxy URL.
 * Supports standard URLs (`http://`, `https://`, `socks5://`, `socks5h://`, with optional `user:pass@`)
 * as well as common provider shorthands:
 *   - `host:port`             -> `http://host:port`
 *   - `user:pass@host:port`   -> `http://user:pass@host:port`
 *   - `host:port:user:pass`   -> `http://user:pass@host:port`
 */
export function validateProxyUrl(raw: string | undefined): string | undefined {
  const trimmed = (raw || "").trim();
  if (!trimmed) return undefined;
  if (/\s/.test(trimmed)) {
    throw new Error("Invalid proxy URL: whitespace is not allowed.");
  }

  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (candidate.includes("@")) {
      // user:pass@host:port
      candidate = `http://${candidate}`;
    } else {
      const parts = candidate.split(":");
      if (parts.length >= 4 && /^\d{1,5}$/.test(parts[1]!)) {
        // host:port:user:pass (password itself may contain ':')
        const host = parts[0]!;
        const port = Number(parts[1]!);
        const user = parts[2]!;
        const pass = parts.slice(3).join(":");
        if (!host || port < 1 || port > 65535) {
          throw new Error("Invalid proxy shorthand host:port:user:pass.");
        }
        candidate = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
      } else if (parts.length === 2 && /^\d{1,5}$/.test(parts[1]!)) {
        // host:port
        const port = Number(parts[1]!);
        if (!parts[0] || port < 1 || port > 65535) {
          throw new Error("Invalid proxy shorthand host:port.");
        }
        candidate = `http://${parts[0]}:${port}`;
      } else {
        throw new Error(
          "Invalid proxy format (supported: http://, https://, socks5://, host:port, user:pass@host:port, host:port:user:pass).",
        );
      }
    }
  }

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    throw new Error("Invalid proxy URL format.");
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(u.protocol)) {
    throw new Error("Only http://, https://, socks5://, and socks5h:// proxy URLs are supported.");
  }
  if (!u.hostname) {
    throw new Error("Proxy URL is missing hostname.");
  }
  if (u.port) {
    const p = Number(u.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error("Proxy URL has an invalid port.");
    }
  }
  return candidate;
}

class HttpConnectTunnelAgent extends https.Agent {
  private readonly proxyUrl: URL;

  constructor(proxyUrl: string) {
    // 20s idle free-socket timeout prevents reusing NAT-dropped sockets on residential proxies.
    super({ keepAlive: true, keepAliveMsecs: 15_000, timeout: 20_000, maxSockets: 64, maxFreeSockets: 16 });
    this.proxyUrl = new URL(proxyUrl);
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const targetHost = String(options.host || options.hostname || "");
    const targetPort = Number(options.port || 443);
    const proxyHost = this.proxyUrl.hostname;
    const proxyPort = Number(this.proxyUrl.port || (this.proxyUrl.protocol === "https:" ? 443 : 80));

    const headers: Record<string, string> = {
      Host: `${targetHost}:${targetPort}`,
    };
    if (this.proxyUrl.username || this.proxyUrl.password) {
      const auth = Buffer.from(
        `${decodeURIComponent(this.proxyUrl.username)}:${decodeURIComponent(this.proxyUrl.password)}`,
      ).toString("base64");
      headers["Proxy-Authorization"] = `Basic ${auth}`;
    }

    const reqFn = this.proxyUrl.protocol === "https:" ? https.request : http.request;
    const req = reqFn({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers,
    });
    let settled = false;
    const done = (err: Error | null, stream?: Duplex) => {
      if (settled) return;
      settled = true;
      callback?.(err, stream as Duplex);
    };

    req.setTimeout(10_000, () => {
      req.destroy(new Error("Proxy CONNECT handshake timed out after 10s"));
    });

    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`Proxy CONNECT failed (${res.statusCode} ${res.statusMessage || ""})`), socket);
        return;
      }
      socket.setNoDelay?.(true);
      if (options.protocol === "http:") {
        done(null, socket);
        return;
      }
      const tlsSocket = connectTunneledTls(socket, options.servername || targetHost, targetPort);
      done(null, tlsSocket);
    });

    req.once("error", (err) => {
      done(err);
    });
    req.end();

    return undefined;
  }
}

/**
 * Zero-dependency RFC 1928 / RFC 1929 SOCKS5 tunnel handshake over a raw TCP socket.
 * Uses ATYP=0x03 (domain name) so DNS resolves on the proxy side without local DNS leaks.
 */
export function establishSocks5Tunnel(
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  timeoutMs = 10_000,
): Promise<net.Socket> {
  const proxyHost = proxyUrl.hostname;
  const proxyPort = Number(proxyUrl.port || 1080);
  const username = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : "";
  const password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : "";
  const hasAuth = Boolean(username || password);

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({
      host: proxyHost,
      port: proxyPort,
      lookup: cachedUpstreamLookup as unknown as typeof dns.lookup,
    });
    socket.setNoDelay(true);
    let settled = false;
    let stage: "greeting" | "auth" | "connect" = "greeting";
    let buf: Buffer = Buffer.alloc(0);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      socket.destroy();
      reject(err);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      resolve(socket);
    };

    const timer = setTimeout(() => fail(new Error("SOCKS5 proxy handshake timed out")), timeoutMs);
    timer.unref?.();

    const sendConnect = () => {
      stage = "connect";
      const hostBytes = Buffer.from(targetHost, "utf8");
      if (hostBytes.length === 0 || hostBytes.length > 255) {
        fail(new Error(`Invalid SOCKS5 target host length: ${targetHost}`));
        return;
      }
      const req = Buffer.alloc(7 + hostBytes.length);
      req[0] = 0x05; // VER
      req[1] = 0x01; // CMD = CONNECT
      req[2] = 0x00; // RSV
      req[3] = 0x03; // ATYP = DOMAINNAME
      req[4] = hostBytes.length;
      hostBytes.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hostBytes.length);
      socket.write(req);
    };

    socket.once("connect", () => {
      if (hasAuth) {
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      } else {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      }
    });

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const ver = buf[0]!;
        const method = buf[1]!;
        buf = buf.subarray(2);
        if (ver !== 0x05) {
          fail(new Error(`Unsupported SOCKS version: ${ver}`));
          return;
        }
        if (method === 0x00) {
          sendConnect();
          return;
        }
        if (method === 0x02 && hasAuth) {
          stage = "auth";
          const uBytes = Buffer.from(username, "utf8");
          const pBytes = Buffer.from(password, "utf8");
          if (uBytes.length > 255 || pBytes.length > 255) {
            fail(new Error("SOCKS5 username or password exceeds 255 bytes."));
            return;
          }
          const authBuf = Buffer.alloc(3 + uBytes.length + pBytes.length);
          authBuf[0] = 0x01;
          authBuf[1] = uBytes.length;
          uBytes.copy(authBuf, 2);
          authBuf[2 + uBytes.length] = pBytes.length;
          pBytes.copy(authBuf, 3 + uBytes.length);
          socket.write(authBuf);
          return;
        }
        fail(new Error(`SOCKS5 proxy rejected authentication method (0x${method.toString(16)})`));
        return;
      }

      if (stage === "auth") {
        if (buf.length < 2) return;
        const status = buf[1]!;
        buf = buf.subarray(2);
        if (status !== 0x00) {
          fail(new Error(`SOCKS5 username/password authentication failed (0x${status.toString(16)})`));
          return;
        }
        sendConnect();
        return;
      }

      if (stage === "connect") {
        if (buf.length < 4) return;
        const ver = buf[0]!;
        const rep = buf[1]!;
        const atyp = buf[3]!;
        if (ver !== 0x05) {
          fail(new Error(`Invalid SOCKS5 connect response version: ${ver}`));
          return;
        }
        if (rep !== 0x00) {
          fail(new Error(`SOCKS5 CONNECT failed (code 0x${rep.toString(16)})`));
          return;
        }
        let expectedLen = 0;
        if (atyp === 0x01) {
          expectedLen = 4 + 4 + 2;
        } else if (atyp === 0x04) {
          expectedLen = 4 + 16 + 2;
        } else if (atyp === 0x03) {
          if (buf.length < 5) return;
          expectedLen = 4 + 1 + buf[4]! + 2;
        } else {
          fail(new Error(`Unsupported SOCKS5 reply address type: 0x${atyp.toString(16)}`));
          return;
        }
        if (buf.length < expectedLen) return;
        const extra = buf.subarray(expectedLen);
        succeed();
        if (extra.length > 0) socket.unshift(extra);
      }
    });

    socket.once("error", (err) => fail(err));
    socket.once("close", () => fail(new Error("SOCKS5 proxy closed connection during handshake")));
  });
}

class Socks5TunnelAgent extends https.Agent {
  private readonly proxyUrl: URL;

  constructor(proxyUrl: string) {
    // 20s idle free-socket timeout prevents reusing NAT-dropped sockets on residential proxies.
    super({ keepAlive: true, keepAliveMsecs: 15_000, timeout: 20_000, maxSockets: 64, maxFreeSockets: 16 });
    this.proxyUrl = new URL(proxyUrl);
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const targetHost = String(options.host || options.hostname || "");
    const targetPort = Number(options.port || (options.protocol === "http:" ? 80 : 443));
    establishSocks5Tunnel(this.proxyUrl, targetHost, targetPort)
      .then((socket) => {
        socket.setNoDelay?.(true);
        if (options.protocol === "http:") {
          callback?.(null, socket);
          return;
        }
        const tlsSocket = connectTunneledTls(socket, options.servername || targetHost, targetPort);
        callback?.(null, tlsSocket);
      })
      .catch((err) => {
        callback?.(err instanceof Error ? err : new Error(String(err)), undefined as unknown as Duplex);
      });
    return undefined;
  }
}

const agentCache = new Map<string, https.Agent>();
const MAX_PROXY_AGENT_CACHE = 512;

export function getProxyAgent(proxyUrl: string | undefined): https.Agent | undefined {
  const effective = validateProxyUrl(proxyUrl);
  if (!effective) return undefined;
  let agent = agentCache.get(effective);
  if (agent) {
    // Refresh LRU recency without recreating or destroying active connections.
    agentCache.delete(effective);
    agentCache.set(effective, agent);
    return agent;
  }
  if (agentCache.size >= MAX_PROXY_AGENT_CACHE) {
    const oldestKey = agentCache.keys().next().value;
    if (oldestKey) {
      // Do NOT call .destroy() on eviction — an in-flight TLS/WS connection may still be active;
      // removing from cache lets idle sockets drain and GC naturally.
      agentCache.delete(oldestKey);
    }
  }
  const parsed = new URL(effective);
  agent =
    parsed.protocol === "socks5:" || parsed.protocol === "socks5h:"
      ? new Socks5TunnelAgent(effective)
      : new HttpConnectTunnelAgent(effective);
  agentCache.set(effective, agent);
  return agent;
}

function isTransientProxyNetworkError(err: unknown): boolean {
  const rec = err as { code?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const code = String(rec?.code || rec?.cause?.code || "").toUpperCase();
  if (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }
  const msg = `${err instanceof Error ? err.message : String(err || "")} ${String(rec?.cause?.message || "")}`.toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("econnaborted") ||
    msg.includes("epipe") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("other side closed") ||
    msg.includes("und_err_socket") ||
    msg.includes("fetch failed") ||
    msg.includes("socks5 proxy closed connection during handshake") ||
    msg.includes("socks5 proxy handshake timed out") ||
    msg.includes("socks5 connect failed") ||
    msg.includes("proxy connect handshake timed out") ||
    msg.includes("proxy http request timed out") ||
    /proxy connect failed \((?:429|5\d\d)\b/.test(msg) ||
    msg.includes("before secure tls connection was established")
  );
}

const MAX_PROXY_RESPONSE_BYTES = 16 * 1024 * 1024;

function doProxiedHttpsRequest(
  u: URL,
  agent: http.Agent | https.Agent | undefined,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer | Uint8Array; signal?: AbortSignal },
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const headers: Record<string, string> = { ...(init.headers || {}) };
    if (init.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
      const len = typeof init.body === "string" ? Buffer.byteLength(init.body, "utf8") : init.body.byteLength;
      headers["Content-Length"] = String(len);
    }
    const isHttp = u.protocol === "http:";
    const requester = isHttp ? http.request : https.request;
    const req = requester(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : isHttp ? 80 : 443,
        path: `${u.pathname}${u.search}`,
        method: init.method || "GET",
        headers,
        agent,
        signal: init.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on("error", fail);
        res.on("data", (c: Buffer) => {
          const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
          totalBytes += b.byteLength;
          if (totalBytes > MAX_PROXY_RESPONSE_BYTES) {
            res.destroy();
            req.destroy();
            fail(new Error(`Proxy HTTP response exceeded ${MAX_PROXY_RESPONSE_BYTES} byte limit`));
            return;
          }
          chunks.push(b);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const bodyText = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => bodyText,
            json: async () => JSON.parse(bodyText),
          });
        });
      },
    );
    req.setTimeout(20_000, () => {
      req.destroy(new Error("Proxy HTTP request timed out after 20s"));
    });
    req.on("error", fail);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

function matchesNoProxy(hostname: string, targetPort = "", env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.NO_PROXY || env.no_proxy || "").trim();
  if (!raw) return false;
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  for (const part of raw.split(",")) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;

    let ruleHost = entry;
    let rulePort = "";
    if (entry.startsWith("[")) {
      // Bracketed IPv6: [::1] or [::1]:8080
      const closeBracket = entry.indexOf("]");
      if (closeBracket > 1) {
        ruleHost = entry.slice(1, closeBracket);
        const rest = entry.slice(closeBracket + 1);
        const pm = /^:(\d+)$/.exec(rest);
        if (pm) rulePort = pm[1]!;
      }
    } else {
      const colonCount = (entry.match(/:/g) || []).length;
      if (colonCount === 1) {
        // host:port or IPv4:port
        const idx = entry.indexOf(":");
        const maybePort = entry.slice(idx + 1);
        if (/^\d+$/.test(maybePort)) {
          ruleHost = entry.slice(0, idx);
          rulePort = maybePort;
        }
      }
      // colonCount >= 2 -> unbracketed IPv6 literal (e.g. ::1, 2001:db8::1), keep intact
    }

    if (rulePort && targetPort && rulePort !== targetPort) continue;
    if (rulePort && !targetPort) continue;

    ruleHost = ruleHost.replace(/^\*\./, "").replace(/^\./, "");
    if (!ruleHost) continue;
    if (host === ruleHost || host.endsWith(`.${ruleHost}`)) return true;
  }
  return false;
}

/**
 * Resolves the effective proxy URL: prefers an explicit per-credential `proxyUrl`,
 * otherwise falls back to standard environment variables (`HTTPS_PROXY`, `https_proxy`,
 * `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, `all_proxy`), honoring `NO_PROXY`/`no_proxy`,
 * target scheme (`http:`/`ws:` vs `https:`/`wss:`), and bypassing env fallback for loopback
 * targets or unsupported proxy schemes (e.g. `ALL_PROXY=socks4://...`).
 */
export function resolveEffectiveProxyUrl(
  explicitProxy?: string,
  targetUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const direct = (explicitProxy || "").trim();
  if (direct) return direct;

  let protocol = "";
  if (targetUrl) {
    try {
      const parsed = new URL(targetUrl);
      protocol = parsed.protocol.toLowerCase();
      const effectivePort =
        parsed.port ||
        (protocol === "http:" || protocol === "ws:"
          ? "80"
          : protocol === "https:" || protocol === "wss:"
            ? "443"
            : "");
      if (isLoopbackHost(parsed.hostname) || matchesNoProxy(parsed.hostname, effectivePort, env)) {
        return undefined;
      }
    } catch {
      // Fall through if targetUrl is not a full URL
    }
  }

  const candidates =
    protocol === "http:" || protocol === "ws:"
      ? [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy]
      : [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];

  for (const raw of candidates) {
    const trimmed = (raw || "").trim();
    if (!trimmed) continue;
    try {
      const validated = validateProxyUrl(trimmed);
      if (validated) return validated;
    } catch {
      // Skip unsupported/malformed ambient env proxy (e.g. ALL_PROXY=socks4://...) instead of crashing all calls.
    }
  }
  return undefined;
}

// Track native fetch so test harnesses stubbing `globalThis.fetch` bypass ambient host proxies (e.g. local Clash).
const NATIVE_FETCH = globalThis.fetch;

/**
 * Perform an HTTPS fetch optionally routed through a per-credential or environment HTTP/HTTPS/SOCKS5 proxy.
 * Falls back to native global `fetch` when no proxy is configured.
 * Automatically retries up to 1 time by default on transient residential-proxy TCP/handshake resets
 * (`ECONNRESET`, `EPIPE`, `socket hang up`, SOCKS5 handshake close).
 */
export async function fetchViaOptionalProxy(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer | Uint8Array; signal?: AbortSignal },
  proxyUrl?: string,
  options?: { maxRetries?: number; retryDelayMs?: number },
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
  const directProxy = (proxyUrl || "").trim();
  const effectiveProxy =
    directProxy || (globalThis.fetch === NATIVE_FETCH ? resolveEffectiveProxyUrl(undefined, url) || "" : "");
  const maxRetries = Math.max(0, options?.maxRetries ?? 1);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 300);

  if (!effectiveProxy) {
    // In production (native fetch untouched by test harnesses), use our persistent 60s Keep-Alive +
    // TLS-session-resuming + DNS-cached agent instead of undici's 4s keepAliveTimeout default.
    if (globalThis.fetch === NATIVE_FETCH) {
      const u = new URL(url);
      const directAgent = u.protocol === "http:" ? directHttpAgent : directHttpsAgent;
      let lastDirectErr: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await doProxiedHttpsRequest(u, directAgent, init);
        } catch (err) {
          lastDirectErr = err;
          if (attempt >= maxRetries || init.signal?.aborted || !isTransientProxyNetworkError(err)) {
            throw err;
          }
          const delay = retryDelayMs * (attempt + 1);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw lastDirectErr;
    }
    const fetchInit: RequestInit = {
      ...(init.method ? { method: init.method } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined
        ? {
          body: (typeof init.body === "string"
            ? init.body
            : Buffer.isBuffer(init.body)
              ? init.body
              : Buffer.from(init.body)) as BodyInit,
        }
        : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    };
    let lastDirectErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fetch(url, fetchInit);
      } catch (err) {
        lastDirectErr = err;
        if (attempt >= maxRetries || init.signal?.aborted || !isTransientProxyNetworkError(err)) {
          throw err;
        }
        const delay = retryDelayMs * (attempt + 1);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastDirectErr;
  }
  const u = new URL(url);
  const agent = getProxyAgent(effectiveProxy);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await doProxiedHttpsRequest(u, agent, init);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || init.signal?.aborted || !isTransientProxyNetworkError(err)) {
        throw err;
      }
      const delay = retryDelayMs * (attempt + 1);
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
