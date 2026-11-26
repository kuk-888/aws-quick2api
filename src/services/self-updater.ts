import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayError } from "../core/types.js";
import { extractTarGzSafely } from "./tar-archive.js";
import {
  checkLatestVersion,
  compareSemver,
  DEFAULT_UPDATE_CHECK_REPO,
  readPackageVersion,
  type VersionCheckResult,
} from "./update-checker.js";

/** Special exit code understood by `bootstrap.js` to trigger an immediate in-place respawn. */
export const EXIT_CODE_SELF_UPDATE_RESTART = 75;

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024; // 20 MB ceiling
const MAX_CHECKSUM_BYTES = 64 * 1024; // 64 KB ceiling
const MAX_RETAINED_RELEASES = 3;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

export interface UpdateBundleManifest {
  version: string;
  depsHash: string;
  nodeMinMajor: number;
  builtAt: string;
  entry: string;
}

export interface SelfUpdateState {
  /** Currently active hot-updated version (e.g. `"0.1.21"`), or `null` to run the built-in app. */
  activeVersion: string | null;
  /** Last known-good version (or `null` for built-in) used for manual or automatic crash rollback. */
  previousVersion: string | null;
  /** Newly installed version awaiting startup health verification by `bootstrap.js`. */
  pendingVersion: string | null;
  /** Versions that crashed during startup verification and will not be auto-booted again. */
  failedVersions: string[];
  lastUpdatedAt?: string;
  lastRollbackReason?: string;
}

export interface SelfUpdateCapability {
  enabled: boolean;
  supervised: boolean;
  canApply: boolean;
  reason?: string;
  builtinVersion: string;
  currentVersion: string;
  activeHotVersion: string | null;
  previousVersion: string | null;
  canRollback: boolean;
  lastRollbackReason?: string;
  depsHash: string;
}

export interface ApplySelfUpdateResult {
  ok: true;
  installedVersion: string;
  previousVersion: string | null;
  willRestart: boolean;
}

export interface RollbackSelfUpdateResult {
  ok: true;
  targetVersion: string;
  willRestart: boolean;
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the built-in application root (the directory containing `package.json` and `node_modules`).
 * Prefers `AWS_QUICK_BUILTIN_ROOT` injected by `bootstrap.js`, then falls back to module-relative/cwd lookup.
 */
export function resolveBuiltinAppRoot(explicitRoot?: string): string {
  const candidates = [
    explicitRoot,
    process.env.AWS_QUICK_BUILTIN_ROOT?.trim(),
    path.resolve(THIS_DIR, "../../.."),
    process.cwd(),
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return path.resolve(dir);
    }
  }
  return path.resolve(process.cwd());
}

/**
 * Computes a deterministic compatibility fingerprint of runtime `dependencies` and minimum Node major.
 * Two releases with the same `depsHash` can safely hot-swap pure JS `dist/src/**` bundles without
 * running `npm ci` or rebuilding native addons (`sharp`).
 */
export function computeRuntimeDepsHash(pkg: {
  dependencies?: Record<string, string>;
  engines?: { node?: string };
}): string {
  const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
  const sortedDeps = Object.keys(deps)
    .sort()
    .map((k) => [k, String(deps[k] ?? "").trim()]);
  const nodeRange = String(pkg.engines?.node ?? "").trim();
  const majorMatch = /(\d+)/.exec(nodeRange);
  const nodeMinMajor = majorMatch ? Number.parseInt(majorMatch[1]!, 10) : 22;
  const payload = JSON.stringify({ nodeMinMajor, dependencies: sortedDeps });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

export function readBuiltinRuntimeInfo(appRoot?: string): {
  appRoot: string;
  version: string;
  depsHash: string;
  nodeMinMajor: number;
} {
  const root = resolveBuiltinAppRoot(appRoot);
  let pkg: { version?: string; dependencies?: Record<string, string>; engines?: { node?: string } } = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    // fallback
  }
  const majorMatch = /(\d+)/.exec(String(pkg.engines?.node ?? ""));
  const nodeMinMajor = majorMatch ? Number.parseInt(majorMatch[1]!, 10) : 22;
  return {
    appRoot: root,
    version: (pkg.version || readPackageVersion(root)).trim(),
    depsHash: computeRuntimeDepsHash(pkg),
    nodeMinMajor,
  };
}

