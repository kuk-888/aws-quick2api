import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  repo: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  checkedAt: string | null;
}

function readPackageVersion(): string {
  const candidates = [
    path.resolve(process.cwd(), "package.json"),
    path.resolve(process.cwd(), "../package.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version.trim();
    } catch {}
  }
  return "0.1.0";
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

const DEFAULT_UPDATE_CHECK_REPO = "kuk-888/aws-quick2api";
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
    };
    const latest = (data.tag_name || "").replace(/^v/i, "").trim() || null;
    const hasUpdate = latest ? compareSemver(latest, currentVersion) > 0 : false;
    cachedResult = {
      currentVersion,
      latestVersion: latest,
      hasUpdate,
      repo,
      releaseUrl: data.html_url || `https://github.com/${repo}/releases`,
      releaseNotes: data.body ? data.body.slice(0, 1200) : null,
      checkedAt: new Date(now).toISOString(),
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
