import crypto from "node:crypto";
import WebSocket from "ws";
import { appendWsRecvBuf } from "../core/media-utils.js";
import { GatewayError } from "../core/types.js";
import { getProxyAgent } from "../utils/proxy-agent.js";
import {
  ChunkedFrameAssembler,
  decodeCloudOutputFrame,
  decodeGatewayFrame,
  drainEventStream,
  encodeCloudInputFrame,
  encodeGatewayJsonFrame,
  type DecodedGatewayFrame,
  type EventStreamMessage,
} from "./event-stream-cbor.js";
import {
  deriveStableOutpostId,
  QUICK_APP_VERSION,
  QUICK_DESKTOP_USER_AGENT,
  resolveOAuthAccessToken,
} from "./oauth-client.js";
import { assertSafeWsHost, parseQuickCredential, withSharedOutpostLock } from "./outpost-singleton.js";
import { buildWebWsConnection } from "./web-client.js";

export const SURFACE_TYPE =
  process.platform === "win32" ? "QUICK_WORK_DESKTOP_WINDOWS" : "QUICK_WORK_DESKTOP_MAC";
export const APP_VERSION = QUICK_APP_VERSION;
export const DESKTOP_CAPABILITIES = {
  acp_first_text: 1,
  user_notification: 1,
  subtask_progress: 1,
  external_agent_sign_in: 1,
  recents_promotion: 1,
  self_registering_connectors: 1,
} as const;

export interface QuickChatAgentInfo {
  agentId: string;
  shortId: string;
  name: string;
  description: string;
  systemPrompt: string;
  isSystem: boolean;
}

export const DEFAULT_CODING_AGENT_NAME = "Coding Assistant";
export const LEGACY_CODING_AGENT_NAMES = ["Coding Assistant", "Quick2API Bridge", "Quick2API Coding Bridge"];
export const DEFAULT_CODING_AGENT_DESCRIPTION = "General software engineering and coding assistant.";
export const DEFAULT_CODING_AGENT_INSTRUCTIONS =
  "You are a concise, accurate software engineering assistant. Follow the user's instructions and requested output format directly. When structured <tool_call> schemas are provided in context, emit matching <tool_call> blocks directly when appropriate.";

/**
 * Normalizes an AWS Quick agent identifier (full ARN `arn:aws:quicksight:...:agent/<id>` or short ID)
 * to its canonical short ID so slot bindings, UI highlights, and warm-session cache keys stay consistent.
 */
