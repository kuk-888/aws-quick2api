import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  repo: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  checkedAt: string | null;
  /** Official hot-update tarball asset URL (when published with the release). */
  bundleUrl?: string | null;
  /** Official SHA256SUMS.txt asset URL (required for verified self-update). */
  checksumUrl?: string | null;
  /** Expected tarball asset filename (e.g. `aws-quick2api-dist-v0.1.21.tar.gz`). */
  bundleAssetName?: string | null;
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function readPackageVersion(explicitAppRoot?: string): string {
  const envReleaseDir = process.env.AWS_QUICK_ACTIVE_RELEASE_DIR?.trim();
  const candidates = [
    explicitAppRoot ? path.join(explicitAppRoot, "package.json") : "",
    envReleaseDir ? path.join(envReleaseDir, "package.json") : "",
    // From `dist/src/services/update-checker.js` -> `<appRoot>/package.json`
    path.resolve(THIS_DIR, "../../..", "package.json"),
    path.resolve(process.cwd(), "package.json"),
    path.resolve(process.cwd(), "../package.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version.trim();
    } catch {}
  }
  return "0.1.0";
}

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export const DEFAULT_UPDATE_CHECK_REPO = "kuk-888/aws-quick2api";
const DISABLED_VALUES = new Set(["off", "false", "none", "0", "disabled"]);
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let cachedResult: VersionCheckResult | null = null;
let cachedAtMs = 0;

export async function checkLatestVersion(force = false): Promise<VersionCheckResult> {
  const currentVersion = readPackageVersion();
  const envVal = process.env.UPDATE_CHECK_REPO?.trim();
  const isDisabled = envVal !== undefined && DISABLED_VALUES.has(envVal.toLowerCase());
  const rawRepo = isDisabled ? "" : envVal || DEFAULT_UPDATE_CHECK_REPO;
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rawRepo) ? rawRepo : null;

  if (!repo) {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      repo: null,
      releaseUrl: null,
      releaseNotes: null,
      checkedAt: null,
    };
  }

  const now = Date.now();
  if (!force && cachedResult && cachedResult.repo === repo && now - cachedAtMs < CACHE_TTL_MS) {
    return cachedResult;
  }

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `aws-quick2api/${currentVersion}`,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      throw new Error(`GitHub API ${resp.status}`);
    }
    const data = (await resp.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    const latest = (data.tag_name || "").replace(/^v/i, "").trim() || null;
    const hasUpdate = latest ? compareSemver(latest, currentVersion) > 0 : false;
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const expectedBundleName = latest ? `aws-quick2api-dist-v${latest}.tar.gz` : null;
    const bundleAsset = expectedBundleName
      ? assets.find((a) => a.name === expectedBundleName && typeof a.browser_download_url === "string")
      : undefined;
    const checksumAsset = assets.find(
      (a) =>
        (a.name === "SHA256SUMS.txt" || (expectedBundleName && a.name === `${expectedBundleName}.sha256`)) &&
        typeof a.browser_download_url === "string",
    );
    cachedResult = {
      currentVersion,
      latestVersion: latest,
      hasUpdate,
      repo,
      releaseUrl: data.html_url || `https://github.com/${repo}/releases`,
      releaseNotes: data.body ? data.body.slice(0, 3000) : null,
      checkedAt: new Date(now).toISOString(),
      bundleUrl: bundleAsset?.browser_download_url || null,
      checksumUrl: checksumAsset?.browser_download_url || null,
      bundleAssetName: bundleAsset?.name || expectedBundleName,
    };
    cachedAtMs = now;
    return cachedResult;
  } catch {
    return (
      cachedResult || {
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        repo,
        releaseUrl: `https://github.com/${repo}/releases`,
        releaseNotes: null,
        checkedAt: new Date(now).toISOString(),
      }
    );
  }
}
