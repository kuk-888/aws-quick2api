import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface TarEntryInput {
  /** POSIX relative path (forward slashes, no leading slash or `..`). */
  path: string;
  content: Buffer;
  mode?: number;
}

export interface SafeExtractOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  /** Optional allowlist filter on normalized POSIX relative file paths. */
  allowPath?: (relPath: string) => boolean;
}

const BLOCK_SIZE = 512;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 30 * 1024 * 1024; // 30 MB uncompressed ceiling

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const oct = Math.max(0, Math.floor(value)).toString(8);
  const str = oct.padStart(length - 1, "0").slice(-(length - 1)) + "\0";
  buf.write(str, offset, length, "ascii");
}

function splitUstarPath(rawPath: string): { name: string; prefix: string } {
  const clean = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (Buffer.byteLength(clean, "utf8") <= 100) {
    return { name: clean, prefix: "" };
  }
  // Find a `/` boundary where prefix <= 155 bytes and name <= 100 bytes
  let splitIdx = clean.lastIndexOf("/");
  while (splitIdx > 0) {
    const prefix = clean.slice(0, splitIdx);
    const name = clean.slice(splitIdx + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
    splitIdx = clean.lastIndexOf("/", splitIdx - 1);
  }
  throw new Error(`Tar entry path exceeds POSIX USTAR 255-byte limit: ${clean}`);
}

/**
 * Pure-Node zero-dependency POSIX USTAR `.tar.gz` builder.
 * Compatible with standard `tar -xzf` and our strict `extractTarGzSafely()`.
 */
export function createTarGzBuffer(entries: TarEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (const entry of entries) {
    const rel = normalizeSafeRelPath(entry.path);
    const { name, prefix } = splitUstarPath(rel);
    const header = Buffer.alloc(BLOCK_SIZE, 0);

    header.write(name, 0, 100, "utf8");
    writeOctal(header, 100, 8, entry.mode ?? 0o644);
    writeOctal(header, 108, 8, 0); // uid
    writeOctal(header, 116, 8, 0); // gid
    writeOctal(header, 124, 12, entry.content.length);
    writeOctal(header, 136, 12, nowSec);
    // Checksum placeholder: 8 ASCII spaces
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii"); // regular file
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (prefix) {
      header.write(prefix, 345, 155, "utf8");
    }

    let checksum = 0;
    for (let i = 0; i < BLOCK_SIZE; i += 1) checksum += header[i]!;
    const chkOct = checksum.toString(8).padStart(6, "0");
    header.write(chkOct, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;

    chunks.push(header);
    if (entry.content.length > 0) {
      chunks.push(entry.content);
      const rem = entry.content.length % BLOCK_SIZE;
      if (rem !== 0) {
        chunks.push(Buffer.alloc(BLOCK_SIZE - rem, 0));
      }
    }
  }

  // Standard 2x 512-byte EOF zero blocks
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

function readCString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul >= 0 ? slice.subarray(0, nul) : slice).toString("utf8");
}

function parseOctal(buf: Buffer, start: number, len: number): number {
  const str = readCString(buf, start, len).trim();
  if (!str) return 0;
  if (!/^[0-7]+$/.test(str)) {
    throw new Error(`Invalid octal header field in tar archive: ${str}`);
  }
  return Number.parseInt(str, 8);
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

function parsePaxPath(paxData: Buffer): string | null {
  const text = paxData.toString("utf8");
  let idx = 0;
  while (idx < text.length) {
    const sp = text.indexOf(" ", idx);
    if (sp < 0) break;
    const recLen = Number.parseInt(text.slice(idx, sp), 10);
    if (!Number.isFinite(recLen) || recLen <= 0) break;
    const record = text.slice(sp + 1, idx + recLen).replace(/\n$/, "");
    if (record.startsWith("path=")) {
      return record.slice(5);
    }
    idx += recLen;
  }
  return null;
}

export function normalizeSafeRelPath(raw: string): string {
  if (!raw || raw.includes("\0") || raw.includes("\\")) {
    throw new Error(`Unsafe tar path rejected: ${raw}`);
  }
  let s = raw;
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  if (!s || s.startsWith("/")) {
    throw new Error(`Absolute or empty tar path rejected: ${raw}`);
  }
  const segments = s.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      throw new Error(`Path traversal segment rejected in tar archive: ${raw}`);
    }
  }
  return segments.join("/");
}

