import crypto from "node:crypto";
import type { QuickFileAttachment } from "../aws-quick/oauth-client.js";
import type { NormalizedFile, NormalizedImage } from "./types.js";

export interface ResolvedRawFile {
  filename: string;
  mimeType: string;
  buf: Buffer;
}

export interface ResolvedRawImage {
  buf: Buffer;
  mimeType: string;
}

/**
 * Per-request memoization cache for remote image/file fetches and already-mounted
 * AWS Quick out-of-band attachments.
 *
 * Eliminates redundant HTTP downloads, `sharp` re-encoding, and 3-step Upload+DLP+Bind
 * round-trips whenever a request retries (e.g. `editBranch` content-filter recovery,
 * OAuth 401 force-refresh, `connLimit` recovery, warm-to-cold fallback, or account failover).
 */
export class RequestAttachmentCache {
  private readonly rawFilesByKey = new Map<string, ResolvedRawFile[]>();
  private readonly rawImagesByKey = new Map<string, ResolvedRawImage[]>();
  private readonly preparedImagesByHash = new Map<string, Promise<ResolvedRawImage>>();
  private readonly uploadedByScopeAndHash = new Map<string, Promise<QuickFileAttachment>>();

  async getOrResolveFiles(
    scopeKey: string,
    files: NormalizedFile[],
    resolver: (items: NormalizedFile[]) => Promise<ResolvedRawFile[]>,
  ): Promise<ResolvedRawFile[]> {
    const cached = this.rawFilesByKey.get(scopeKey);
    if (cached) return cached;
    const resolved = await resolver(files);
    this.rawFilesByKey.set(scopeKey, resolved);
    return resolved;
  }

  async getOrResolveImages(
    scopeKey: string,
    images: NormalizedImage[],
    resolver: (items: NormalizedImage[]) => Promise<ResolvedRawImage[]>,
  ): Promise<ResolvedRawImage[]> {
    const cached = this.rawImagesByKey.get(scopeKey);
    if (cached) return cached;
    const resolved = await resolver(images);
    this.rawImagesByKey.set(scopeKey, resolved);
    return resolved;
  }

  async getOrPrepareHighResImage(
    buf: Buffer,
    mimeType: string,
    preparer: () => Promise<ResolvedRawImage>,
  ): Promise<ResolvedRawImage> {
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const key = `${mimeType}|${sha256}`;
    const existing = this.preparedImagesByHash.get(key);
    if (existing) return existing;
    const inflight = preparer().catch((err) => {
      if (this.preparedImagesByHash.get(key) === inflight) {
        this.preparedImagesByHash.delete(key);
      }
      throw err;
    });
    this.preparedImagesByHash.set(key, inflight);
    return inflight;
  }

  async getOrUploadAttachment(
    slotId: string,
    threadId: string,
    buf: Uint8Array,
    uploader: () => Promise<QuickFileAttachment>,
  ): Promise<QuickFileAttachment> {
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const key = `${slotId}|${threadId}|${sha256}`;
    const existing = this.uploadedByScopeAndHash.get(key);
    if (existing) return existing;
    const inflight = uploader().catch((err) => {
      if (this.uploadedByScopeAndHash.get(key) === inflight) {
        this.uploadedByScopeAndHash.delete(key);
      }
      throw err;
    });
    this.uploadedByScopeAndHash.set(key, inflight);
    return inflight;
  }
}