export function updatesRootDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), "updates");
}

export function updateStateFilePath(dataDir: string): string {
  return path.join(updatesRootDir(dataDir), "state.json");
}

export function releaseDirForVersion(dataDir: string, version: string): string {
  const clean = version.replace(/^v/i, "").trim();
  if (!VERSION_RE.test(clean)) {
    throw new GatewayError(`Invalid release version format: ${version}`, 400, "invalid_version");
  }
  return path.join(updatesRootDir(dataDir), "releases", `v${clean}`);
}

export function loadSelfUpdateState(dataDir: string): SelfUpdateState {
  const filePath = updateStateFilePath(dataDir);
  const empty: SelfUpdateState = {
    activeVersion: null,
    previousVersion: null,
    pendingVersion: null,
    failedVersions: [],
  };
  if (!fs.existsSync(filePath)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SelfUpdateState>;
    if (!parsed || typeof parsed !== "object") return empty;
    const normVer = (v: unknown): string | null =>
      typeof v === "string" && VERSION_RE.test(v.trim()) ? v.trim() : null;
    const failed = Array.isArray(parsed.failedVersions)
      ? Array.from(new Set(parsed.failedVersions.filter((x): x is string => typeof x === "string" && VERSION_RE.test(x.trim())).map((x) => x.trim())))
      : [];
    return {
      activeVersion: normVer(parsed.activeVersion),
      previousVersion: normVer(parsed.previousVersion),
      pendingVersion: normVer(parsed.pendingVersion),
      failedVersions: failed,
      ...(typeof parsed.lastUpdatedAt === "string" ? { lastUpdatedAt: parsed.lastUpdatedAt } : {}),
      ...(typeof parsed.lastRollbackReason === "string" ? { lastRollbackReason: parsed.lastRollbackReason } : {}),
    };
  } catch {
    return empty;
  }
}

