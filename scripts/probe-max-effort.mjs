#!/usr/bin/env node
/**
 * Probe whether AWS Quick accepts `thinking_effort: "max"` through this gateway.
 *
 * The gateway forwards `max` optimistically and records what it learns per account in
 * `<DATA_DIR>/effort-capabilities.json`. This script asks the same question end-to-end:
 * it sends one minimal turn at `high` (control) and one at `max` (test), then reports
 * whether the top tier was accepted, rejected (auto-degraded), or inconclusive.
 *
 * Usage (gateway must run a build that includes the max tier):
 *   node scripts/probe-max-effort.mjs --token sk-... --base-url http://127.0.0.1:3456
 *   GW_TOKEN=sk-... node scripts/probe-max-effort.mjs --model claude-opus-5-5
 *
 * Exit codes: 0 = max accepted, 2 = max rejected (gateway degrades), 1 = inconclusive/usage error.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const PROMPT = "Reply with the single word OK.";
const EFFORT_HINT = /thinking[_\s-]?effort|\beffort\b|reasoning|thinking/i;
const INVALID_HINT =
  /invalid|unsupported|not\s+supported|not\s+recogni[sz]ed|unrecogni[sz]ed|unknown|illegal|out\s+of\s+range|must\s+be\s+one\s+of|allowed\s+values?|not\s+allowed|validation/i;

const HELP = `Probe whether AWS Quick accepts thinking_effort "max" through this gateway.

  node scripts/probe-max-effort.mjs [--token sk-...] [--base-url URL] [--model ID]
                                    [--data-dir DIR] [--timeout-ms N] [--only high|max]

Environment fallbacks: GW_TOKEN / GATEWAY_TOKEN, GW_BASE_URL, GW_MODEL, DATA_DIR, GW_TIMEOUT_MS.
Exit codes: 0 = max accepted, 2 = max rejected (gateway degrades to high), 1 = inconclusive.`;

function parseArgs(argv) {
  const opts = {
    baseUrl: (process.env.GW_BASE_URL || "http://127.0.0.1:3456").replace(/\/+$/, ""),
    token: process.env.GW_TOKEN || process.env.GATEWAY_TOKEN || "",
    model: process.env.GW_MODEL || "claude-opus-5-5",
    dataDir: process.env.DATA_DIR || "",
    timeoutMs: Number(process.env.GW_TIMEOUT_MS || 120_000),
    only: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--base-url": opts.baseUrl = next().replace(/\/+$/, ""); break;
      case "--token": opts.token = next(); break;
      case "--model": opts.model = next(); break;
      case "--data-dir": opts.dataDir = next(); break;
      case "--timeout-ms": opts.timeoutMs = Number(next()) || opts.timeoutMs; break;
      case "--only": opts.only = next(); break;
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function looksLikeUnsupportedEffortError(message) {
  return Boolean(message) && EFFORT_HINT.test(message) && INVALID_HINT.test(message);
}

async function sendTurn(opts, effort) {
  const startedAt = Date.now();
  const url = `${opts.baseUrl}/v1/chat/completions`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({
        model: `${opts.model}[effort=${effort}]`,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const text = parsed?.choices?.[0]?.message?.content ?? "";
    const errMessage = parsed?.error?.message || parsed?.message || (parsed ? "" : raw.slice(0, 300));
    return {
      effort,
      status: res.status,
      ok: res.ok,
      ms: Date.now() - startedAt,
      text: typeof text === "string" ? text.trim().slice(0, 80) : "",
      error: res.ok ? "" : String(errMessage || `HTTP ${res.status}`).trim(),
    };
  } catch (err) {
    return {
      effort,
      status: 0,
      ok: false,
      ms: Date.now() - startedAt,
      text: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readCapabilityFile(dataDir) {
  if (!dataDir) return undefined;
  const file = path.join(dataDir, "effort-capabilities.json");
  if (!existsSync(file)) return { file, accounts: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      file,
      accounts: Object.entries(parsed?.accounts ?? {}).map(([account, entry]) => ({
        account,
        state: entry?.state,
        evidence: entry?.evidence,
      })),
    };
  } catch {
    return { file, accounts: [], error: "unreadable" };
  }
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.token) {
    throw new Error("Missing gateway token: pass --token sk-... or set GW_TOKEN/GATEWAY_TOKEN.");
  }

  log(`gateway : ${opts.baseUrl}`);
  log(`model   : ${opts.model}`);
  log(`prompt  : ${PROMPT}`);
  log("");

  const control = opts.only === "max" ? undefined : await sendTurn(opts, "high");
  if (control) log(`high -> HTTP ${control.status} (${control.ms}ms)${control.error ? ` · ${control.error}` : ` · "${control.text}"`}`);

  const probe = opts.only === "high" ? undefined : await sendTurn(opts, "max");
  if (probe) log(`max  -> HTTP ${probe.status} (${probe.ms}ms)${probe.error ? ` · ${probe.error}` : ` · "${probe.text}"`}`);

  const caps = readCapabilityFile(opts.dataDir);
  if (caps) {
    log("");
    log(`probe cache: ${caps.file}${caps.accounts.length === 0 ? " (empty)" : ""}`);
    for (const entry of caps.accounts) {
      log(`  ${entry.account} -> ${entry.state}${entry.evidence ? ` (${entry.evidence})` : ""}`);
    }
  }

  log("");
  if (control && !control.ok) {
    log(`INCONCLUSIVE: the control request at effort=high failed too, so this says nothing about max.`);
    return 1;
  }
  if (!probe) return 0;
  if (probe.ok) {
    log(`VERDICT: upstream ACCEPTED effort=max (request completed).`);
    return 0;
  }
  if (looksLikeUnsupportedEffortError(probe.error)) {
    log(`VERDICT: upstream REJECTED effort=max; the gateway degrades this account to high automatically.`);
    return 2;
  }
  log(`VERDICT: INCONCLUSIVE — max failed for a reason unrelated to the effort value (${probe.error}).`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
