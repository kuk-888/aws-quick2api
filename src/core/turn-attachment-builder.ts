import crypto from "node:crypto";
import { uploadOAuthBinaryAttachment, uploadOAuthTextAttachment, type OAuthCredential } from "../aws-quick/oauth-client.js";
import { uploadWebBinaryAttachment, type WebCookieCredential } from "../aws-quick/web-client.js";
import {
  buildOutOfBandContextPrompt,
  clampSurrogateStart,
  compressResolvedImagesForQuickFrame,
  extForImageMime,
  jsonStringUtf8Bytes,
  mapAttachmentUploadError,
  mapWithConcurrency,
  MAX_WS_PAYLOAD_UTF8_BYTES,
  prepareHighResImageForOutOfBand,
  resolveNormalizedFiles,
  resolveRawImagePayloads,
  splitPromptIntoSafeChunks,
  WS_FRAME_ENVELOPE_MARGIN_BYTES,
  type QuickAttachment,
} from "./media-utils.js";
import type { RequestAttachmentCache } from "./request-attachment-cache.js";
import { normalizeSystemReminderTagsForUpstream, stripHighRiskClientHeaders } from "./tool-bridge.js";
import { GatewayError, type ParsedProtocolTurn } from "./types.js";

export const MAX_INLINE_CHUNKS = 12;

export interface TurnAttachmentBuildInput {
  turn: ParsedProtocolTurn;
  slotId: string;
  customPrompt: string | null;
  incremental: boolean;
  threadId: string;
  overridePromptText?: string;
  isOAuthAccount: boolean;
  oauthCred?: OAuthCredential;
  isWeb: boolean;
  webCred?: WebCookieCredential;
  effectiveProxy?: string;
  reqAttCache?: RequestAttachmentCache;
}

