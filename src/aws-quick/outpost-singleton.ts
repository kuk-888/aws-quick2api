import net from "node:net";
import { parseOAuthCredential, type OAuthCredential } from "./oauth-client.js";
import { OutpostHandle } from "./outpost-client.js";
import { parseWebCurlOrCredential, type WebCookieCredential } from "./web-client.js";

let sharedOutpost: OutpostHandle | null = null;
let startingPromise: Promise<OutpostHandle> | null = null;
let outpostLockChain: Promise<void> = Promise.resolve();

const ALLOWED_WS_HOST_RE = /^(?:[a-z0-9-]+\.)+(?:plato\.ai\.aws\.dev|quick\.aws\.com|quicksight\.aws\.amazon\.com|aws\.dev)$/i;

/**
 * Validates that an upstream AWS Quick WebSocket/API host belongs to an official AWS Quick domain.
 * Prevents SSRF / Bearer JWT exfiltration via crafted `wsHost|jwt` or JSON credentials.
 */
export function assertSafeWsHost(rawHost: string | undefined): string {
  const host = (rawHost || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || net.isIP(host) || !ALLOWED_WS_HOST_RE.test(host)) {
    throw new Error(`Blocked untrusted AWS Quick wsHost: "${rawHost || ""}"`);
  }
  return host;
}

export async function getSharedOutpost(): Promise<OutpostHandle> {
  if (sharedOutpost) return sharedOutpost;
  if (startingPromise) return startingPromise;
  const port = Number(process.env.QUICKWORK_OUTPOST_PORT || 18780);
  const agentPath = process.env.QUICKWORK_AGENT_PATH?.trim() || undefined;
  startingPromise = OutpostHandle.start({ port, agentPath })
    .then((handle) => {
      sharedOutpost = handle;
      return handle;
    })
    .finally(() => {
      startingPromise = null;
    });
  return startingPromise;
}

/**
 * Serializes access to the shared `OutpostHandle` singleton so concurrent token-mode requests
 * never race on `setImportedToken(...)` and mix credentials across accounts.
 */
export async function withSharedOutpostLock<T>(fn: (outpost: OutpostHandle) => Promise<T>): Promise<T> {
  const prev = outpostLockChain;
  let release!: () => void;
  outpostLockChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    const outpost = await getSharedOutpost();
    return await fn(outpost);
  } finally {
    release();
  }
}

export function stopSharedOutpost(): void {
  if (sharedOutpost) {
    sharedOutpost.stop();
    sharedOutpost = null;
  }
}

export function isLocalOutpostKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return k === "local-outpost" || k === "local" || k === "auto";
}

/**
 * Parses an imported AWS Quick credential string.
 * Supports:
 * 1. `local-outpost` (macOS Amazon Quick.app automatic local session)
 * 2. `web:<accountId>|<mbtc>|<cookie>` or pasted browser `Copy as cURL` from quick.aws.com (cross-platform)
 * 3. Raw `id_token` (`aoa...`), `wsHost|id_token`, or JSON `{"jwt":"...","wsHost":"..."}`
 */
export function parseQuickCredential(rawKey: string): {
  mode: "outpost" | "token" | "web" | "oauth";
  jwt?: string;
  wsHost?: string;
  outpostId?: string;
  web?: WebCookieCredential;
  oauth?: OAuthCredential;
} {
  const trimmed = rawKey.trim();
  if (isLocalOutpostKey(trimmed)) {
    return { mode: "outpost" };
  }
  const oauthCred = parseOAuthCredential(trimmed);
  if (oauthCred) {
    return { mode: "oauth", oauth: oauthCred };
  }
  const webCred = parseWebCurlOrCredential(trimmed);
  if (webCred) {
    return { mode: "web", web: webCred };
  }
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as { jwt?: string; id_token?: string; wsHost?: string; ws_host?: string; outpostId?: string };
      return {
        mode: "token",
        jwt: obj.jwt || obj.id_token || "",
        wsHost: obj.wsHost || obj.ws_host,
        outpostId: obj.outpostId,
      };
    } catch {
      // fall through
    }
  }
  if (trimmed.includes("|")) {
    const [wsHost, jwt, outpostId] = trimmed.split("|");
    return { mode: "token", wsHost: wsHost.trim(), jwt: (jwt || "").trim(), outpostId: outpostId?.trim() };
  }
  return { mode: "token", jwt: trimmed };
}