export function saveSelfUpdateState(dataDir: string, state: SelfUpdateState): void {
  const filePath = updateStateFilePath(dataDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(tmpPath, json, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Non-POSIX
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Ensures `<releaseDir>/node_modules` points to `<builtinAppRoot>/node_modules` so Node ESM bare
 * specifier resolution (`import "ws"`, `import "sharp"`) works even when `DATA_DIR` is outside the app root.
 */
export function ensureReleaseNodeModulesLink(releaseDir: string, builtinAppRoot: string): void {
  const hostNodeModules = path.join(path.resolve(builtinAppRoot), "node_modules");
  if (!fs.existsSync(hostNodeModules)) return;
  const linkPath = path.join(path.resolve(releaseDir), "node_modules");
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      if (path.resolve(path.dirname(linkPath), currentTarget) === hostNodeModules) {
        return;
      }
      fs.unlinkSync(linkPath);
    } else {
      return;
    }
  } catch {
    // Does not exist yet
  }
  fs.symlinkSync(hostNodeModules, linkPath, process.platform === "win32" ? "junction" : "dir");
}

export function readAndValidateReleaseManifest(
  releaseDir: string,
  expectedDepsHash?: string,
): UpdateBundleManifest | null {
  try {
    const manifestPath = path.join(releaseDir, "update-manifest.json");
    if (!fs.existsSync(manifestPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<UpdateBundleManifest>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.version !== "string" || !VERSION_RE.test(parsed.version)) return null;
    if (typeof parsed.depsHash !== "string" || parsed.depsHash.length < 8) return null;
    if (expectedDepsHash && parsed.depsHash !== expectedDepsHash) return null;
    const entryRel = typeof parsed.entry === "string" && parsed.entry === "dist/src/server.js"
      ? parsed.entry
      : "dist/src/server.js";
    const entryAbs = path.join(releaseDir, entryRel);
    if (!fs.existsSync(entryAbs)) return null;
    const nodeMinMajor = typeof parsed.nodeMinMajor === "number" && Number.isFinite(parsed.nodeMinMajor)
      ? parsed.nodeMinMajor
      : 22;
    const currentMajor = Number.parseInt(process.versions.node.split(".")[0] || "22", 10);
    if (currentMajor < nodeMinMajor) return null;
    return {
      version: parsed.version,
      depsHash: parsed.depsHash,
      nodeMinMajor,
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "",
      entry: entryRel,
    };
  } catch {
    return null;
  }
}

export function parseSha256Sums(text: string, targetFilename: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Standard `sha256sum` format: `<64hex>  <filename>` or `<64hex> *<filename>`
    const m = /^([0-9a-f]{64})\s+[*]?(.+)$/i.exec(line);
    if (m) {
      const hex = m[1]!.toLowerCase();
      const file = path.basename(m[2]!.trim());
      if (file === path.basename(targetFilename)) return hex;
      continue;
    }
    // Single-file `.sha256` format: just `<64hex>`
    if (SHA256_HEX_RE.test(line)) {
      return line.toLowerCase();
    }
  }
  return null;
}

export function assertAllowedDownloadUrl(rawUrl: string, allowInsecureLocalForTest = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GatewayError("Invalid release download URL.", 400, "invalid_update_url");
  }
  if (allowInsecureLocalForTest && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) {
    return parsed;
  }
  if (parsed.protocol !== "https:") {
    throw new GatewayError("Update download URL must use HTTPS.", 400, "invalid_update_url");
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) {
    throw new GatewayError(
      `Refusing to download update bundle from untrusted host: ${host}`,
      403,
      "untrusted_update_host",
    );
  }
  return parsed;
}

