import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);

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
    super({ keepAlive: false });
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

    req.setTimeout(15_000, () => {
      req.destroy(new Error("Proxy CONNECT handshake timed out after 15s"));
    });

    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`Proxy CONNECT failed (${res.statusCode} ${res.statusMessage || ""})`), socket);
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || targetHost,
      });
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
  timeoutMs = 15_000,
): Promise<net.Socket> {
  const proxyHost = proxyUrl.hostname;
  const proxyPort = Number(proxyUrl.port || 1080);
  const username = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : "";
  const password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : "";
  const hasAuth = Boolean(username || password);

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
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
    super({ keepAlive: false });
    this.proxyUrl = new URL(proxyUrl);
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const targetHost = String(options.host || options.hostname || "");
    const targetPort = Number(options.port || 443);
    establishSocks5Tunnel(this.proxyUrl, targetHost, targetPort)
      .then((socket) => {
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername || targetHost,
        });
        callback?.(null, tlsSocket);
      })
      .catch((err) => {
        callback?.(err instanceof Error ? err : new Error(String(err)), undefined as unknown as Duplex);
      });
    return undefined;
  }
}

const agentCache = new Map<string, https.Agent>();
const MAX_PROXY_AGENT_CACHE = 64;

export function getProxyAgent(proxyUrl: string | undefined): https.Agent | undefined {
  const effective = validateProxyUrl(proxyUrl);
  if (!effective) return undefined;
  let agent = agentCache.get(effective);
  if (!agent) {
    if (agentCache.size >= MAX_PROXY_AGENT_CACHE) {
      const oldestKey = agentCache.keys().next().value;
      if (oldestKey) {
        agentCache.get(oldestKey)?.destroy();
        agentCache.delete(oldestKey);
      }
    }
    const parsed = new URL(effective);
    agent =
      parsed.protocol === "socks5:" || parsed.protocol === "socks5h:"
        ? new Socks5TunnelAgent(effective)
        : new HttpConnectTunnelAgent(effective);
    agentCache.set(effective, agent);
  }
  return agent;
}

function isTransientProxyNetworkError(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code || "").toUpperCase();
  if (code === "ECONNRESET" || code === "ECONNABORTED" || code === "EPIPE" || code === "ETIMEDOUT") {
    return true;
  }
  const msg = (err instanceof Error ? err.message : String(err || "")).toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("econnaborted") ||
    msg.includes("epipe") ||
    msg.includes("socket hang up") ||
    msg.includes("socks5 proxy closed connection during handshake") ||
    msg.includes("before secure tls connection was established")
  );
}

const MAX_PROXY_RESPONSE_BYTES = 16 * 1024 * 1024;

function doProxiedHttpsRequest(
  u: URL,
  agent: https.Agent | undefined,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : 443,
        path: `${u.pathname}${u.search}`,
        method: init.method || "GET",
        headers: init.headers,
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
    req.setTimeout(30_000, () => {
      req.destroy(new Error("Proxy HTTP request timed out after 30s"));
    });
    req.on("error", fail);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * Perform an HTTPS fetch optionally routed through a per-credential HTTP/HTTPS/SOCKS5 proxy.
 * Falls back to native global `fetch` when no per-credential proxy is configured.
 * Automatically retries up to 2 times on transient residential-proxy TCP/handshake resets
 * (`ECONNRESET`, `EPIPE`, `socket hang up`, SOCKS5 handshake close).
 */
export async function fetchViaOptionalProxy(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  proxyUrl?: string,
  options?: { maxRetries?: number; retryDelayMs?: number },
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
  const effectiveProxy = (proxyUrl || "").trim();
  if (!effectiveProxy) {
    return fetch(url, init);
  }
  const u = new URL(url);
  const agent = getProxyAgent(effectiveProxy);
  const maxRetries = Math.max(0, options?.maxRetries ?? 2);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 300);

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