export async function buildPromptAndAttachmentsForTurn(
  input: TurnAttachmentBuildInput,
): Promise<{ promptText: string; attachments: QuickAttachment[] }> {
  const {
    turn,
    slotId,
    customPrompt,
    incremental,
    threadId,
    overridePromptText,
    isOAuthAccount,
    oauthCred,
    isWeb,
    webCred,
    effectiveProxy,
    reqAttCache,
  } = input;

  const sourceImages = incremental ? (turn.incrementalImages ?? []) : turn.images;
  const sourceFiles = incremental ? (turn.incrementalFiles ?? []) : (turn.files ?? []);
  const rawPromptSource =
    overridePromptText !== undefined
      ? overridePromptText
      : incremental
        ? turn.incrementalUserText
        : turn.fullTranscriptText;
  const rawPromptText = rawPromptSource
    ? normalizeSystemReminderTagsForUpstream(stripHighRiskClientHeaders(rawPromptSource))
    : rawPromptSource;
  const approxTextBytes = jsonStringUtf8Bytes(rawPromptText || "") + jsonStringUtf8Bytes(customPrompt || "");

  const atts: QuickAttachment[] = [];
  const inlineDocTexts: string[] = [];
  const uploadedFileNames: string[] = [];
  const cacheScope = incremental ? "inc" : "full";

  // 1) Process attached files / PDFs first
  if (sourceFiles.length > 0) {
    const resolvedFiles = reqAttCache
      ? await reqAttCache.getOrResolveFiles(`files:${cacheScope}`, sourceFiles, (items) =>
          resolveNormalizedFiles(items, turn.signal),
        )
      : await resolveNormalizedFiles(sourceFiles, turn.signal);
    if ((isOAuthAccount && oauthCred) || (isWeb && webCred)) {
      const uploadTimeoutSignal = turn.signal
        ? AbortSignal.any([turn.signal, AbortSignal.timeout(90_000)])
        : AbortSignal.timeout(90_000);
      try {
        const fileAtts = await mapWithConcurrency(resolvedFiles, 3, async (f) => {
          const doUpload = () =>
            isOAuthAccount && oauthCred
              ? uploadOAuthBinaryAttachment(
                  oauthCred,
                  threadId,
                  f.filename,
                  f.buf,
                  f.mimeType,
                  effectiveProxy,
                  uploadTimeoutSignal,
                )
              : uploadWebBinaryAttachment(
                  webCred!,
                  f.buf,
                  f.filename,
                  f.mimeType,
                  threadId,
                  effectiveProxy,
                  uploadTimeoutSignal,
                );
          return reqAttCache
            ? reqAttCache.getOrUploadAttachment(slotId, threadId, f.buf, doUpload)
            : doUpload();
        });
        atts.push(...fileAtts);
        for (const fa of fileAtts) uploadedFileNames.push(fa.name);
      } catch (fileErr) {
        throw mapAttachmentUploadError(fileErr, "Failed to upload attached file(s) to AWS Quick");
      }
    } else {
      for (const f of resolvedFiles) {
        const m = f.mimeType.split(";")[0] || "";
        if (m.startsWith("text/") || m === "application/json" || m === "application/xml" || m === "application/javascript") {
          inlineDocTexts.push(`[DOCUMENT]\n${f.filename}\n${f.buf.toString("utf8")}`);
        } else {
          throw new GatewayError(
            `Binary document '${f.filename}' (${f.mimeType}) requires an OAuth or Web Cookie AWS Quick credential for out-of-band attachment upload.`,
            400,
            "invalid_request_error",
          );
        }
      }
    }
  }

  // 2) Process images: OAuth & Web Cookie upload >=2 images or >20KB high-res out-of-band;
  //    single tiny images (<=20KB) or Outpost/token use sharp inline compression.
  if (sourceImages.length > 0) {
    let uploadedHighRes = false;
    const resolvedImgs = reqAttCache
      ? await reqAttCache.getOrResolveImages(`imgs:${cacheScope}`, sourceImages, (items) =>
          resolveRawImagePayloads(items, turn.signal),
        )
      : await resolveRawImagePayloads(sourceImages, turn.signal);
    if ((isOAuthAccount && oauthCred) || (isWeb && webCred)) {
      const totalRawImgBytes = resolvedImgs.reduce((sum, im) => sum + im.buf.byteLength, 0);
      if (resolvedImgs.length >= 2 || totalRawImgBytes > 20_000) {
        const uploadTimeoutSignal = turn.signal
          ? AbortSignal.any([turn.signal, AbortSignal.timeout(90_000)])
          : AbortSignal.timeout(90_000);
        try {
          const imgAtts = await mapWithConcurrency(resolvedImgs, 3, async (im, idx) => {
            const prepared = await prepareHighResImageForOutOfBand(im.buf, im.mimeType);
            const ext = extForImageMime(prepared.mimeType);
            const filename = `user_image_${String(idx + 1).padStart(3, "0")}.${ext}`;
            const doUpload = () =>
              isOAuthAccount && oauthCred
                ? uploadOAuthBinaryAttachment(
                    oauthCred,
                    threadId,
                    filename,
                    prepared.buf,
                    prepared.mimeType,
                    effectiveProxy,
                    uploadTimeoutSignal,
                  )
                : uploadWebBinaryAttachment(
                    webCred!,
                    prepared.buf,
                    filename,
                    prepared.mimeType,
                    threadId,
                    effectiveProxy,
                    uploadTimeoutSignal,
                  );
            return reqAttCache
              ? reqAttCache.getOrUploadAttachment(slotId, threadId, prepared.buf, doUpload)
              : doUpload();
          });
          atts.push(...imgAtts);
          uploadedHighRes = true;
        } catch (imgErr) {
          const errMsg = imgErr instanceof Error ? imgErr.message : String(imgErr);
          if (isWeb && /\(404\)|\(405\)/.test(errMsg)) {
            uploadedHighRes = false;
          } else {
            throw mapAttachmentUploadError(imgErr, "Failed to upload image attachment(s) to AWS Quick");
          }
        }
      }
    }
    if (!uploadedHighRes) {
      const willUseOutOfBandText = isOAuthAccount && approxTextBytes > 42_000;
      const adaptiveImageBudget = willUseOutOfBandText
        ? 34_000
        : Math.max(8_000, Math.min(38_000, 42_000 - approxTextBytes));
      const inlineImgs = await compressResolvedImagesForQuickFrame(resolvedImgs, adaptiveImageBudget);
      atts.push(...inlineImgs);
    }
  }

  const fileBanner =
    uploadedFileNames.length > 0
      ? `[Attached file(s) in workspace: ${uploadedFileNames.map((n) => `\`${n}\``).join(", ")}. Read the attached file(s) to answer the user's request.]`
      : "";
  const combinedText = [fileBanner, ...inlineDocTexts, rawPromptText?.trim() || ""]
    .filter(Boolean)
    .join("\n\n");
  const text = combinedText || (atts.length > 0 ? "Please analyze the attached file(s)/image(s)." : "");
  if (!text) {
    throw new GatewayError("Empty prompt", 400, "invalid_request_error");
  }
  return { promptText: text, attachments: atts };
}

/**
 * Handles oversized (>46.5KB) OAuth `.txt` out-of-band context upload and safe inline chunking,
 * while preserving the pre-OOB prefix for `content_filtered` cold-replay rephrasing.
 */
