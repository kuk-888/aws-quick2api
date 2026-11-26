#!/usr/bin/env node
/**
 * Release preflight & optional AI diff reviewer — strictly scoped to `aws-quick2api`.
 *
 * Security invariants:
 * - Refuses to run (and never reads Keychain) outside the `aws-quick2api` git repository root.
 * - Never reads `.env`, parent directories, or files outside `git ls-files` of this repository.
 * - Optional AI review API key is read in-memory only from `AI_REVIEW_API_KEY` or macOS Keychain
 *   (`aws-quick2api-ai-review`) and is never written to disk or printed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_PACKAGE_NAME = "aws-quick2api";
const KEYCHAIN_SERVICE = "aws-quick2api-ai-review";
const DEFAULT_BASE_URL = "";
const DEFAULT_MODEL = "";
const MAX_DIFF_CHARS = 32_000;

const WANT_AI = process.argv.includes("--ai");

function execGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function assertRepoBoundary() {
  const repoRoot = execGit(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const pkgPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error("Refusing to run: package.json not found at git root.");
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (pkg.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(
      `Refusing to run: this review tool is strictly scoped to '${EXPECTED_PACKAGE_NAME}', got '${pkg.name || "unknown"}'.`,
    );
  }
  return repoRoot;
}

const FORBIDDEN_TRACKED_FILES = [
  /^\.env($|\.)/i,
  /^gateway-keys\.json$/i,
  /^usage-ledger\.json$/i,
  /^request-traces\.json$/i,
  /^admin-session\.key$/i,
  /\.(key|pem|p12|pfx)$/i,
];

const SECRET_RULES = [
  { name: "BytePlus Ark API Key", re: /\bark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[0-9a-f]{4,})?\b/i },
  { name: "AWS Access Key ID", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Private Key Block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "Real AWS Quick Access Cookie", re: /aws-ds-access-token=(?!dummy_tok\b)[A-Za-z0-9._~%+-]{28,}/ },
  { name: "Real JSESSIONID Cookie", re: /JSESSIONID=(?!DUMMY_JSESS\b)[A-Za-z0-9._~%+-]{20,}/ },
  { name: "Real OAuth Refresh/Access Token", re: /\b(?:aor|aoa)_[A-Za-z0-9._~%+-]{30,}\b/ },
  { name: "Local macOS User Path", re: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: "Real Proxy Credentials", re: /https?:\/\/(?!(?:user:pass|alice:secret|\*\*\*))[^/\s:@]+:[^/\s@]+@[A-Za-z0-9.-]+:\d+/ },
];

const SKIP_SCAN_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".lock"]);

function runDeterministicPreflight(repoRoot) {
  console.log("[preflight] Scanning tracked & staged files inside aws-quick2api...");
  const tracked = execGit(["ls-files"], repoRoot)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Also include untracked non-ignored files so newly created files are scanned before commit
  const untracked = execGit(["ls-files", "--others", "--exclude-standard"], repoRoot)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const files = Array.from(new Set([...tracked, ...untracked]));
  const violations = [];

  for (const rel of files) {
    if (rel === ".env.example") continue;
    for (const bad of FORBIDDEN_TRACKED_FILES) {
      if (bad.test(rel)) {
        violations.push(`Forbidden file in repository: ${rel}`);
      }
    }
    const ext = path.extname(rel).toLowerCase();
    if (SKIP_SCAN_EXTS.has(ext) || rel === "package-lock.json") continue;

    const abs = path.resolve(repoRoot, rel);
    // Strict boundary check: never follow symlinks outside repoRoot
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      continue;
    }
    if (!real.startsWith(fs.realpathSync(repoRoot) + path.sep)) {
      violations.push(`Symlink escapes repository boundary: ${rel}`);
      continue;
    }
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;

    const content = fs.readFileSync(real, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of SECRET_RULES) {
        if (rule.re.test(line)) {
          // Ignore the scanner's own regex definitions
          if (rel === "scripts/preflight-review.mjs") continue;
          violations.push(`${rule.name} detected in ${rel}:${i + 1}`);
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error("\n[preflight] BLOCKED — sensitive/forbidden items found:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`[preflight] Secret & boundary scan passed (${files.length} files checked).`);

  console.log("[preflight] Running typecheck and unit tests...");
  const tc = spawnSync("npm", ["run", "typecheck"], { cwd: repoRoot, stdio: "inherit" });
  if (tc.status !== 0) process.exit(tc.status ?? 1);
  const tst = spawnSync("npm", ["test"], { cwd: repoRoot, stdio: "inherit" });
  if (tst.status !== 0) process.exit(tst.status ?? 1);
  console.log("[preflight] Deterministic checks PASSED.");
}

function readReviewApiKey() {
  const fromEnv = (process.env.AI_REVIEW_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin") {
    try {
      const val = execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (val) return val;
    } catch {
      return "";
    }
  }
  return "";
}

function collectScopedDiff(repoRoot) {
  // Prefer working tree diff (staged + unstaged + new untracked non-ignored files)
  let diff = execGit(["diff", "-U2", "HEAD", "--", ".", ":(exclude)package-lock.json"], repoRoot).trim();

  const untracked = execGit(["ls-files", "--others", "--exclude-standard"], repoRoot)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((f) => f && f !== "package-lock.json" && !FORBIDDEN_TRACKED_FILES.some((r) => r.test(f)));

  if (untracked.length > 0) {
    const parts = [];
    for (const rel of untracked) {
      const abs = path.resolve(repoRoot, rel);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > 120_000) continue;
      parts.push(`--- /dev/null\n+++ b/${rel}\n${fs.readFileSync(abs, "utf8")}`);
    }
    if (parts.length > 0) {
      diff = [diff, ...parts].filter(Boolean).join("\n\n");
    }
  }

  // If working tree is clean (e.g. during pre-push), diff unpushed commits against upstream or HEAD~1
  if (!diff) {
    try {
      diff = execGit(["diff", "-U2", "@{u}..HEAD", "--", ".", ":(exclude)package-lock.json"], repoRoot).trim();
    } catch {
      try {
        diff = execGit(["diff", "-U2", "HEAD~1..HEAD", "--", ".", ":(exclude)package-lock.json"], repoRoot).trim();
      } catch {
        diff = "";
      }
    }
  }
  return diff;
}

async function runAiReview(repoRoot) {
  const apiKey = readReviewApiKey();
  if (!apiKey) {
    console.warn(
      `[ai-review] No API key found in AI_REVIEW_API_KEY or macOS Keychain ('${KEYCHAIN_SERVICE}'). Skipping AI review.`,
    );
    return;
  }

  const diff = collectScopedDiff(repoRoot);
  if (!diff) {
    console.log("[ai-review] No local diff to review.");
    return;
  }

  const truncated =
    diff.length > MAX_DIFF_CHARS
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n\n...[truncated ${diff.length - MAX_DIFF_CHARS} chars]...`
      : diff;

  const baseUrl = (process.env.AI_REVIEW_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = (process.env.AI_REVIEW_MODEL || DEFAULT_MODEL).trim();
  if (!baseUrl || !model) {
    console.warn("[ai-review] Set AI_REVIEW_BASE_URL and AI_REVIEW_MODEL to enable AI diff review. Skipping.");
    return;
  }

  console.log(`[ai-review] Sending scoped aws-quick2api diff (${truncated.length} chars) to ${model}...`);

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      reasoning_effort: "low",
      max_tokens: 8192,
      messages: [
        {
          role: "system",
          content: [
            "You are a strict open-source release security & code reviewer for the `aws-quick2api` repository.",
            "Review ONLY the provided git diff for:",
            "1. Sensitive data leaks (hardcoded API keys, tokens, cookies, personal emails, local absolute paths, real proxy credentials).",
            "2. Real bugs, security flaws (XSS/injection/SSRF), resource leaks, or broken edge cases.",
            "Ignore minor style nitpicks. Be concise and list findings with file names.",
            "End your response with an exact final line: either `VERDICT: PASS` or `VERDICT: BLOCK`.",
          ].join("\n"),
        },
        {
          role: "user",
          content: `Please review this git diff for aws-quick2api:\n\n\`\`\`diff\n${truncated}\n\`\`\``,
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI review request failed (HTTP ${resp.status}): ${errText.slice(0, 240)}`);
  }

  const data = await resp.json();
  const content = (data?.choices?.[0]?.message?.content || "").trim();
  if (!content) {
    throw new Error("AI reviewer returned an empty response (fail-closed).");
  }
  console.log("\n================ AI REVIEW REPORT ================\n");
  console.log(content);
  console.log("\n==================================================\n");

  if (/VERDICT:\s*BLOCK\b/i.test(content)) {
    console.error("[ai-review] BLOCKED by AI reviewer. Please inspect the findings above.");
    process.exit(1);
  }
  if (!/VERDICT:\s*PASS\b/i.test(content)) {
    console.error("[ai-review] Missing explicit `VERDICT: PASS` line (fail-closed).");
    process.exit(1);
  }
  console.log("[ai-review] PASSED.");
}

async function main() {
  const repoRoot = assertRepoBoundary();
  runDeterministicPreflight(repoRoot);
  if (WANT_AI) {
    await runAiReview(repoRoot);
  }
}

main().catch((err) => {
  console.error("[preflight-review] Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
