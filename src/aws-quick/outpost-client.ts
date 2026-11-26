import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { QUICK_APP_VERSION, QUICK_DESKTOP_USER_AGENT } from './oauth-client.js';
import { assertSafeWsHost } from './outpost-singleton.js';
import type { CloudSessionMeta, QuickQuotaUsage } from './types.js';

const OUTPOST_SURFACE_TYPE =
  process.platform === 'win32' ? 'QUICK_WORK_DESKTOP_WINDOWS' : 'QUICK_WORK_DESKTOP_MAC';

export interface SncsSession {
  jwt: string;
  actorArn?: string;
  wsHost: string;
  tenantUrl: string;
  wsPath?: string;
  accountId?: string;
  region?: string;
  provider?: string;
  usableUntil?: number;
}

const DEFAULT_AGENT_PATH = '/Applications/Amazon Quick.app/Contents/Resources/agent/quickwork-agent';
const DEFAULT_RESOURCES_PATH = '/Applications/Amazon Quick.app/Contents/Resources';
const SESSION_SKEW_MS = 30_000;

/**
 * Manages a headless `quickwork-agent --outpost-only` child process,
 * caches the active SNCS JWT session, and queries live account quota (`profile/usage`).
 */
export class OutpostHandle {
  private child: ChildProcessWithoutNullStreams;
  private readonly port: number;
  readonly instanceToken: string;

  private cachedSession: SncsSession | null = null;
  private cachedOutpostId: string | null = null;
  private inFlightSession: Promise<SncsSession> | null = null;
  private importedToken: { jwt: string; wsHost: string; outpostId?: string; expiresAt?: number } | null = null;

  setImportedToken(input: { jwt: string; wsHost?: string; outpostId?: string; expiresAt?: number } | null): void {
    if (!input || !input.jwt.trim()) {
      this.importedToken = null;
      return;
    }
    this.importedToken = {
      jwt: input.jwt.trim(),
      wsHost: (input.wsHost || this.cachedSession?.wsHost || '').trim(),
      outpostId: input.outpostId?.trim(),
      expiresAt: input.expiresAt,
    };
  }

  getAuthSource(): 'imported' | 'outpost' {
    return this.importedToken ? 'imported' : 'outpost';
  }

  private constructor(child: ChildProcessWithoutNullStreams, port: number, instanceToken: string) {
    this.child = child;
    this.port = port;
    this.instanceToken = instanceToken;
  }

  static async start(opts?: { agentPath?: string; port?: number; timeoutMs?: number }): Promise<OutpostHandle> {
    const agentPath = opts?.agentPath || DEFAULT_AGENT_PATH;
    const port = opts?.port ?? 18780;
    const timeoutMs = opts?.timeoutMs ?? 20_000;

    if (!fs.existsSync(agentPath)) {
      throw new Error(`quickwork-agent not found at ${agentPath}. Install Amazon Quick.app first.`);
    }

    const instanceToken = crypto.randomBytes(32).toString('hex');
    const resourcesPath = path.resolve(path.dirname(agentPath), '..');

    const child = spawn(agentPath, ['--outpost-only', '--manifest', 'desktop', '--port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME || '',
        PATH: `${process.env.PATH || ''}:/usr/bin:/bin`,
        USER: process.env.USER || '',
        TMPDIR: process.env.TMPDIR || '/tmp',
        LANG: process.env.LANG || 'en_US.UTF-8',
        PYTHONUTF8: '1',
        QUICKWORK_BUILD_STAGE: 'prod',
        QUICKWORK_CLOUD_MODE: '1',
        QUICKWORK_OUTPOST_PORT: String(port),
        QUICKWORK_RESOURCES_PATH: fs.existsSync(resourcesPath) ? resourcesPath : DEFAULT_RESOURCES_PATH,
        ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
        ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
      },
    });