export function normalizeChatAgentShortId(raw: string): string {
  const trimmed = raw.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

export type QuickWebSocketFactory = (url: string, options?: Record<string, unknown>) => WebSocket;
export type QuickFrameEncoder = (frame: Record<string, unknown>) => Uint8Array | string;
export type QuickFrameDecoder = (msg: EventStreamMessage) => DecodedGatewayFrame | null;

export interface DialedQuickWs {
  ws: WebSocket;
  isWeb: boolean;
  encodeFrame: QuickFrameEncoder;
  decodeFrame: QuickFrameDecoder;
  surfaceType: string;
  appVersion: string;
  surfaceName: "web" | "desktop";
  outpostId: string;
  actorArn?: string;
}

/**
 * Unified WebSocket dialer across all AWS Quick auth channels (Web Cookie, OAuth AIDP, Local Outpost / Token).
 * Ensures consistent headers (`User-Agent`, `x-amzn-qs-internal-trace-id`, `X-*`), `replayContext`,
 * SSRF host validation, proxy agent wiring, and optional headroom hook right before socket creation.
 */
export async function dialQuickWebSocket(params: {
  apiKey: string;
  workingSessionId: string;
  proxyUrl?: string;
  webSocketFactory?: QuickWebSocketFactory;
  beforeDial?: () => Promise<void>;
}): Promise<DialedQuickWs> {
  const { apiKey, workingSessionId, proxyUrl, webSocketFactory, beforeDial } = params;
  const cred = parseQuickCredential(apiKey);
  const isWeb = cred.mode === "web" && Boolean(cred.web);
  const encodeFrame: QuickFrameEncoder = isWeb ? encodeGatewayJsonFrame : encodeCloudInputFrame;
  const decodeFrame: QuickFrameDecoder = isWeb ? decodeGatewayFrame : decodeCloudOutputFrame;
  const surfaceType = isWeb ? "WEB_EXPERIENCE" : SURFACE_TYPE;
  const appVersion = isWeb ? "qbiz-web-bridge" : APP_VERSION;
  const surfaceName: "web" | "desktop" = isWeb ? "web" : "desktop";
  const effectiveProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const wsAgent = getProxyAgent(effectiveProxy);

  if (isWeb && cred.web) {
    const conn = buildWebWsConnection(cred.web, workingSessionId);
    if (beforeDial) await beforeDial();
    const ws = new WebSocket(conn.url, conn.protocols, {
      headers: conn.headers,
      handshakeTimeout: 15_000,
      ...(wsAgent ? { agent: wsAgent } : {}),
    });
    return {
      ws,
      isWeb: true,
      encodeFrame,
      decodeFrame,
      surfaceType,
      appVersion,
      surfaceName,
      outpostId: "web0",
    };
  }

  if (cred.mode === "oauth" && cred.oauth) {
    const { accessToken } = await resolveOAuthAccessToken(cred.oauth, false, proxyUrl);
    const outpostId = deriveStableOutpostId(cred.oauth.clientId);
    const replayContext = `v1;setup;${crypto.randomBytes(32).toString("base64url")}`;
    const wsUrl =
      `wss://${cred.oauth.wsHost}/streaming/quickwork-chat-bidirectional-stream` +
      `?surfaceType=${encodeURIComponent(SURFACE_TYPE)}` +
      `&token=${encodeURIComponent(accessToken)}` +
      `&outpostId=${encodeURIComponent(outpostId)}` +
      `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
      `&replayContext=${encodeURIComponent(replayContext)}` +
      `&channel=prod`;
    if (beforeDial) await beforeDial();
    const oauthWsOpts: Record<string, unknown> = {
      handshakeTimeout: 15_000,
      headers: {
        "User-Agent": QUICK_DESKTOP_USER_AGENT,
        Authorization: `Bearer ${accessToken}`,
        "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
        "X-Surface-Type": SURFACE_TYPE,
        "X-Outpost-Id": outpostId,
        "X-Agent-Service-Type": "UNIFIED_QUICK",
        "X-Working-Session-Id": workingSessionId,
      },
      ...(wsAgent ? { agent: wsAgent } : {}),
    };
    const ws = webSocketFactory ? webSocketFactory(wsUrl, oauthWsOpts) : new WebSocket(wsUrl, oauthWsOpts);
    return {
      ws,
      isWeb: false,
      encodeFrame,
      decodeFrame,
      surfaceType,
      appVersion,
      surfaceName,
      outpostId,
    };
  }

  const [session, oid] = await withSharedOutpostLock(async (outpost) => {
    if (cred.mode === "token" && cred.jwt) {
      outpost.setImportedToken({ jwt: cred.jwt, wsHost: cred.wsHost, outpostId: cred.outpostId });
    } else {
      outpost.setImportedToken(null);
    }
    return Promise.all([outpost.getSncsSession(), outpost.getOutpostId()]);
  });
  if (!session.jwt || !session.wsHost) {
    throw new GatewayError(
      "AWS Quick session unavailable. Please sign in to Amazon Quick.app or import a valid credential.",
      502,
      "upstream_auth_error",
    );
  }
  const safeWsHost = assertSafeWsHost(session.wsHost);
  const replayContext = `v1;setup;${crypto.randomBytes(32).toString("base64url")}`;
  const wsPath = session.wsPath || "/streaming/quickwork-chat-bidirectional-stream";
  const wsUrl =
    `wss://${safeWsHost}${wsPath}` +
    `?surfaceType=${encodeURIComponent(SURFACE_TYPE)}` +
    `&token=${encodeURIComponent(session.jwt)}` +
    `&outpostId=${encodeURIComponent(oid)}` +
    `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
    `&replayContext=${encodeURIComponent(replayContext)}` +
    `&channel=prod`;
  if (beforeDial) await beforeDial();
  const ws = new WebSocket(wsUrl, {
    handshakeTimeout: 15_000,
    headers: {
      "User-Agent": QUICK_DESKTOP_USER_AGENT,
      Authorization: `Bearer ${session.jwt}`,
      "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
      "X-Surface-Type": SURFACE_TYPE,
      "X-Outpost-Id": oid,
      "X-Agent-Service-Type": "UNIFIED_QUICK",
      "X-Working-Session-Id": workingSessionId,
    },
    ...(wsAgent ? { agent: wsAgent } : {}),
  });
  return {
    ws,
    isWeb: false,
    encodeFrame,
    decodeFrame,
    surfaceType,
    appVersion,
    surfaceName,
    outpostId: oid,
    actorArn: session.actorArn,
  };
}

/**
 * Shared EventStream + `_chunked_frame` decoder helper for control-plane WS RPCs.
 */
function attachControlMessageListener(
  ws: WebSocket,
  decodeFrame: QuickFrameDecoder,
  onEvent: (evType: string, payload: Record<string, unknown>, rawEv: Record<string, unknown>) => void,
  onError: (err: Error) => void,
): () => void {
  let recvBuf = Buffer.alloc(0);
  const chunked = new ChunkedFrameAssembler();
  const handler = (data: Buffer) => {
    let messages: EventStreamMessage[];
    try {
      recvBuf = appendWsRecvBuf(recvBuf, data);
      const drained = drainEventStream(recvBuf, 0);
      if (drained.consumed > 0) recvBuf = recvBuf.subarray(drained.consumed);
      messages = drained.messages;
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const esMsg of messages) {
      let decoded: DecodedGatewayFrame | null;
      try {
        decoded = decodeFrame(esMsg);
      } catch {
        continue;
      }
      if (!decoded) continue;
      if (decoded.type === "error") {
        onError(new GatewayError(`[${decoded.code}] ${decoded.message}`, 502, "upstream_error"));
        return;
      }
      const ev = chunked.push(decoded.data);
      if (!ev) continue;
      const evType = String(ev.type || "");
      const payload = (ev.payload && typeof ev.payload === "object" ? ev.payload : {}) as Record<string, unknown>;
      onEvent(evType, payload, ev);
    }
  };
  ws.on("message", handler);
  return () => {
    ws.off("message", handler);
    chunked.clear();
  };
}

export async function deleteCloudSessionsForKey(
  apiKey: string,
  sessionIds: string[],
  proxyUrl?: string,
  webSocketFactory?: QuickWebSocketFactory,
): Promise<string[]> {
  const targets = Array.from(new Set(sessionIds.map((s) => s.trim()).filter(Boolean)));
  if (targets.length === 0) return [];

  const conn = await dialQuickWebSocket({
    apiKey,
    workingSessionId: crypto.randomUUID(),
    proxyUrl,
    webSocketFactory,
  });
  const { ws, encodeFrame, decodeFrame, actorArn, surfaceType, outpostId, appVersion } = conn;
  const deleted: string[] = [];

  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    let sendTimer: ReturnType<typeof setTimeout> | null = null;
    let sentDeletes = false;

    const cleanup = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sendTimer) {
        clearTimeout(sendTimer);
        sendTimer = null;
      }
      detachMsg();
      ws.on("error", () => {});
      try {
        ws.close();
      } catch { }
      fn();
    };
    const triggerDeleteBatch = () => {
      if (sentDeletes || settled || ws.readyState !== WebSocket.OPEN) return;
      sentDeletes = true;
      if (sendTimer) {
        clearTimeout(sendTimer);
        sendTimer = null;
      }
      for (const id of targets) {
        ws.send(encodeFrame({ type: "session_delete", payload: { session_id: id } }));
      }
    };
    const timer = setTimeout(() => cleanup(() => resolve(deleted)), 8_000);
    timer.unref?.();

    const detachMsg = attachControlMessageListener(
      ws,
      decodeFrame,
      (evType, payload) => {
        if (evType === "session_established" || evType === "connected") {
          triggerDeleteBatch();
        } else if (evType === "session_deleted") {
          const p = payload as { session_id?: string; success?: boolean };
          if (p.success && p.session_id) deleted.push(String(p.session_id));
          if (deleted.length >= targets.length) cleanup(() => resolve(deleted));
        }
      },
      () => cleanup(() => resolve(deleted)),
    );

    ws.once("close", () => cleanup(() => resolve(deleted)));
    ws.once("open", () => {
      ws.send(
        encodeFrame({
          type: "session_connect",
          payload: {
            ...(actorArn ? { actor_id: actorArn } : {}),
            surfaceType,
            outpostId,
            appVersion,
          },
        }),
      );
      sendTimer = setTimeout(() => triggerDeleteBatch(), 250);
      sendTimer.unref?.();
    });
    ws.once("error", (err) => cleanup(() => reject(err)));
  });
}

/**
 * Lists all AWS Quick chat agents (default SYSTEM + user custom agents) on the given account
 * using the native `get_chat_agents` -> `chat_agents_updated` WebSocket protocol.
 */
export async function listChatAgentsForKey(
  apiKey: string,
  proxyUrl?: string,
  webSocketFactory?: QuickWebSocketFactory,
): Promise<QuickChatAgentInfo[]> {
  const { ws, encodeFrame, decodeFrame } = await dialQuickWebSocket({
    apiKey,
    workingSessionId: crypto.randomUUID(),
    proxyUrl,
    webSocketFactory,
  });

  return new Promise<QuickChatAgentInfo[]>((resolve, reject) => {
    let settled = false;
    let sent = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachMsg();
      ws.on("error", () => {});
      try {
        ws.close();
      } catch { }
      fn();
    };
    const timer = setTimeout(() => {
      done(() => reject(new GatewayError("Timed out listing AWS Quick custom agents.", 504, "timeout_error")));
    }, 10_000);
    timer.unref?.();

    const detachMsg = attachControlMessageListener(
      ws,
      decodeFrame,
      (evType, payload) => {
        if ((evType === "session_established" || evType === "connected") && !sent) {
          sent = true;
          try {
            ws.send(encodeFrame({ type: "get_chat_agents", payload: {} }));
          } catch { }
        } else if (evType === "chat_agents_updated") {
          const rawAgents = Array.isArray(payload.agents) ? payload.agents : [];
          const agents: QuickChatAgentInfo[] = [];
          for (const item of rawAgents) {
            if (!item || typeof item !== "object") continue;
            const rec = item as Record<string, unknown>;
            const rawId = typeof rec.agentId === "string" ? rec.agentId.trim() : "";
            if (!rawId) continue;
            const shortId = rawId.includes("/") ? rawId.slice(rawId.lastIndexOf("/") + 1) : rawId;
            const isSystem =
              shortId.toUpperCase() === "SYSTEM" ||
              rawId.endsWith("/SYSTEM") ||
              rec.isSystemDefault === true;
            agents.push({
              agentId: rawId,
              shortId,
              name: typeof rec.name === "string" ? rec.name : shortId,
              description: typeof rec.description === "string" ? rec.description : "",
              systemPrompt: typeof rec.systemPrompt === "string" ? rec.systemPrompt : "",
              isSystem,
            });
          }
          done(() => resolve(agents));
        }
      },
      (err) => done(() => reject(err)),
    );

    ws.once("error", (err) => done(() => reject(err)));
    ws.once("close", () => done(() => resolve([])));
  });
}

/**
 * Creates and publishes a minimal coding custom agent on the given AWS Quick account via native WS frames:
 * `create_agent_draft` -> `update_chat_agent_config` -> `publish_agent_draft`.
 */
export async function createAndPublishCodingAgentForKey(
  apiKey: string,
  opts?: { name?: string; description?: string; instructions?: string },
  proxyUrl?: string,
  webSocketFactory?: QuickWebSocketFactory,
): Promise<{ agentId: string; name: string }> {
  const name = opts?.name?.trim() || DEFAULT_CODING_AGENT_NAME;
  const description = opts?.description?.trim() || DEFAULT_CODING_AGENT_DESCRIPTION;
  const instructions = opts?.instructions?.trim() || DEFAULT_CODING_AGENT_INSTRUCTIONS;
  const { ws, encodeFrame, decodeFrame } = await dialQuickWebSocket({
    apiKey,
    workingSessionId: crypto.randomUUID(),
    proxyUrl,
    webSocketFactory,
  });

  return new Promise<{ agentId: string; name: string }>((resolve, reject) => {
    let settled = false;
    let stage: "init" | "creating" | "updating" | "publishing" = "init";
    let draftAgentId = "";
    let publishFallbackTimer: NodeJS.Timeout | null = null;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (publishFallbackTimer) clearTimeout(publishFallbackTimer);
      detachMsg();
      ws.on("error", () => {});
      try {
        ws.close();
      } catch { }
      fn();
    };
    const timer = setTimeout(() => {
      done(() => reject(new GatewayError("Timed out creating AWS Quick custom agent.", 504, "timeout_error")));
    }, 15_000);
    timer.unref?.();

    const triggerPublish = () => {
      if (stage !== "updating" || !draftAgentId || settled) return;
      stage = "publishing";
      if (publishFallbackTimer) {
        clearTimeout(publishFallbackTimer);
        publishFallbackTimer = null;
      }
      try {
        ws.send(encodeFrame({ type: "publish_agent_draft", payload: { agent_id: draftAgentId } }));
      } catch (err) {
        done(() => reject(err));
      }
    };

    const detachMsg = attachControlMessageListener(
      ws,
      decodeFrame,
      (evType, payload) => {
        if ((evType === "session_established" || evType === "connected") && stage === "init") {
          stage = "creating";
          try {
            ws.send(encodeFrame({ type: "create_agent_draft", payload: { new_agent: true } }));
          } catch { }
        } else if (evType === "agent_draft_created" && stage === "creating") {
          const id = typeof payload.agent_id === "string" ? payload.agent_id.trim() : "";
          if (!id) {
            done(() => reject(new GatewayError("AWS Quick returned empty draft agent_id.", 502, "upstream_error")));
            return;
          }
          draftAgentId = id;
          stage = "updating";
          try {
            ws.send(
              encodeFrame({
                type: "update_chat_agent_config",
                payload: {
                  agent_id: draftAgentId,
                  target: "draft",
                  name,
                  description,
                  instructions,
                  skill_ids: [],
                  capabilities: [],
                },
              }),
            );
          } catch (err) {
            done(() => reject(err));
            return;
          }
          publishFallbackTimer = setTimeout(() => triggerPublish(), 1_500);
          publishFallbackTimer.unref?.();
        } else if (evType === "agent_draft_saved" && stage === "updating") {
          triggerPublish();
        } else if (evType === "publish_agent_draft_success") {
          const rawFinalId = (typeof payload.agent_id === "string" && payload.agent_id.trim()) || draftAgentId;
          done(() => resolve({ agentId: normalizeChatAgentShortId(rawFinalId), name }));
        } else if (
          evType === "publish_agent_draft_error" ||
          evType === "update_chat_agent_config_error" ||
          evType === "error"
        ) {
          const errMsg = typeof payload.error === "string" ? payload.error : evType;
          done(() => reject(new GatewayError(`Failed to create custom agent: ${errMsg}`, 502, "upstream_error")));
        }
      },
      (err) => done(() => reject(err)),
    );

    ws.once("error", (err) => done(() => reject(err)));
    ws.once("close", () => {
      if (!settled) {
        done(() =>
          reject(new GatewayError("WebSocket closed before custom agent finished publishing.", 502, "upstream_error")),
        );
      }
    });
  });
}

/**
 * Updates an existing custom agent's instructions (and optional name/description) via native WS frames:
 * `create_agent_draft(agent_id)` -> `update_chat_agent_config` -> `publish_agent_draft`.
 */
export async function updateAndPublishAgentForKey(
  apiKey: string,
  agentId: string,
  opts: { instructions: string; name?: string; description?: string },
  proxyUrl?: string,
  webSocketFactory?: QuickWebSocketFactory,
): Promise<{ agentId: string }> {
  const cleanId = normalizeChatAgentShortId(agentId);
  if (!cleanId) throw new GatewayError("`agentId` is required.", 400, "invalid_request_error");
  const instructions = opts.instructions.trim();
  const { ws, encodeFrame, decodeFrame } = await dialQuickWebSocket({
    apiKey,
    workingSessionId: crypto.randomUUID(),
    proxyUrl,
    webSocketFactory,
  });

  return new Promise<{ agentId: string }>((resolve, reject) => {
    let settled = false;
    let stage: "init" | "drafting" | "updating" | "publishing" = "init";
    let publishFallbackTimer: NodeJS.Timeout | null = null;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (publishFallbackTimer) clearTimeout(publishFallbackTimer);
      detachMsg();
      ws.on("error", () => {});
      try {
        ws.close();
      } catch { }
      fn();
    };
    const timer = setTimeout(() => {
      done(() => reject(new GatewayError("Timed out updating AWS Quick custom agent.", 504, "timeout_error")));
    }, 15_000);
    timer.unref?.();

    const triggerPublish = () => {
      if (stage !== "updating" || settled) return;
      stage = "publishing";
      if (publishFallbackTimer) {
        clearTimeout(publishFallbackTimer);
        publishFallbackTimer = null;
      }
      try {
        ws.send(encodeFrame({ type: "publish_agent_draft", payload: { agent_id: cleanId } }));
      } catch (err) {
        done(() => reject(err));
      }
    };

    const detachMsg = attachControlMessageListener(
      ws,
      decodeFrame,
      (evType, payload) => {
        if ((evType === "session_established" || evType === "connected") && stage === "init") {
          stage = "drafting";
          try {
            ws.send(encodeFrame({ type: "create_agent_draft", payload: { agent_id: cleanId, ccp_files_supported: true } }));
          } catch { }
        } else if (evType === "agent_draft_created" && stage === "drafting") {
          stage = "updating";
          try {
            ws.send(
              encodeFrame({
                type: "update_chat_agent_config",
                payload: {
                  agent_id: cleanId,
                  target: "draft",
                  instructions,
                  skill_ids: [],
                  capabilities: [],
                  ...(opts.name?.trim() ? { name: opts.name.trim() } : {}),
                  ...(typeof opts.description === "string" ? { description: opts.description.trim() } : {}),
                },
              }),
            );
          } catch (err) {
            done(() => reject(err));
            return;
          }
          publishFallbackTimer = setTimeout(() => triggerPublish(), 1_500);
          publishFallbackTimer.unref?.();
        } else if (evType === "agent_draft_saved" && stage === "updating") {
          triggerPublish();
        } else if (evType === "publish_agent_draft_success") {
          done(() => resolve({ agentId: normalizeChatAgentShortId(cleanId) }));
        } else if (
          evType === "publish_agent_draft_error" ||
          evType === "update_chat_agent_config_error" ||
          evType === "error"
        ) {
          const errMsg = typeof payload.error === "string" ? payload.error : evType;
          done(() => reject(new GatewayError(`Failed to update custom agent: ${errMsg}`, 502, "upstream_error")));
        }
      },
      (err) => done(() => reject(err)),
    );

    ws.once("error", (err) => done(() => reject(err)));
    ws.once("close", () => {
      if (!settled) {
        done(() =>
          reject(new GatewayError("WebSocket closed before custom agent finished publishing.", 502, "upstream_error")),
        );
      }
    });
  });
}