async function fetchBoundedBytes(
  url: string,
  maxBytes: number,
  fetcher: typeof fetch,
  allowInsecureLocalForTest = false,
): Promise<Buffer> {
  assertAllowedDownloadUrl(url, allowInsecureLocalForTest);
  let currentUrl = url;
  for (let hop = 0; hop <= 5; hop += 1) {
    assertAllowedDownloadUrl(currentUrl, allowInsecureLocalForTest);
    const resp = await fetcher(currentUrl, {
      redirect: "manual",
      headers: { "User-Agent": `aws-quick2api/${readPackageVersion()}` },
      signal: AbortSignal.timeout(45_000),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) throw new GatewayError(`Redirect without Location (${resp.status}).`, 502, "update_download_failed");
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    if (!resp.ok) {
      throw new GatewayError(`Failed to download update asset (HTTP ${resp.status}).`, 502, "update_download_failed");
    }
    const clHeader = resp.headers.get("content-length");
    if (clHeader && Number.parseInt(clHeader, 10) > maxBytes) {
      throw new GatewayError(`Update asset exceeds maximum size limit (${maxBytes} bytes).`, 413, "update_asset_too_large");
    }
    const reader = resp.body?.getReader();
    if (!reader) {
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > maxBytes) {
        throw new GatewayError(`Update asset exceeds maximum size limit (${maxBytes} bytes).`, 413, "update_asset_too_large");
      }
      return Buffer.from(ab);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { }
          throw new GatewayError(`Update asset exceeds maximum size limit (${maxBytes} bytes).`, 413, "update_asset_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks);
  }
  throw new GatewayError("Too many redirects while downloading update asset.", 502, "update_download_failed");
}

function isAllowedBundleRelPath(relPath: string): boolean {
  if (relPath === "update-manifest.json" || relPath === "package.json") return true;
  if (relPath.startsWith("dist/src/") && !relPath.includes("..")) return true;
  return false;
}

function pruneOldReleases(dataDir: string, state: SelfUpdateState): void {
  const releasesDir = path.join(updatesRootDir(dataDir), "releases");
  if (!fs.existsSync(releasesDir)) return;
  const keep = new Set<string>();
  if (state.activeVersion) keep.add(`v${state.activeVersion}`);
  if (state.previousVersion) keep.add(`v${state.previousVersion}`);
  if (state.pendingVersion) keep.add(`v${state.pendingVersion}`);
  try {
    const entries = fs
      .readdirSync(releasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("v"))
      .map((e) => ({
        name: e.name,
        ver: e.name.slice(1),
        fullPath: path.join(releasesDir, e.name),
      }))
      .sort((a, b) => compareSemver(b.ver, a.ver));

    let keptCount = 0;
    for (const item of entries) {
      if (keep.has(item.name) || keptCount < MAX_RETAINED_RELEASES) {
        keptCount += 1;
        continue;
      }
      try {
        fs.rmSync(item.fullPath, { recursive: true, force: true });
      } catch {
        // Non-fatal cleanup
      }
    }
  } catch {
    // Non-fatal
  }
}

export function isSelfUpdateDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DISABLE_SELF_UPDATE || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export function getSelfUpdateCapability(opts: {
  dataDir: string;
  builtinAppRoot?: string;
  env?: NodeJS.ProcessEnv;
}): SelfUpdateCapability {
  const env = opts.env ?? process.env;
  const disabled = isSelfUpdateDisabledByEnv(env);
  const supervised = env.AWS_QUICK_SUPERVISED === "1";
  const builtin = readBuiltinRuntimeInfo(opts.builtinAppRoot);
  const currentVersion = readPackageVersion();
  const state = loadSelfUpdateState(opts.dataDir);
  const activeHotVersion =
    state.activeVersion && compareSemver(state.activeVersion, builtin.version) > 0
      ? state.activeVersion
      : null;

  // Can roll back whenever we are running a hot-updated version (either to `previousVersion` or built-in).
  const canRollback = !disabled && supervised && Boolean(activeHotVersion);

  let reason: string | undefined;
  if (disabled) {
    reason = "Self-update is disabled via DISABLE_SELF_UPDATE=true.";
  } else if (!supervised) {
    reason = "Start via `node dist/src/bootstrap.js` (or `npm start` / latest Docker image) to enable one-click restart.";
  }

  return {
    enabled: !disabled,
    supervised,
    canApply: !disabled && supervised,
    ...(reason ? { reason } : {}),
    builtinVersion: builtin.version,
    currentVersion,
    activeHotVersion,
    previousVersion: state.previousVersion,
    canRollback,
    ...(state.lastRollbackReason ? { lastRollbackReason: state.lastRollbackReason } : {}),
    depsHash: builtin.depsHash,
  };
}

let updateInProgress = false;

export function isSelfUpdateInProgress(): boolean {
  return updateInProgress;
}

/**
 * Downloads, SHA-256 verifies, dependency-checks, extracts, and activates a hot-update release
 * inside `${dataDir}/updates/releases/v<version>/`.
 * Does NOT exit the process itself — caller triggers graceful shutdown (`instance.close()`) then
 * exits with `EXIT_CODE_SELF_UPDATE_RESTART` (75) so `bootstrap.js` immediately respawns the new version.
 */
export async function applySelfUpdate(opts: {
  dataDir: string;
  builtinAppRoot?: string;
  env?: NodeJS.ProcessEnv;
  versionInfo?: VersionCheckResult;
  fetcher?: typeof fetch;
  /** Test-only flag permitting `http://127.0.0.1` mock release servers. */
  allowInsecureLocalForTest?: boolean;
}): Promise<ApplySelfUpdateResult> {
  const env = opts.env ?? process.env;
  if (isSelfUpdateDisabledByEnv(env)) {
    throw new GatewayError("Web self-update is disabled via DISABLE_SELF_UPDATE=true.", 403, "self_update_disabled");
  }
  const supervised = env.AWS_QUICK_SUPERVISED === "1";
  if (!supervised) {
    throw new GatewayError(
      "One-click update requires running under the bootstrap supervisor (`node dist/src/bootstrap.js` or `npm start`). Please upgrade manually via Docker or git pull.",
      409,
      "self_update_not_supervised",
    );
  }
  if (updateInProgress) {
    throw new GatewayError("Another update is already in progress. Please wait.", 409, "update_in_progress");
  }
  updateInProgress = true;
  const stagingDir = path.join(updatesRootDir(opts.dataDir), `.staging-${process.pid}-${Date.now()}`);
  try {
    const fetcher = opts.fetcher ?? fetch;
    const info = opts.versionInfo ?? (await checkLatestVersion(true));
    const allowCustomRepo = (env.ALLOW_CUSTOM_UPDATE_REPO || "").trim().toLowerCase() === "true";
    if (!allowCustomRepo && info.repo && info.repo !== DEFAULT_UPDATE_CHECK_REPO) {
      throw new GatewayError(
        `Refusing self-update from custom repository '${info.repo}'. Set ALLOW_CUSTOM_UPDATE_REPO=true to override.`,
        403,
        "untrusted_update_repo",
      );
    }
    if (!info.latestVersion || !VERSION_RE.test(info.latestVersion)) {
      throw new GatewayError("No valid latest release version available.", 400, "no_update_available");
    }
    const currentVersion = readPackageVersion();
    if (compareSemver(info.latestVersion, currentVersion) <= 0) {
      throw new GatewayError(
        `Already running v${currentVersion} (latest is v${info.latestVersion}).`,
        409,
        "already_up_to_date",
      );
    }
    if (!info.bundleUrl || !info.checksumUrl) {
      throw new GatewayError(
        `Release v${info.latestVersion} does not include a verified hot-update bundle (aws-quick2api-dist-v${info.latestVersion}.tar.gz + SHA256SUMS.txt). Please upgrade via Docker pull or git pull.`,
        409,
        "bundle_not_available",
      );
    }

    const expectedAssetName = info.bundleAssetName || `aws-quick2api-dist-v${info.latestVersion}.tar.gz`;
    const [checksumBuf, bundleBuf] = await Promise.all([
      fetchBoundedBytes(info.checksumUrl, MAX_CHECKSUM_BYTES, fetcher, opts.allowInsecureLocalForTest),
      fetchBoundedBytes(info.bundleUrl, MAX_BUNDLE_BYTES, fetcher, opts.allowInsecureLocalForTest),
    ]);

    const expectedHex = parseSha256Sums(checksumBuf.toString("utf8"), expectedAssetName);
    if (!expectedHex) {
      throw new GatewayError(
        `SHA256SUMS.txt does not contain an entry for ${expectedAssetName}.`,
        502,
        "checksum_missing",
      );
    }
    const actualHex = crypto.createHash("sha256").update(bundleBuf).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(actualHex, "utf8"))) {
      throw new GatewayError(
        "Update bundle SHA-256 verification failed! Aborting update for security.",
        502,
        "checksum_mismatch",
      );
    }

    // Safely extract into staging directory (strict Zip-Slip & symlink rejection)
    const extractedFiles = extractTarGzSafely(bundleBuf, stagingDir, {
      allowPath: isAllowedBundleRelPath,
    });
    if (!extractedFiles.includes("dist/src/server.js") || !extractedFiles.includes("update-manifest.json")) {
      throw new GatewayError(
        "Update bundle is missing required runtime files (dist/src/server.js or update-manifest.json).",
        502,
        "invalid_bundle",
      );
    }

    const builtin = readBuiltinRuntimeInfo(opts.builtinAppRoot);
    const rawManifest = readAndValidateReleaseManifest(stagingDir);
    if (!rawManifest) {
      throw new GatewayError("Update bundle manifest is invalid or requires a newer Node.js version.", 409, "invalid_manifest");
    }
    if (rawManifest.version !== info.latestVersion) {
      throw new GatewayError(
        `Manifest version mismatch (expected v${info.latestVersion}, got v${rawManifest.version}).`,
        502,
        "manifest_version_mismatch",
      );
    }
    if (rawManifest.depsHash !== builtin.depsHash) {
      throw new GatewayError(
        `v${info.latestVersion} updates underlying native/npm dependencies (depsHash changed). Please upgrade via \`docker compose pull && docker compose up -d\` or \`git pull && npm ci && npm run build\`.`,
        409,
        "deps_changed",
      );
    }

    // Link host `node_modules` into the extracted release dir so ESM bare imports work regardless of `DATA_DIR` location
    ensureReleaseNodeModulesLink(stagingDir, builtin.appRoot);

    const targetDir = releaseDirForVersion(opts.dataDir, info.latestVersion);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, targetDir);

    const prevState = loadSelfUpdateState(opts.dataDir);
    const nextState: SelfUpdateState = {
      activeVersion: info.latestVersion,
      previousVersion:
        prevState.activeVersion && prevState.activeVersion !== info.latestVersion
          ? prevState.activeVersion
          : null,
      pendingVersion: info.latestVersion,
      failedVersions: prevState.failedVersions.filter((v) => v !== info.latestVersion),
      lastUpdatedAt: new Date().toISOString(),
    };
    saveSelfUpdateState(opts.dataDir, nextState);
    pruneOldReleases(opts.dataDir, nextState);

    return {
      ok: true,
      installedVersion: info.latestVersion,
      previousVersion: nextState.previousVersion,
      willRestart: true,
    };
  } finally {
    updateInProgress = false;
    try {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * Rolls back to `previousVersion` (if valid) or the built-in image/repo version.
 */
export function rollbackSelfUpdate(opts: {
  dataDir: string;
  builtinAppRoot?: string;
  env?: NodeJS.ProcessEnv;
}): RollbackSelfUpdateResult {
  const env = opts.env ?? process.env;
  if (isSelfUpdateDisabledByEnv(env)) {
    throw new GatewayError("Web self-update is disabled via DISABLE_SELF_UPDATE=true.", 403, "self_update_disabled");
  }
  if (env.AWS_QUICK_SUPERVISED !== "1") {
    throw new GatewayError(
      "Rollback requires running under the bootstrap supervisor (`node dist/src/bootstrap.js`).",
      409,
      "self_update_not_supervised",
    );
  }
  const builtin = readBuiltinRuntimeInfo(opts.builtinAppRoot);
  const state = loadSelfUpdateState(opts.dataDir);
  if (!state.activeVersion) {
    throw new GatewayError("Already running the built-in version; nothing to roll back.", 409, "nothing_to_rollback");
  }

  let targetVersion: string | null = null;
  if (state.previousVersion) {
    const prevDir = releaseDirForVersion(opts.dataDir, state.previousVersion);
    if (readAndValidateReleaseManifest(prevDir, builtin.depsHash)) {
      targetVersion = state.previousVersion;
    }
  }

  const nextState: SelfUpdateState = {
    activeVersion: targetVersion,
    previousVersion: null,
    pendingVersion: null,
    failedVersions: state.failedVersions,
    lastUpdatedAt: new Date().toISOString(),
    lastRollbackReason: `Manual rollback from v${state.activeVersion}`,
  };
  saveSelfUpdateState(opts.dataDir, nextState);

  return {
    ok: true,
    targetVersion: targetVersion ?? builtin.version,
    willRestart: true,
  };
}