    child.stdin.write(`${instanceToken}\n`);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (buf.includes('OUTPOST_PORT:')) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.stdout.off('data', onData);
          child.off('exit', onExit);
          resolve();
        }
      };
      const onExit = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        reject(new Error(`quickwork-agent exited early with code ${code}`));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        reject(new Error('Timed out waiting for OUTPOST_PORT'));
      }, timeoutMs);
      child.stdout.on('data', onData);
      child.once('exit', onExit);
    });

    return new OutpostHandle(child, port, instanceToken);
  }

  async getSncsSession(forceRefresh = false): Promise<SncsSession> {
    if (this.importedToken) {
      return {
        jwt: this.importedToken.jwt,
        wsHost: this.importedToken.wsHost,
        tenantUrl: this.importedToken.wsHost ? `https://${this.importedToken.wsHost}` : '',
        provider: 'imported-token',
        usableUntil: this.importedToken.expiresAt ? Math.floor(this.importedToken.expiresAt / 1000) : undefined,
      };
    }
    if (!forceRefresh && this.cachedSession) {
      const expMs = this.cachedSession.usableUntil ? this.cachedSession.usableUntil * 1000 : Date.now() + 60_000;
      if (Date.now() + SESSION_SKEW_MS < expMs) {
        return this.cachedSession;
      }
    }
    if (this.inFlightSession) return this.inFlightSession;

    this.inFlightSession = (async () => {
      const resp = await fetch(`http://127.0.0.1:${this.port}/auth/sncs-session`, {
        headers: { Authorization: `Bearer ${this.instanceToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Outpost /auth/sncs-session failed (${resp.status}): ${text}`);
      }
      const body = (await resp.json()) as Record<string, unknown>;
      const session: SncsSession = {
        jwt: String(body.id_token || ''),
        actorArn: body.actor_arn ? String(body.actor_arn) : undefined,
        wsHost: String(body.ws_host || ''),
        tenantUrl: String(body.tenant_url || (body.ws_host ? `https://${body.ws_host}` : '')),
        wsPath: body.ws_path ? String(body.ws_path) : undefined,
        accountId: body.aws_account_id ? String(body.aws_account_id) : undefined,
        region: body.region ? String(body.region) : undefined,
        provider: body.provider ? String(body.provider) : undefined,
        usableUntil: typeof body.usable_until === 'number' ? body.usable_until : undefined,
      };
      this.cachedSession = session;
      return session;
    })().finally(() => {
      this.inFlightSession = null;
    });

    return this.inFlightSession;
  }

  async getOutpostId(): Promise<string> {
    if (this.importedToken?.outpostId) return this.importedToken.outpostId;
    if (this.cachedOutpostId) return this.cachedOutpostId;
    const resp = await fetch(`http://127.0.0.1:${this.port}/local/outpost-id`, {
      headers: { Authorization: `Bearer ${this.instanceToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      throw new Error(`Outpost /local/outpost-id failed (${resp.status})`);
    }
    const body = (await resp.json()) as { outpostId?: string };
    if (!body.outpostId) {
      throw new Error('Missing outpostId from /local/outpost-id');
    }
    this.cachedOutpostId = body.outpostId;
    return body.outpostId;
  }

  async getProfileUsage(): Promise<QuickQuotaUsage> {
    const [session, outpostId] = await Promise.all([this.getSncsSession(), this.getOutpostId()]);
    const safeHost = assertSafeWsHost(session.wsHost);
    const resp = await fetch(`https://${safeHost}/integration/quick-work/qbs-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.jwt}`,
        'User-Agent': QUICK_DESKTOP_USER_AGENT,
        'x-amzn-qs-internal-trace-id': crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        eventType: 'invokeAgent',
        eventBody: {
          invokeAgent: {
            path: 'profile/usage',
            queryParams: {
              surfaceType: OUTPOST_SURFACE_TYPE,
              appVersion: QUICK_APP_VERSION,
              _method: 'GET',
            },
            body: {},
            outpostId,
          },
        },
      }),
    });
    if (!resp.ok) {
      throw new Error(`profile/usage failed with HTTP ${resp.status}`);
    }
    const envelope = (await resp.json()) as {
      eventResponse?: { invokeAgentResponse?: { body?: string } | string };
    };
    const rawInv = envelope?.eventResponse?.invokeAgentResponse;
    const apiResp = typeof rawInv === 'string' ? (JSON.parse(rawInv) as { body?: string }) : rawInv;
    const usageJson = typeof apiResp?.body === 'string' ? (JSON.parse(apiResp.body) as QuickQuotaUsage) : {};
    return usageJson;
  }

  async listCloudSessions(limit = 50): Promise<CloudSessionMeta[]> {
    const [session, outpostId] = await Promise.all([this.getSncsSession(), this.getOutpostId()]);
    const safeHost = assertSafeWsHost(session.wsHost);
    const resp = await fetch(`https://${safeHost}/integration/quick-work/qbs-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.jwt}`,
        'User-Agent': QUICK_DESKTOP_USER_AGENT,
        'x-amzn-qs-internal-trace-id': crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        eventType: 'invokeAgent',
        eventBody: {
          invokeAgent: {
            path: 'api/ws-rpc',
            queryParams: {
              surfaceType: OUTPOST_SURFACE_TYPE,
              appVersion: QUICK_APP_VERSION,
              _method: 'POST',
            },
            body: {
              type: 'session_list',
              payload: {
                limit,
                profileGeneration: 0,
                includePromotedSessions: true,
                pageRequestId: Date.now(),
              },
            },
            outpostId,
          },
        },
      }),
    });
    if (!resp.ok) {
      throw new Error(`session_list failed with HTTP ${resp.status}`);
    }
    const envelope = (await resp.json()) as {
      eventResponse?: { invokeAgentResponse?: { body?: string } | string };
    };
    const rawInv = envelope?.eventResponse?.invokeAgentResponse;
    const apiResp = typeof rawInv === 'string' ? (JSON.parse(rawInv) as { body?: string }) : rawInv;
    const body = typeof apiResp?.body === 'string' ? (JSON.parse(apiResp.body) as { frames?: Array<{ type?: string; payload?: { sessions?: CloudSessionMeta[] } }> }) : {};
    const frame = (body.frames || []).find((f) => f.type === 'session_list');
    return (frame?.payload?.sessions || []).map((s) => ({
      id: String(s.id),
      title: String(s.title || '(Untitled)'),
      created_at: Number(s.created_at || 0),
      updated_at: Number(s.updated_at || 0),
      message_count: Number(s.message_count || 0),
    }));
  }

  stop(): void {
    if (!this.child.killed) {
      this.child.kill('SIGTERM');
    }
  }
}