export async function finalizePromptChunksAndOutOfBandText(params: {
  turn: ParsedProtocolTurn;
  slotId: string;
  threadId: string;
  isWarmIncremental: boolean;
  overridePromptText?: string;
  prompt: string;
  customPrompt: string | null;
  attachments: QuickAttachment[];
  isOAuthAccount: boolean;
  oauthCred?: OAuthCredential;
  effectiveProxy?: string;
  reqAttCache?: RequestAttachmentCache;
}): Promise<{
  chunks: string[];
  effectiveCustomPrompt: string | null;
  attachments: QuickAttachment[];
  rawPromptForRephrase: string;
  rephrasePreservePrefix?: string;
}> {
  const {
    turn,
    slotId,
    threadId,
    isWarmIncremental,
    overridePromptText,
    customPrompt,
    isOAuthAccount,
    oauthCred,
    effectiveProxy,
    reqAttCache,
  } = params;
  let prompt = params.prompt;
  let attachments = params.attachments;

  const preOobPrompt = prompt;
  let rawPromptForRephrase = preOobPrompt;
  let rephrasePreservePrefix: string | undefined;

  if (isOAuthAccount && oauthCred) {
    const currentAttBytes = attachments.length > 0 ? Buffer.byteLength(JSON.stringify(attachments), "utf8") : 0;
    const currentFrameBudget =
      currentAttBytes > 0 ? Math.max(4_000, MAX_WS_PAYLOAD_UTF8_BYTES - currentAttBytes) : MAX_WS_PAYLOAD_UTF8_BYTES;
    const safeSingleFrameTotal = Math.max(4_096, currentFrameBudget - WS_FRAME_ENVELOPE_MARGIN_BYTES);
    const estimatedTotalBytes = jsonStringUtf8Bytes(prompt) + jsonStringUtf8Bytes(customPrompt || "");
    if (estimatedTotalBytes > safeSingleFrameTotal) {
      const uploadTimeoutSignal = turn.signal
        ? AbortSignal.any([turn.signal, AbortSignal.timeout(65_000)])
        : AbortSignal.timeout(65_000);
      try {
        const suffix = isWarmIncremental ? `_${crypto.randomUUID().slice(0, 4)}` : "";
        const fileName = `conversation_context_${threadId.slice(0, 8)}${suffix}.txt`;
        const promptBytes = Buffer.from(prompt, "utf8");
        const doTextUpload = () =>
          uploadOAuthTextAttachment(oauthCred, threadId, fileName, prompt, effectiveProxy, uploadTimeoutSignal);
        const fileAtt = reqAttCache
          ? await reqAttCache.getOrUploadAttachment(slotId, threadId, promptBytes, doTextUpload)
          : await doTextUpload();
        attachments = [...attachments, fileAtt];
        const openingHint =
          overridePromptText === undefined && turn.incrementalUserText
            ? normalizeSystemReminderTagsForUpstream(stripHighRiskClientHeaders(turn.incrementalUserText))
            : undefined;
        if (preOobPrompt.length > 16_000) {
          const tailStart = clampSurrogateStart(preOobPrompt, preOobPrompt.length - 12_000);
          rephrasePreservePrefix = preOobPrompt.slice(0, tailStart);
          rawPromptForRephrase = preOobPrompt.slice(tailStart);
        }
        prompt = buildOutOfBandContextPrompt(prompt, fileName, 3_500, isWarmIncremental, openingHint);
      } catch (uploadErr) {
        throw mapAttachmentUploadError(uploadErr, "Failed to upload oversized context attachment to AWS Quick");
      }
    }
  }

  const attachmentsBytes = attachments.length > 0 ? Buffer.byteLength(JSON.stringify(attachments), "utf8") : 0;
  const frameBudgetBytes =
    attachmentsBytes > 0 ? Math.max(4_000, MAX_WS_PAYLOAD_UTF8_BYTES - attachmentsBytes) : MAX_WS_PAYLOAD_UTF8_BYTES;
  const { chunks, effectiveCustomPrompt } = splitPromptIntoSafeChunks(prompt, customPrompt, frameBudgetBytes);
  if (chunks.length > MAX_INLINE_CHUNKS) {
    throw new GatewayError(
      `Prompt requires ${chunks.length} inline chunks (max ${MAX_INLINE_CHUNKS} / ~550KB). Use an OAuth credential for native out-of-band attachment upload or shorten the context.`,
      413,
      "payload_too_large",
    );
  }

  return {
    chunks,
    effectiveCustomPrompt,
    attachments,
    rawPromptForRephrase,
    ...(rephrasePreservePrefix ? { rephrasePreservePrefix } : {}),
  };
}
