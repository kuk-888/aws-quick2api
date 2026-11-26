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
  MAX_INLINE_CUSTOM_PROMPT_BYTES,
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

  const rawSourceImages = incremental ? (turn.incrementalImages ?? []) : turn.images;
  const rawSourceFiles = incremental ? (turn.incrementalFiles ?? []) : (turn.files ?? []);
  // On cold replay / failover / 80% thread rotation, historical cumulative media can exceed
  // per-turn attachment limits (10 images / 5 files). Keep the most recent items rather than
  // permanently failing the entire conversation with HTTP 400.
  const omittedImages = !incremental && rawSourceImages.length > 10 ? rawSourceImages.length - 10 : 0;
  const omittedFiles = !incremental && rawSourceFiles.length > 5 ? rawSourceFiles.length - 5 : 0;
  const sourceImages = omittedImages > 0 ? rawSourceImages.slice(-10) : rawSourceImages;
  const sourceFiles = omittedFiles > 0 ? rawSourceFiles.slice(-5) : rawSourceFiles;
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

  // 1 & 2) Process attached files/PDFs and images in parallel to cut multimodal cold-turn TTFT
  const processFilesPhase = async (): Promise<{
    fileAtts: QuickAttachment[];
    uploadedNames: string[];
    inlineDocs: string[];
  }> => {
    const fileAtts: QuickAttachment[] = [];
    const uploadedNames: string[] = [];
    const inlineDocs: string[] = [];
    if (sourceFiles.length === 0) return { fileAtts, uploadedNames, inlineDocs };
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
        const uploaded = await mapWithConcurrency(resolvedFiles, 5, async (f) => {
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
        fileAtts.push(...uploaded);
        for (const fa of uploaded) uploadedNames.push(fa.name);
      } catch (fileErr) {
        throw mapAttachmentUploadError(fileErr, "Failed to upload attached file(s) to AWS Quick");
      }
    } else {
      for (const f of resolvedFiles) {
        const m = f.mimeType.split(";")[0] || "";
        if (m.startsWith("text/") || m === "application/json" || m === "application/xml" || m === "application/javascript") {
          inlineDocs.push(`[DOCUMENT]\n${f.filename}\n${f.buf.toString("utf8")}`);
        } else {
          throw new GatewayError(
            `Binary document '${f.filename}' (${f.mimeType}) requires an OAuth or Web Cookie AWS Quick credential for out-of-band attachment upload.`,
            400,
            "invalid_request_error",
          );
        }
      }
    }
    return { fileAtts, uploadedNames, inlineDocs };
  };

  const processImagesPhase = async (): Promise<QuickAttachment[]> => {
    const imgResults: QuickAttachment[] = [];
    if (sourceImages.length === 0) return imgResults;
    let uploadedHighRes = false;
    const resolvedImgs = reqAttCache
      ? await reqAttCache.getOrResolveImages(`imgs:${cacheScope}`, sourceImages, (items) =>
        resolveRawImagePayloads(items, turn.signal),
      )
      : await resolveRawImagePayloads(sourceImages, turn.signal);
    if (resolvedImgs.length === 0) return imgResults;
    if ((isOAuthAccount && oauthCred) || (isWeb && webCred)) {
      const totalRawImgBytes = resolvedImgs.reduce((sum, im) => sum + im.buf.byteLength, 0);
      if (resolvedImgs.length >= 2 || totalRawImgBytes > 20_000) {
        const uploadTimeoutSignal = turn.signal
          ? AbortSignal.any([turn.signal, AbortSignal.timeout(90_000)])
          : AbortSignal.timeout(90_000);
        try {
          const imgAtts = await mapWithConcurrency(resolvedImgs, 5, async (im, idx) => {
            const prepared = await prepareHighResImageForOutOfBand(im.buf, im.mimeType);
            const ext = extForImageMime(prepared.mimeType);
            const imgTag = incremental ? `_${crypto.randomUUID().slice(0, 4)}` : "";
            const filename = `user_image_${String(idx + 1).padStart(3, "0")}${imgTag}.${ext}`;
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
          imgResults.push(...imgAtts);
          uploadedHighRes = true;
        } catch (imgErr) {
          const errMsg = imgErr instanceof Error ? imgErr.message : String(imgErr);
          if (isWeb && /\((?:inner\s+)?(?:404|405)\)/i.test(errMsg)) {
            uploadedHighRes = false;
          } else {
            throw mapAttachmentUploadError(imgErr, "Failed to upload image attachment(s) to AWS Quick");
          }
        }
      }
    }
    if (!uploadedHighRes) {
      const willUseOutOfBandText = ((isOAuthAccount && Boolean(oauthCred)) || (isWeb && Boolean(webCred))) && approxTextBytes > 42_000;
      const adaptiveImageBudget = willUseOutOfBandText
        ? 34_000
        : Math.max(8_000, Math.min(38_000, 42_000 - approxTextBytes));
      const inlineImgs = await compressResolvedImagesForQuickFrame(resolvedImgs, adaptiveImageBudget);
      imgResults.push(...inlineImgs);
    }
    return imgResults;
  };

  const [filesRes, imgsRes] = await Promise.all([processFilesPhase(), processImagesPhase()]);
  atts.push(...filesRes.fileAtts, ...imgsRes);
  uploadedFileNames.push(...filesRes.uploadedNames);
  inlineDocTexts.push(...filesRes.inlineDocs);

  const omissionBanner =
    omittedImages > 0 || omittedFiles > 0
      ? `[Note: ${[
        omittedImages > 0 ? `${omittedImages} earlier image(s)` : "",
        omittedFiles > 0 ? `${omittedFiles} earlier file(s)` : "",
      ]
        .filter(Boolean)
        .join(" and ")} from prior turns were omitted during cold replay to fit per-turn attachment limits; the most recent attachments are included.]`
      : "";
  const fileBanner =
    uploadedFileNames.length > 0
      ? `[Attached file(s) in workspace: ${uploadedFileNames.map((n) => `\`${n}\``).join(", ")}. Read the attached file(s) to answer the user's request.]`
      : "";
  const combinedText = [omissionBanner, fileBanner, ...inlineDocTexts, rawPromptText?.trim() || ""]
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
  isWeb?: boolean;
  webCred?: WebCookieCredential;
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
    isWeb,
    webCred,
    effectiveProxy,
    reqAttCache,
  } = params;
  let prompt = params.prompt;
  let attachments = params.attachments;

  const preOobPrompt = prompt;
  let rawPromptForRephrase = preOobPrompt;
  let rephrasePreservePrefix: string | undefined;

  if ((isOAuthAccount && oauthCred) || (isWeb && webCred)) {
    const currentAttBytes = attachments.length > 0 ? Buffer.byteLength(JSON.stringify(attachments), "utf8") : 0;
    const currentFrameBudget =
      currentAttBytes > 0 ? Math.max(4_000, MAX_WS_PAYLOAD_UTF8_BYTES - currentAttBytes) : MAX_WS_PAYLOAD_UTF8_BYTES;
    const safeSingleFrameTotal = Math.max(4_096, currentFrameBudget - WS_FRAME_ENVELOPE_MARGIN_BYTES);
    const promptJsonBytes = jsonStringUtf8Bytes(prompt);
    const estimatedTotalBytes = promptJsonBytes + jsonStringUtf8Bytes(customPrompt || "");
    // Only offload `prompt` to an OOB `.txt` attachment when `prompt` itself is large enough (>2KB)
    // that offloading actually shrinks the WS frame; never upload a tiny warm turn like "continue"
    // just because `customPrompt` alone is near the frame ceiling.
    if (estimatedTotalBytes > safeSingleFrameTotal && promptJsonBytes > 2_048) {
      const uploadTimeoutSignal = turn.signal
        ? AbortSignal.any([turn.signal, AbortSignal.timeout(65_000)])
        : AbortSignal.timeout(65_000);
      try {
        const suffix = isWarmIncremental ? `_${crypto.randomUUID().slice(0, 4)}` : "";
        const fileName = `conversation_context_${threadId.slice(0, 8)}${suffix}.txt`;
        const promptBytes = Buffer.from(prompt, "utf8");
        const doTextUpload = () =>
          isOAuthAccount && oauthCred
            ? uploadOAuthTextAttachment(oauthCred, threadId, fileName, prompt, effectiveProxy, uploadTimeoutSignal)
            : uploadWebBinaryAttachment(
              webCred!,
              promptBytes,
              fileName,
              "text/plain",
              threadId,
              effectiveProxy,
              uploadTimeoutSignal,
            );
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
        // Byte-accurate dynamic inline window (up to 32,000 chars) measured directly on the actual
        // `buildOutOfBandContextPrompt()` output (including OOB headers + `openingHint`) so the result
        // fits cleanly without overflowing frames OR wiping the user's request to 0 chars when a heavy
        // IDE `customPrompt` (>36KB) will already be capped to `MAX_INLINE_CUSTOM_PROMPT_BYTES` by
        // `splitPromptIntoSafeChunks()`.
        const postOobAttBytes = Buffer.byteLength(JSON.stringify(attachments), "utf8");
        const customPromptBytes = jsonStringUtf8Bytes(customPrompt || "");
        const postOobFrameBudget = Math.max(4_000, MAX_WS_PAYLOAD_UTF8_BYTES - postOobAttBytes);
        const postOobSafeFinalTotal = Math.max(4_096, postOobFrameBudget - WS_FRAME_ENVELOPE_MARGIN_BYTES);
        const customSpillThreshold = Math.min(
          MAX_INLINE_CUSTOM_PROMPT_BYTES,
          Math.max(4_096, postOobSafeFinalTotal - 4_096),
        );
        let realPromptRoom: number;
        if (customPromptBytes > customSpillThreshold) {
          const maxKeptCustomBytes = Math.min(
            MAX_INLINE_CUSTOM_PROMPT_BYTES,
            Math.max(4_096, postOobSafeFinalTotal - 6_144),
          );
          const finalFrameRoom = Math.max(0, postOobSafeFinalTotal - maxKeptCustomBytes - 256);
          const approxOverflowHeadBytes = Math.max(0, customPromptBytes - maxKeptCustomBytes) + 64;
          // If overflowHead + >=2.5KB inline prompt can still fit inside 1 single frame, keep it 1-frame tight;
          // otherwise multi-chunk splitting is already unavoidable, so keep up to 8KB of the user's latest
          // request inline in the final chunk so the model immediately sees what is being asked.
          realPromptRoom =
            finalFrameRoom - approxOverflowHeadBytes >= 2_500
              ? finalFrameRoom - approxOverflowHeadBytes
              : Math.min(8_000, finalFrameRoom);
        } else {
          realPromptRoom = Math.max(0, postOobSafeFinalTotal - customPromptBytes - 128);
        }
        const fitInlineExcerpt = (hint: string | undefined): { lo: number; wrapped: string } => {
          let lo = 0;
          let hi = Math.min(32_000, prompt.length);
          let bestWrapped = buildOutOfBandContextPrompt(prompt, fileName, 0, isWarmIncremental, hint);
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const candidate = buildOutOfBandContextPrompt(prompt, fileName, mid, isWarmIncremental, hint);
            if (jsonStringUtf8Bytes(candidate) <= realPromptRoom) {
              lo = mid;
              bestWrapped = candidate;
            } else {
              hi = mid - 1;
            }
          }
          return { lo, wrapped: bestWrapped };
        };
        let fitted = fitInlineExcerpt(openingHint);
        if (fitted.lo === 0 && openingHint) {
          // If openingHint framing prevented any inline excerpt under a tight budget, drop openingHint
          // so the trailing context excerpt can still fit cleanly.
          fitted = fitInlineExcerpt(undefined);
        }
        prompt = fitted.wrapped;
      } catch (uploadErr) {
        const errMsg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
        if (!(isWeb && /\((?:inner\s+)?(?:404|405)\)/i.test(errMsg))) {
          throw mapAttachmentUploadError(uploadErr, "Failed to upload oversized context attachment to AWS Quick");
        }
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
