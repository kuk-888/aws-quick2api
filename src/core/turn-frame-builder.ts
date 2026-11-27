import crypto from "node:crypto";
import { DESKTOP_CAPABILITIES } from "../aws-quick/ws-transport.js";
import type { QuickAttachment } from "./media-utils.js";
import { buildTraceparent } from "./turn-protocol-state.js";
import type { ParsedProtocolTurn } from "./types.js";

export interface OutboundEditBranch {
  originalMessageId: string;
  rootSessionId: string;
  threadId: string;
}

export interface OutboundTurnFrameParams {
  chunkText: string;
  msgId: string;
  isFinal: boolean;
  isInternalRephraseCall: boolean;
  webSearchEnabled: boolean;
  turn: ParsedProtocolTurn;
  agentMode: string;
  thinkingEffort?: string;
  chatAgentId?: string;
  effectiveCustomPrompt: string | null;
  attachments: QuickAttachment[];
  surfaceType: string;
  outpostId: string;
  appVersion: string;
  surfaceName: "web" | "desktop";
  threadId: string;
  isIncognito: boolean;
  editBranch?: OutboundEditBranch;
}

export function buildOutboundChatFrame(params: OutboundTurnFrameParams): Record<string, unknown> {
  const {
    chunkText,
    msgId,
    isFinal,
    isInternalRephraseCall,
    webSearchEnabled,
    turn,
    agentMode,
    thinkingEffort,
    chatAgentId,
    effectiveCustomPrompt,
    attachments,
    surfaceType,
    outpostId,
    appVersion,
    surfaceName,
    threadId,
    isIncognito,
    editBranch,
  } = params;

  const hasClientTools = turn.tools.length > 0 && turn.toolChoice !== "none";
  const wantsNativeWebSearch = Boolean(turn.nativeSdkTools?.includes("webSearch"));
  const forceWebSearchWithTools = process.env.WEB_SEARCH_WITH_CLIENT_TOOLS?.trim().toLowerCase() === "true";
  const effectiveWebSearch =
    isInternalRephraseCall || !isFinal
      ? false
      : wantsNativeWebSearch
        ? true
        : hasClientTools && !forceWebSearchWithTools
          ? false
          : webSearchEnabled;
  const effectiveAgentMode = isFinal ? agentMode : "fast";
  // Match official desktop capture: explicitly send `"off"` for `fast` mode instead of omitting
  // (including intermediate inline-chunk ack frames which run on `fast`).
  const effectiveThinkingEffort = isInternalRephraseCall
    ? undefined
    : effectiveAgentMode === "fast"
      ? "off"
      : thinkingEffort;

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const locale = process.env.AWS_QUICK_LOCALE?.trim() || "en";

  if (editBranch) {
    // Match official desktop `edit_message` capture (omits session capability flags and `incognito`).
    return {
      type: "edit_message",
      payload: {
        original_message_id: editBranch.originalMessageId,
        message_id: msgId,
        thread_id: editBranch.threadId,
        root_session_id: editBranch.rootSessionId,
        text: chunkText,
        surfaceType,
        outpostId,
        appVersion,
        ...(isIncognito ? { coding_agent_setup_card: 0 } : {}),
        activityType: "chat",
        surface: surfaceName,
        clientVersion: appVersion,
        cohort: "general_availability",
        ...(effectiveCustomPrompt ? { custom_prompt: effectiveCustomPrompt } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        agent_mode: agentMode,
        ...(chatAgentId ? { chat_agent_id: chatAgentId } : {}),
        ...(effectiveThinkingEffort ? { thinking_effort: effectiveThinkingEffort } : {}),
        auto_routing: turn.requestedModel.trim().toLowerCase() === "auto",
        web_search_enabled: effectiveWebSearch,
        user_timezone: timezone,
        user_locale: locale,
      },
    };
  }

  const traceId = crypto.randomUUID();
  return {
    type: "user_message",
    payload: {
      traceId,
      traceparent: buildTraceparent(traceId),
      send_origin: "composer",
      had_physical_input: true,
      surfaceType,
      outpostId,
      appVersion,
      ...DESKTOP_CAPABILITIES,
      activityType: "chat",
      surface: surfaceName,
      clientVersion: appVersion,
      cohort: "general_availability",
      thread_id: threadId,
      text: chunkText,
      ...(isFinal && effectiveCustomPrompt ? { custom_prompt: effectiveCustomPrompt } : {}),
      ...(isFinal && attachments.length > 0 ? { attachments } : {}),
      message_id: msgId,
      agent_mode: effectiveAgentMode,
      ...(chatAgentId ? { chat_agent_id: chatAgentId } : {}),
      ...(effectiveThinkingEffort ? { thinking_effort: effectiveThinkingEffort } : {}),
      auto_routing: isFinal && turn.requestedModel.trim().toLowerCase() === "auto",
      web_search_enabled: effectiveWebSearch,
      direct_chat: false,
      voice_mode: false,
      voice_id: "matthew",
      tts_speed: 1.1,
      ...(isIncognito ? { incognito: true } : {}),
      user_timezone: timezone,
      user_locale: locale,
    },
  };
}