/**
 * Pure-Node zero-dependency hardened `.tar.gz` extractor.
 * Guards against gzip bombs, header tampering, symlinks/hardlinks/devices, and Zip-Slip traversal.
 */
export function extractTarGzSafely(
  gzBuffer: Buffer,
  destDir: string,
  opts?: SafeExtractOptions,
): string[] {
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = opts?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  // Cap raw gunzip output to prevent decompression bombs
  const tarBuf = zlib.gunzipSync(gzBuffer, {
    maxOutputLength: maxTotalBytes + 2 * 1024 * 1024,
  });

  const resolvedDest = path.resolve(destDir);
  fs.mkdirSync(resolvedDest, { recursive: true, mode: 0o700 });

  const extracted: string[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  let offset = 0;
  let nextPaxPath: string | null = null;

  while (offset + BLOCK_SIZE <= tarBuf.length) {
    if (isZeroBlock(tarBuf, offset)) {
      break;
    }

    const header = tarBuf.subarray(offset, offset + BLOCK_SIZE);
    const expectedChecksum = parseOctal(header, 148, 8);
    let actualChecksum = 0;
    for (let i = 0; i < BLOCK_SIZE; i += 1) {
      actualChecksum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    }
    if (expectedChecksum !== actualChecksum) {
      throw new Error("Tar header checksum mismatch (corrupt archive).");
    }

    const typeByte = header[156]!;
    const typeFlag = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const size = parseOctal(header, 124, 12);
    if (!Number.isFinite(size) || size < 0 || offset + BLOCK_SIZE + size > tarBuf.length) {
      throw new Error("Invalid tar entry size (truncated archive).");
    }

    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    offset = dataStart + paddedSize;

    // PAX extended header (`x`) or global PAX header (`g`)
    if (typeFlag === "x") {
      nextPaxPath = parsePaxPath(tarBuf.subarray(dataStart, dataEnd));
      continue;
    }
    if (typeFlag === "g") {
      continue;
    }

    const rawName = readCString(header, 0, 100);
    const rawPrefix = readCString(header, 345, 155);
    const combinedRaw = nextPaxPath ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
    nextPaxPath = null;

    // Directories (`5`) — validate path only
    if (typeFlag === "5") {
      const trimmedDir = combinedRaw.replace(/\/+$/, "");
      if (!trimmedDir || trimmedDir === ".") continue;
      normalizeSafeRelPath(trimmedDir);
      continue;
    }

    // Strictly reject symlinks (`2`), hardlinks (`1`), device nodes (`3`/`4`/`6`), etc.
    if (typeFlag !== "0") {
      throw new Error(`Unsupported tar entry type '${typeFlag}' rejected for safety.`);
    }

    const relPath = normalizeSafeRelPath(combinedRaw);
    if (opts?.allowPath && !opts.allowPath(relPath)) {
      throw new Error(`Disallowed file path in update archive: ${relPath}`);
    }

    fileCount += 1;
    if (fileCount > maxFiles) {
      throw new Error(`Update archive exceeds maximum file count (${maxFiles}).`);
    }
    totalBytes += size;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Update archive exceeds maximum uncompressed size (${maxTotalBytes} bytes).`);
    }

    const targetPath = path.resolve(resolvedDest, relPath);
    if (!targetPath.startsWith(resolvedDest + path.sep)) {
      throw new Error(`Tar extraction escaped target directory: ${relPath}`);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
    fs.writeFileSync(targetPath, tarBuf.subarray(dataStart, dataEnd), { mode: 0o644 });
    extracted.push(relPath);
  }

  return extracted;
}
