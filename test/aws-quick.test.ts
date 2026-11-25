import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
  cborDecode,
  cborEncode,
  decodeCloudOutputFrame,
  decodeGatewayFrame,
  drainEventStream,
  encodeCloudInputFrame,
  encodeEventStream,
  encodeGatewayJsonFrame,
} from "../src/aws-quick/event-stream-cbor.js";
import {
  buildOAuthDiscoveryUrl,
  evaluateDlpPollResponse,
  parseOAuthCredential,
  parseOAuthDiscoveryCallback,
  serializeOAuthCredential,
} from "../src/aws-quick/oauth-client.js";
import { assertSafeWsHost, parseQuickCredential } from "../src/aws-quick/outpost-singleton.js";
import { parseWebCurlOrCredential, serializeWebCredential } from "../src/aws-quick/web-client.js";
import {
  assertSafeRemoteImageUrl,
  buildQuickImageAttachments,
  classifyUpstreamError,
  compactOversizedPrompt,
  estimatePromptTokens,
  isPrivateOrReservedIp,
  isPseudo200UsageLimitPrefix,
  isPseudo200UsageLimitText,
  MAX_PARKED_WS_PER_SLOT,
  pinnedHttpGet,
  splitPromptIntoSafeChunks,
} from "../src/core/engine.js";
import { GatewayError } from "../src/core/types.js";
import { findInsecurePlaceholderConfig, loadConfigFromEnv } from "../src/core/config.js";
import { UpstreamKeyPool, validateChatAgentId } from "../src/core/key-pool.js";
import {
  buildToolBridgePrompt,
  parseToolCallsFromText,
  sanitizeClientSystemPromptForQuick,
  StreamingToolCallFilter,
} from "../src/core/tool-bridge.js";
import { StreamingUiTagSanitizer } from "../src/core/ui-tag-sanitizer.js";
import {
  openAiResponsesAdapter,
  parseChatCompletionsRequest,
  parseResponsesRequest,
} from "../src/protocols/openai.js";
import { anthropicMessagesAdapter, parseAnthropicMessagesRequest } from "../src/protocols/anthropic.js";
import { extendHashWithAssistantTurn, normalizeSystemPromptForHash } from "../src/utils/hash.js";
import { AWS_QUICK_MODELS, formatOpenAiModelList, resolveModelSelection } from "../src/services/model-catalog.js";
import { ClientGatewayKeyManager } from "../src/services/client-keys.js";
import { checkLatestVersion } from "../src/services/update-checker.js";
import { establishSocks5Tunnel, fetchViaOptionalProxy, maskProxyUrl, validateProxyUrl } from "../src/utils/proxy-agent.js";
import { AdminAuthManager, isDirectLoopbackRequest } from "../src/web/admin-auth.js";
import { tryHandleWebAdminRoute, type WebAdminContext } from "../src/web/admin-routes.js";
import { renderDashboardHtml } from "../src/web/dashboard-ui.js";

describe("EventStream + CBOR codec", () => {
  it("round-trips CBOR values", () => {
    const sample = { a: 1, b: "hello", c: true, d: [1, 2, 3], e: null };
    const decoded = cborDecode(cborEncode(sample));
    assert.deepEqual(decoded, sample);
  });

  it("round-trips gateway CBOR+EventStream frame", () => {
    const payload = { type: "session_connect", session_id: "test-123" };
    const frame = encodeGatewayJsonFrame(payload);
    const { messages, consumed } = drainEventStream(frame, 0);
    assert.equal(consumed, frame.length);
    assert.equal(messages.length, 1);
    const decoded = decodeGatewayFrame(messages[0]!);
    assert.deepEqual(decoded, { type: "event", data: payload });
  });

  it("encodes cloud rawInputEvent and decodes rawOutputEvent", () => {
    const out = encodeCloudInputFrame({ type: "ping", payload: { ts: 42 } });
    const parsedOut = JSON.parse(new TextDecoder().decode(out)) as { eventType: string; payload: { payload: string } };
    assert.equal(parsedOut.eventType, "rawInputEvent");
    assert.deepEqual(JSON.parse(Buffer.from(parsedOut.payload.payload, "base64").toString("utf8")), {
      type: "ping",
      payload: { ts: 42 },
    });

    const innerJson = JSON.stringify({ type: "text_delta", payload: { delta: "OK" } });
    const esPayload = new TextEncoder().encode(
      JSON.stringify({ payload: Buffer.from(innerJson, "utf8").toString("base64") }),
    );
    const frame = encodeEventStream(
      { ":event-type": "rawOutputEvent", ":message-type": "event" },
      esPayload,
    );
    const { messages } = drainEventStream(frame, 0);
    assert.equal(messages.length, 1);
    assert.deepEqual(decodeCloudOutputFrame(messages[0]!), {
      type: "event",
      data: { type: "text_delta", payload: { delta: "OK" } },
    });
  });
});

describe("Model catalog & parameter resolution", () => {
  it("maps modes and reasoning_effort overrides", () => {
    const r1 = resolveModelSelection("quick-balanced", { reasoning_effort: "high" });
    assert.equal(r1.selection.agentMode, "balanced");
    assert.equal(r1.selection.thinkingEffort, "high");

    const r2 = resolveModelSelection("quick-fast", { reasoning_effort: "high" });
    assert.equal(r2.selection.agentMode, "fast");
    assert.equal(r2.selection.thinkingEffort, "off");

    const r3 = resolveModelSelection("quick-smart[effort=low]", {});
    assert.equal(r3.selection.agentMode, "smart");
    assert.equal(r3.selection.thinkingEffort, "low");

    const r4 = resolveModelSelection("quick-balanced", { thinking: { type: "enabled" } });
    assert.equal(r4.selection.thinkingEffort, "high");
  });

  it("formats OpenAI /v1/models list", () => {
    const list = formatOpenAiModelList(AWS_QUICK_MODELS);
    assert.equal(list.length, 6);
    assert.equal(list[0]!.owned_by, "aws-quick");
  });
});

describe("Credential parser & ClientKeyStore", () => {
  it("parses local-outpost and imported token formats", () => {
    assert.deepEqual(parseQuickCredential("local-outpost"), { mode: "outpost" });
    assert.deepEqual(parseQuickCredential("cell.example.com|aoa123"), {
      mode: "token",
      wsHost: "cell.example.com",
      jwt: "aoa123",
      outpostId: undefined,
    });
  });

  it("creates, authenticates, and enforces model allowlist on sub-keys", () => {
    const store = new ClientGatewayKeyManager({ gatewayTokens: new Set<string>() });
    const created = store.createKey({
      name: "demo-client",
      allowAllModels: false,
      allowedModels: ["quick-balanced"],
    });
    assert.ok(created.rawToken.startsWith("sk-"));
    const authOk = store.authenticateClient(created.rawToken);
    assert.equal(authOk.keyName, "demo-client");
    assert.doesNotThrow(() => store.assertModelPermitted(authOk, "quick-balanced"));
    assert.throws(() => store.assertModelPermitted(authOk, "quick-advanced"));
    assert.throws(() => store.authenticateClient("sk-invalid-token"));
  });

  it("converts base64 and data-URI images into AWS Quick attachments", async () => {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const atts = await buildQuickImageAttachments([
      { data: tinyPng, mimeType: "image/png" },
      { url: `data:image/jpeg;base64,${tinyPng}` },
    ]);
    assert.equal(atts.length, 2);
    assert.equal(atts[0]!.type, "image");
    assert.equal(atts[0]!.name, "user_image_001.png");
    assert.equal(atts[0]!.mimeType, "image/png");
    assert.ok(atts[0]!.data.startsWith("data:image/png;base64,"));
    assert.equal(atts[0]!.contentSha256.length, 64);
    assert.equal(atts[1]!.name, "user_image_002.jpg");
    assert.equal(atts[1]!.mimeType, "image/jpeg");
  });

  it("bridges client tool schemas and parses streaming <tool_call> blocks", () => {
    const prompt = buildToolBridgePrompt(
      [{ name: "get_weather", description: "Get city weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
      "auto",
    );
    assert.ok(prompt.includes("get_weather"));
    assert.ok(prompt.includes("<tool_call>"));
    assert.equal(buildToolBridgePrompt([], "auto"), "");

    const parsed = parseToolCallsFromText('Let me check.\n<tool_call>\n{"name":"get_weather","arguments":{"city":"Tokyo"}}\n</tool_call>');
    assert.equal(parsed.cleanText, "Let me check.");
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0]!.name, "get_weather");
    assert.equal(parsed.toolCalls[0]!.argumentsJson, '{"city":"Tokyo"}');

    const filter = new StreamingToolCallFilter();
    const out1 = filter.feed("Checking <to");
    const out2 = filter.feed('ol_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>');
    const flushed = filter.flush();
    assert.equal(out1 + out2 + flushed.remainingText, "Checking ");
    assert.equal(flushed.toolCalls.length, 1);
    assert.equal(flushed.toolCalls[0]!.name, "get_weather");
  });

  it("decodes indefinite-length CBOR maps/arrays and parses quick.aws.com Copy as cURL", () => {
    // Indefinite-length CBOR map: { "ok": true, "list": [1, 2] }
    const indefMap = new Uint8Array([
      0xbf,
      0x62, 0x6f, 0x6b, 0xf5,
      0x64, 0x6c, 0x69, 0x73, 0x74, 0x9f, 0x01, 0x02, 0xff,
      0xff,
    ]);
    assert.deepEqual(cborDecode(indefMap), { ok: true, list: [1, 2] });

    const sampleCurl = `curl --url 'https://quick.aws.com/sn/account/123456789012/qbsproxy/quicksight/accounts/123456789012/invocations/profile/usage?_method=GET&mbtc=abc%2B123%3D' \\
  -b 'aws-directoryUserInfo=%7B%22alias%22%3A%22123456789012%22%7D; aws-ds-access-token=dummy_tok; JSESSIONID=DUMMY_JSESS; extra=ignored'`;
    const parsed = parseWebCurlOrCredential(sampleCurl);
    assert.ok(parsed);
    assert.equal(parsed.accountId, "123456789012");
    assert.equal(parsed.mbtc, "abc+123=");
    assert.ok(parsed.cookie.includes("aws-ds-access-token=dummy_tok"));
    assert.ok(!parsed.cookie.includes("extra=ignored"));

    const serialized = serializeWebCredential(parsed);
    const reparsed = parseQuickCredential(serialized);
    assert.equal(reparsed.mode, "web");
    assert.equal(reparsed.web?.accountId, "123456789012");

    const oauthStr = serializeOAuthCredential({
      region: "us-east-1",
      issuerUrl: "https://identitycenter.amazonaws.com/ssoins-test",
      wsHost: "qbs-cell-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
      clientId: "cid_123",
      clientSecret: "csec_456",
      refreshToken: "aor_dummy_refresh",
      email: "user@example.com",
      name: "Test User",
    });
    const parsedOAuth = parseOAuthCredential(oauthStr);
    assert.ok(parsedOAuth);
    assert.equal(parsedOAuth.clientId, "cid_123");
    assert.equal(parsedOAuth.email, "user@example.com");
    assert.equal(parsedOAuth.name, "Test User");
    assert.equal(parseQuickCredential(oauthStr).mode, "oauth");

    const disc = buildOAuthDiscoveryUrl(18080);
    assert.ok(disc.discoveryUrl.startsWith("https://quick.aws.com/sn?qwSurface="));
    const parsedDisc = parseOAuthDiscoveryCallback(
      "http://localhost:18080/callback?nonce=abc&account=123456789012&issuerUrl=https%3A%2F%2Fidentitycenter.amazonaws.com%2Fssoins-0000000000000000&tenantUrl=https%3A%2F%2Fqbs-cell00000000.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev&idcInstanceId=ssoins-0000000000000000&idcRegion=us-east-1",
    );
    assert.equal(parsedDisc.issuerUrl, "https://identitycenter.amazonaws.com/ssoins-0000000000000000");
    assert.equal(parsedDisc.wsHost, "qbs-cell00000000.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev");
    assert.equal(parsedDisc.region, "us-east-1");
    assert.equal(parsedDisc.accountId, "123456789012");
    assert.throws(() =>
      parseOAuthDiscoveryCallback(
        "http://localhost:18080/callback?issuerUrl=https%3A%2F%2Fidentitycenter.amazonaws.com%2Fssoins-0000000000000000&tenantUrl=https%3A%2F%2F169.254.169.254",
      ),
    );
  });

  it("validates/masks per-credential proxy URLs and checks version metadata", async () => {
    assert.equal(validateProxyUrl(""), undefined);
    assert.equal(validateProxyUrl("http://127.0.0.1:7891"), "http://127.0.0.1:7891");
    assert.equal(maskProxyUrl("http://alice:secret@proxy.example.com:8080"), "http://***@proxy.example.com:8080");
    assert.equal(maskProxyUrl("http://127.0.0.1:7891"), "http://127.0.0.1:7891");
    assert.throws(() => validateProxyUrl("ftp://127.0.0.1:21"));
    assert.throws(() => validateProxyUrl("not-a-url"));

    const prevRepo = process.env.UPDATE_CHECK_REPO;
    process.env.UPDATE_CHECK_REPO = "off";
    try {
      const ver = await checkLatestVersion();
      assert.equal(ver.hasUpdate, false);
      assert.equal(ver.repo, null);
      assert.match(ver.currentVersion, /^\d+\.\d+\.\d+/);
    } finally {
      if (prevRepo !== undefined) process.env.UPDATE_CHECK_REPO = prevRepo;
      else delete process.env.UPDATE_CHECK_REPO;
    }
  });

  it("renders syntactically valid inline JavaScript in Web Console HTML", () => {
    const html = renderDashboardHtml("/dashboard", "test-nonce");
    const match = /<script nonce="test-nonce">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match && match[1], "dashboard inline script tag should exist");
    assert.doesNotThrow(() => new vm.Script(match[1]!));

    const els = new Map<string, Record<string, unknown>>();
    const makeEl = (id = ""): Record<string, unknown> => ({
      id,
      style: {},
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      setAttribute() {},
      getAttribute() { return null; },
      hasAttribute() { return false; },
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      querySelector() { return makeEl(); },
      querySelectorAll() { return []; },
      appendChild() {},
      insertBefore() {},
      children: [],
      options: [{ textContent: "all", value: "all" }],
      selectedIndex: 0,
      parentNode: { insertBefore() {}, removeChild() {} },
      textContent: "",
      value: id === "credStatusFilter" ? "all" : "",
      innerHTML: "",
      getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, right: 0, width: 100, height: 30 }; },
    });
    const ctx: Record<string, unknown> = {
      location: { pathname: "/dashboard", origin: "http://localhost:3456", search: "" },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      document: {
        documentElement: { lang: "zh-CN", setAttribute() {}, getAttribute() { return "light"; } },
        getElementById(id: string) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
        querySelector() { return makeEl(); },
        querySelectorAll() { return []; },
        createElement(tag: string) { return makeEl(tag); },
        createElementNS() { return makeEl(); },
        createTreeWalker() { return { nextNode() { return null; } }; },
        addEventListener() {},
        body: makeEl("body"),
      },
      addEventListener() {},
      removeEventListener() {},
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      setTimeout: () => 0,
      clearTimeout() {},
      setInterval: () => 0,
      clearInterval() {},
      Event: class {},
      NodeFilter: { SHOW_TEXT: 4 },
      console, Date, Math, JSON, Number, String, Boolean, Array, Object, Set, Map, Promise, RegExp, encodeURI, encodeURIComponent,
    };
    ctx.window = ctx;
    assert.doesNotThrow(() => vm.runInNewContext(match[1]!, ctx));
    assert.equal((ctx.isCredFilterActive as () => boolean)(), false);
    els.get("credStatusFilter")!.value = "healthy";
    assert.equal((ctx.isCredFilterActive as () => boolean)(), true);
    assert.equal(typeof ctx.syncOneQuota, "function");
  });

  it("enforces one-time initial admin password setup and min length", () => {
    const auth = new AdminAuthManager({ adminPassword: undefined });
    assert.equal(auth.isPasswordConfigured(), false);
    assert.throws(() => auth.setupInitialPassword("short"), /at least 8/i);
    const issued = auth.setupInitialPassword("strong-pass-1234");
    assert.ok(issued.token.startsWith("adm_"));
    assert.equal(auth.isPasswordConfigured(), true);
    assert.throws(() => auth.setupInitialPassword("another-pass-5678"), /already been completed/i);
  });

  it("verifies round-robin, sticky affinity, auto-disable circuit breaker, and incognito toggle", () => {
    const pool = new UpstreamKeyPool({
      quickTokens: ["acct-a-token", "acct-b-token"],
      disabledQuickTokens: [],
      keyLabels: {},
      keyProxies: {},
      keyAutoDisabled: {},
      keyCooldownMs: 30_000,
      lbStrategy: "round-robin",
      sessionAffinityEnabled: false,
      sessionAffinityTtlMs: 60_000,
      autoDisableExhaustedKeys: true,
      incognitoMode: true,
      envFilePath: undefined,
    });

    // 1. Round-robin rotates strictly A -> B -> A when affinity is off
    const l1 = pool.leaseKey("quick-fast");
    const l2 = pool.leaseKey("quick-fast");
    const l3 = pool.leaseKey("quick-fast");
    assert.equal(l1.apiKey, "acct-a-token");
    assert.equal(l2.apiKey, "acct-b-token");
    assert.equal(l3.apiKey, "acct-a-token");
    l1.release();
    l2.release();
    l3.release();

    // 2. Sticky session affinity locks same conversationKey to one account
    pool.updateSettings({ sessionAffinityEnabled: true });
    const s1 = pool.leaseKey("quick-balanced", undefined, "conv-1");
    const s2 = pool.leaseKey("quick-balanced", undefined, "conv-1");
    assert.equal(s1.apiKey, s2.apiKey);
    assert.equal(s2.viaAffinity, true);
    s1.release();
    s2.release();

    // 3. Auto-disable on quota exhaustion trips the bad account and fails over to the healthy one
    const badKey = s1.apiKey;
    const goodKey = badKey === "acct-a-token" ? "acct-b-token" : "acct-a-token";
    pool.reportQuotaExhausted(badKey, "quick-balanced", "Quota exceeded");
    assert.equal(pool.enabledKeyCount(), 1);
    const failover = pool.leaseKey("quick-balanced", new Set([badKey]), "conv-1");
    assert.equal(failover.apiKey, goodKey);
    assert.equal(failover.viaAffinity, false);
    failover.release();

    // 4. Incognito mode toggles cleanly
    pool.updateSettings({ incognitoMode: false });
    assert.equal(pool.getSettings().incognitoMode, false);
  });

  it("splits oversized UTF-8 prompts cleanly into <=50KB chunks without losing characters", () => {
    const small = splitPromptIntoSafeChunks("hello world", "sys");
    assert.equal(small.chunks.length, 1);
    assert.equal(small.effectiveCustomPrompt, "sys");

    // 40,000 Chinese chars = 120,000 UTF-8 bytes -> must split into 3 safe chunks
    const zh40k = "中".repeat(40_000);
    const res = splitPromptIntoSafeChunks(zh40k, "You are helpful.");
    assert.ok(res.chunks.length >= 3);
    assert.equal(res.chunks.join(""), zh40k);
    for (const c of res.chunks) {
      assert.ok(Buffer.byteLength(c, "utf8") <= 50_000);
    }

    // Oversized customPrompt (>36KB) keeps tail/tool-bridge in native custom_prompt instead of dumping [System Instructions]
    const bigSys = "Background guidelines.\n".repeat(2200) + "\n## Client Tool Action Format\n<tool_call>";
    const splitBig = splitPromptIntoSafeChunks("Run tests", bigSys);
    assert.ok(splitBig.effectiveCustomPrompt && splitBig.effectiveCustomPrompt.includes("## Client Tool Action Format"));
    assert.ok(Buffer.byteLength(splitBig.effectiveCustomPrompt, "utf8") <= 36_000);
    assert.ok(!splitBig.chunks.join("").includes("[System Instructions]"));

    // Intermediate chunks use full ~46.5KB budget instead of subtracting customPrompt (halves chunk count on long sessions)
    const sys30k = "S".repeat(30_000);
    const hist150k = "Line of long coding conversation history 0123456789.\n".repeat(2900); // ~153KB
    const fastSplit = splitPromptIntoSafeChunks(hist150k, sys30k);
    assert.ok(fastSplit.chunks.length <= 5, `Expected <=5 chunks for 153KB + 30KB sys, got ${fastSplit.chunks.length}`);
    assert.equal(fastSplit.chunks.join(""), hist150k);
    assert.ok(Buffer.byteLength(fastSplit.chunks[fastSplit.chunks.length - 1]!, "utf8") + 30_000 <= 46_500);
  });

  it("blocks private, loopback, and cloud-metadata image URLs against SSRF", async () => {
    const blockedUrls = [
      "http://127.0.0.1:3456/health",
      "http://localhost/dashboard",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/internal.png",
      "http://192.168.1.1/router.png",
      "http://[::1]:3456/x.png",
      "http://user:pass@example.com/a.png",
    ];
    for (const url of blockedUrls) {
      await assert.rejects(
        () => buildQuickImageAttachments([{ url }]),
        (err: unknown) => {
          const e = err as { status?: number; code?: string };
          return e.status === 400 && (e.code === "ssrf_blocked" || e.code === "invalid_image_url");
        },
        `Expected SSRF block for ${url}`
      );
    }
  });

  it("restricts POST /v1/admin/setup to direct loopback requests", async () => {
    const remoteReq = {
      method: "POST",
      headers: {},
      socket: { remoteAddress: "203.0.113.5" },
    } as unknown as http.IncomingMessage;
    assert.equal(isDirectLoopbackRequest(remoteReq), false);

    const proxiedLoopbackReq = {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.5" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;
    assert.equal(isDirectLoopbackRequest(proxiedLoopbackReq), false);

    const directLoopbackReq = {
      method: "POST",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;
    assert.equal(isDirectLoopbackRequest(directLoopbackReq), true);

    const adminAuth = new AdminAuthManager({ adminPassword: undefined });
    const ctx = {
      config: { dashboardPath: "/dashboard", trustProxy: "loopback" },
      adminAuth,
    } as unknown as WebAdminContext;
    await assert.rejects(
      () =>
        tryHandleWebAdminRoute(
          remoteReq,
          {} as http.ServerResponse,
          "/v1/admin/setup",
          new AbortController().signal,
          ctx
        ),
      (err: unknown) => {
        const e = err as { status?: number; code?: string };
        return e.status === 403 && e.code === "setup_localhost_only";
      }
    );
  });

  it("estimates tokens and compacts oversized prompts while leaving normal prompts untouched", () => {
    const small = "Hello world, this is a normal prompt.";
    const untouched = compactOversizedPrompt(small, null, 850_000);
    assert.equal(untouched.compacted, false);
    assert.equal(untouched.prompt, small);

    const head = "HEAD_ANCHOR_KEEP_ME\n" + "Opening context line.\n".repeat(40);
    const middle = "MIDDLE_NOISE_LINE_0123456789\n".repeat(3000);
    const tail = "RECENT_TURN_CONTEXT\n".repeat(40) + "TAIL_QUESTION_KEEP_ME";
    const huge = head + middle + tail;
    assert.ok(estimatePromptTokens(huge) > 15_000);

    const trimmed = compactOversizedPrompt(huge, null, 10_000);
    assert.equal(trimmed.compacted, true);
    assert.ok(trimmed.prompt.includes("HEAD_ANCHOR_KEEP_ME"));
    assert.ok(trimmed.prompt.includes("TAIL_QUESTION_KEEP_ME"));
    assert.ok(trimmed.prompt.includes("Gateway Auto-Compacted"));
    assert.ok(trimmed.middleSample && trimmed.middleSample.length <= 33_000);

    const summarized = compactOversizedPrompt(huge, null, 10_000, "Key fact: project uses PostgreSQL 17.");
    assert.equal(summarized.compacted, true);
    assert.ok(summarized.prompt.includes("Key fact: project uses PostgreSQL 17."));
    assert.ok(summarized.prompt.includes("HEAD_ANCHOR_KEEP_ME"));
    assert.ok(summarized.prompt.includes("TAIL_QUESTION_KEEP_ME"));
  });

  it("normalizes shorthand proxies and completes RFC 1928/1929 SOCKS5 auth handshake", async () => {
    assert.equal(validateProxyUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
    assert.equal(validateProxyUrl("user:pass@127.0.0.1:8080"), "http://user:pass@127.0.0.1:8080");
    assert.equal(validateProxyUrl("127.0.0.1:8080:user:pass:2"), "http://user:pass%3A2@127.0.0.1:8080");
    assert.equal(validateProxyUrl("socks5://user:pass@127.0.0.1:1080"), "socks5://user:pass@127.0.0.1:1080");
    assert.equal(maskProxyUrl("127.0.0.1:8080:user:pass"), "http://***@127.0.0.1:8080");
    assert.equal(maskProxyUrl("socks5://user:pass@127.0.0.1:1080"), "socks5://***@127.0.0.1:1080");
    assert.throws(() => validateProxyUrl("ftp://1.2.3.4:21"));
    assert.throws(() => validateProxyUrl("not-a-proxy"));

    // Spin up a minimal loopback SOCKS5 server requiring username/password auth (method 0x02)
    let capturedAuth = "";
    let capturedHost = "";
    let capturedPort = 0;
    const server = net.createServer((sock) => {
      let step = 0;
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (step === 0 && buf.length >= 4) {
          assert.equal(buf[0], 0x05);
          buf = Buffer.alloc(0);
          step = 1;
          sock.write(Buffer.from([0x05, 0x02])); // select username/password auth
        } else if (step === 1 && buf.length >= 3) {
          const uLen = buf[1]!;
          const pLen = buf[2 + uLen]!;
          if (buf.length < 3 + uLen + pLen) return;
          const u = buf.subarray(2, 2 + uLen).toString("utf8");
          const p = buf.subarray(3 + uLen, 3 + uLen + pLen).toString("utf8");
          capturedAuth = `${u}:${p}`;
          buf = Buffer.alloc(0);
          step = 2;
          sock.write(Buffer.from([0x01, 0x00])); // auth success
        } else if (step === 2 && buf.length >= 5) {
          const hLen = buf[4]!;
          if (buf.length < 7 + hLen) return;
          capturedHost = buf.subarray(5, 5 + hLen).toString("utf8");
          capturedPort = buf.readUInt16BE(5 + hLen);
          step = 3;
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0])); // CONNECT OK
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const tunnel = await establishSocks5Tunnel(
        new URL(`socks5://demoUser:demoPass@127.0.0.1:${port}`),
        "example.aws.dev",
        443,
        5_000,
      );
      tunnel.destroy();
      assert.equal(capturedAuth, "demoUser:demoPass");
      assert.equal(capturedHost, "example.aws.dev");
      assert.equal(capturedPort, 443);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retries transient residential-proxy TCP/handshake resets up to 2 times", async () => {
    let attempts = 0;
    const flakySocks = net.createServer((sock) => {
      attempts += 1;
      // Simulate KooProxy-style transient TCP drop during SOCKS5 handshake
      sock.destroy();
    });
    await new Promise<void>((resolve) => flakySocks.listen(0, "127.0.0.1", () => resolve()));
    const port = (flakySocks.address() as net.AddressInfo).port;
    try {
      await assert.rejects(
        () =>
          fetchViaOptionalProxy(
            "https://example.aws.dev/health",
            { method: "GET" },
            `socks5://127.0.0.1:${port}`,
            { maxRetries: 2, retryDelayMs: 10 },
          ),
        /SOCKS5 proxy closed connection|ECONNRESET|socket hang up/i,
      );
      assert.equal(attempts, 3); // 1 initial attempt + 2 automatic retries
    } finally {
      await new Promise<void>((resolve) => flakySocks.close(() => resolve()));
    }
  });

  it("converts streaming AWS Quick <decision>/<decisions>/<artifact> XML into Markdown while preserving code blocks", () => {
    const sample =
      '我还没执行任何清理，要做哪些你来定。\n' +
      '<decision question="执行哪些清理？" multi="true">' +
      '<option description="清空容器日志文件，容器不用重启">清空 399MB 容器日志</option>' +
      '<option description="apt-get clean">清理 apt 缓存</option>' +
      '</decision>\n' +
      '```xml\n<decision question="保留代码块原样"><option>Raw</option></decision>\n```\n' +
      '<artifact type="image" src="https://example.com/chart.png" caption="Disk Usage" />\n' +
      '<decisions><decision question="Next step?"><option>Deploy</option></decision></decisions>';

    // Feed in adversarial tiny chunks (3 chars at a time) to test streaming boundary handling
    const sanitizer = new StreamingUiTagSanitizer();
    let out = "";
    for (let i = 0; i < sample.length; i += 3) {
      out += sanitizer.feed(sample.slice(i, i + 3));
    }
    out += sanitizer.flush();

    assert.ok(out.includes("**执行哪些清理？**（可多选）"));
    assert.ok(out.includes("- **清空 399MB 容器日志** — 清空容器日志文件，容器不用重启"));
    assert.ok(out.includes("- **清理 apt 缓存** — apt-get clean"));
    assert.ok(out.includes('```xml\n<decision question="保留代码块原样"><option>Raw</option></decision>\n```'));
    assert.ok(out.includes("![Disk Usage](https://example.com/chart.png)"));
    assert.ok(out.includes("**Next step?**\n- **Deploy**"));
    assert.ok(!out.includes('question="执行哪些清理？"'));
    assert.ok(!out.includes("<artifact"));
  });

  it("automatically compresses oversized images (>40KB base64) to fit AWS Quick 50KB frame limit", async () => {
    // Generate a 1600x900 synthetic gradient PNG (well over 100KB raw)
    const sharpMod = (await import("sharp")).default;
    const width = 1600;
    const height = 900;
    const rawPixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        rawPixels[idx] = (x * 7 + y * 3) & 0xff;
        rawPixels[idx + 1] = (x * 13 ^ y * 5) & 0xff;
        rawPixels[idx + 2] = (x + y * 11) & 0xff;
      }
    }
    const bigPng = await sharpMod(rawPixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
    assert.ok(bigPng.toString("base64").length > 100_000);

    const attachments = await buildQuickImageAttachments([{ mimeType: "image/png", data: bigPng.toString("base64") }]);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.mimeType, "image/jpeg");
    assert.ok(attachments[0]!.data.length <= 45_000, `Expected <=45KB data URI, got ${attachments[0]!.data.length}`);
  });

  it("supports Codex CLI custom/local_shell tools, multi-turn Chat Completions tool_calls, and multi-client identity sanitization", async () => {
    // 1. Multi-client identity-clash sanitization (strictly active ONLY when hasTools=true; plain chat is 100% passthrough)
    const rawCodex = "You are Codex, a coding agent running in the user's terminal.\nKeep edits minimal.";
    const cleanedCodex = sanitizeClientSystemPromptForQuick(rawCodex, true);
    assert.ok(!cleanedCodex.includes("You are Codex"));
    assert.ok(cleanedCodex.includes("Keep edits minimal."));
    assert.equal(sanitizeClientSystemPromptForQuick(rawCodex, false), rawCodex);
    assert.ok(!sanitizeClientSystemPromptForQuick("You are Hermes, an autonomous agent.", true).includes("You are Hermes"));

    // 2. Codex Responses API with `custom` (apply_patch) + `local_shell` tools & tool call/output history
    const codexTurn = parseResponsesRequest({
      model: "quick-balanced",
      instructions: rawCodex,
      tools: [
        { type: "custom", name: "apply_patch", description: "Apply unified patch" },
        { type: "local_shell" },
        {
          type: "namespace",
          name: "mcp__local_e2e",
          tools: [
            {
              type: "function",
              name: "calc_magic_code",
              description: "Compute verification code",
              parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
            },
          ],
        },
      ],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Patch foo.ts and run tests" }] },
        { type: "custom_tool_call", call_id: "call_patch_1", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
        { type: "custom_tool_call_output", call_id: "call_patch_1", output: "Patched foo.ts" },
        { type: "local_shell_call", call_id: "call_sh_1", action: { type: "exec", command: ["npm", "test"] } },
        { type: "local_shell_call_output", call_id: "call_sh_1", output: "All tests passed" },
      ],
    });
    assert.equal(codexTurn.tools.length, 3);
    assert.equal(codexTurn.tools[0]!.toolKind, "custom");
    assert.equal(codexTurn.tools[1]!.toolKind, "local_shell");
    assert.equal(codexTurn.tools[2]!.name, "mcp__local_e2e__calc_magic_code");
    assert.equal(codexTurn.tools[2]!.toolNamespace, "mcp__local_e2e");
    assert.equal(codexTurn.tools[2]!.wireName, "calc_magic_code");
    assert.equal(codexTurn.hasToolResults, true);
    assert.ok(codexTurn.fullTranscriptText.includes("Patched foo.ts"));
    assert.ok(codexTurn.fullTranscriptText.includes("All tests passed"));

    // Verify Responses adapter emits `custom_tool_call`, `local_shell_call`, and namespaced `function_call` wire formats
    async function* fakeToolEvents() {
      yield {
        type: "tool_calls" as const,
        calls: [
          {
            id: "call_c1",
            name: "apply_patch",
            argumentsJson: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
            argsObject: { input: "*** Begin Patch\n*** End Patch" },
          },
          {
            id: "call_s1",
            name: "local_shell",
            argumentsJson: JSON.stringify({ command: ["ls", "-la"] }),
            argsObject: { command: ["ls", "-la"] },
          },
          {
            id: "call_m1",
            name: "mcp__local_e2e__calc_magic_code",
            argumentsJson: JSON.stringify({ a: 12, b: 34 }),
            argsObject: { a: 12, b: 34 },
          },
        ],
      };
      yield { type: "done" as const, stopReason: "tool_calls" as const };
    }
    const respJson = await openAiResponsesAdapter.collectJson(fakeToolEvents(), codexTurn);
    const outItems = respJson.output as Array<Record<string, unknown>>;
    assert.equal(outItems[0]!.type, "custom_tool_call");
    assert.equal(outItems[0]!.input, "*** Begin Patch\n*** End Patch");
    assert.equal(outItems[1]!.type, "local_shell_call");
    assert.deepEqual((outItems[1]!.action as Record<string, unknown>).command, ["ls", "-la"]);
    assert.equal(outItems[2]!.type, "function_call");
    assert.equal(outItems[2]!.namespace, "mcp__local_e2e");
    assert.equal(outItems[2]!.name, "calc_magic_code");

    // 3. OpenAI Chat Completions multi-turn tool_calls + role:"tool"
    const chatTurn = parseChatCompletionsRequest({
      model: "quick-balanced",
      tools: [
        { type: "function", function: { name: "read_file", description: "Read file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
      ],
      messages: [
        { role: "system", content: "You are Cline, an AI coding assistant." },
        { role: "user", content: "Read package.json" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"package.json\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", name: "read_file", content: "{\"name\":\"demo\"}" },
      ],
    });
    assert.equal(chatTurn.hasToolResults, true);
    assert.equal(chatTurn.trailingToolResults.length, 1);
    assert.equal(chatTurn.trailingToolResults[0]!.toolCallId, "call_1");
    assert.ok(chatTurn.fullTranscriptText.includes("[TOOL_RESULT name=read_file id=call_1]:"));

    // 4. Early SSE cancellation right after first frame MUST finalize inner upstream generator (no zombie running traces)
    let respFinalized = false;
    async function* fakeRespEvents() {
      try {
        yield { type: "done" as const, stopReason: "stop" as const };
      } finally {
        respFinalized = true;
      }
    }
    const respStream = openAiResponsesAdapter.streamSse(fakeRespEvents(), codexTurn);
    const firstResp = await respStream.next();
    assert.equal(firstResp.done, false);
    await respStream.return(undefined);
    assert.equal(respFinalized, true);

    let anthFinalized = false;
    async function* fakeAnthEvents() {
      try {
        yield { type: "done" as const, stopReason: "stop" as const };
      } finally {
        anthFinalized = true;
      }
    }
    const anthStream = anthropicMessagesAdapter.streamSse(fakeAnthEvents(), codexTurn);
    const firstAnth = await anthStream.next();
    assert.equal(firstAnth.done, false);
    await anthStream.return(undefined);
    assert.equal(anthFinalized, true);
  });

  it("keeps conversationKey and warm_incremental prefix hashes stable across dynamic systemPrompt and tool-call turns", () => {
    // 1. Dynamic timestamps/dates in systemPrompt must normalize identically
    const normA = normalizeSystemPromptForHash("You are Witan.\nCurrent time: 2026-11-23 23:34:01\nNow: 2026-11-23T15:34:01Z");
    const normB = normalizeSystemPromptForHash("You are Witan.\nCurrent time: 2026-11-23 23:39:37\nNow: 2026-11-23T15:39:37Z");
    assert.equal(normA, normB);

    // 2. OpenAI Chat (Witan-like): dynamic systemPrompt + multi-turn tool calls maintain sticky conversationKey & warm prefix hit
    const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
    const t1 = parseChatCompletionsRequest({
      model: "quick-balanced",
      tools,
      messages: [
        { role: "system", content: "You are Witan. Current time: 2026-11-23 23:34:01. Active todos: 0." },
        { role: "user", content: "Help me refactor src/config.ts to use port 9443." },
      ],
    });
    assert.ok(t1.conversationKey);
    assert.ok(t1.currentInputPrefixHash);
    const expectedAfterT1 = extendHashWithAssistantTurn(t1.currentInputPrefixHash!, "Reading config...", [
      { id: "call_w1", name: "read_file" },
    ]);

    const t2 = parseChatCompletionsRequest({
      model: "quick-balanced",
      tools,
      messages: [
        { role: "system", content: "You are Witan. Current time: 2026-11-23 23:35:48. Active todos: 2 (reading)." },
        { role: "user", content: "Help me refactor src/config.ts to use port 9443." },
        {
          role: "assistant",
          content: "Reading config...",
          tool_calls: [{ id: "call_w1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/config.ts\"}" } }],
        },
        { role: "tool", tool_call_id: "call_w1", name: "read_file", content: "export const PORT = 3000;" },
      ],
    });
    assert.equal(t2.conversationKey, t1.conversationKey);
    assert.equal(t2.priorPrefixHash, expectedAfterT1);
    assert.ok(t2.incrementalUserText && t2.incrementalUserText.includes("[TOOL_RESULT name=read_file id=call_w1]:"));
    assert.ok(!t2.incrementalUserText!.includes("Help me refactor"));

    // 3. Anthropic Messages (Claude Code): tool_use -> tool_result hits warm_incremental
    const anthTools = [{ name: "Read", input_schema: { type: "object" } }];
    const a1 = parseAnthropicMessagesRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: "Claude Code system prompt. Timestamp: 2026-11-23T15:34:01Z",
      tools: anthTools,
      messages: [{ role: "user", content: "Please inspect package.json and report the version." }],
    });
    const expectedAfterA1 = extendHashWithAssistantTurn(a1.currentInputPrefixHash!, "", [
      { id: "toolu_01", name: "Read" },
    ]);
    const a2 = parseAnthropicMessagesRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: "Claude Code system prompt. Timestamp: 2026-11-23T15:36:12Z",
      tools: anthTools,
      messages: [
        { role: "user", content: "Please inspect package.json and report the version." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "package.json" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "{\"version\":\"0.1.7\"}" }] },
      ],
    });
    assert.equal(a2.conversationKey, a1.conversationKey);
    assert.equal(a2.priorPrefixHash, expectedAfterA1);
    assert.ok(a2.incrementalUserText && a2.incrementalUserText.includes("[TOOL_RESULT id=toolu_01]:"));

    // 4. OpenAI Responses (Codex CLI): coalesces assistant text + function_call and hits warm_incremental
    const r1 = parseResponsesRequest({
      model: "gpt-5.4",
      instructions: "Codex CLI. Current date: 2026-11-23 23:34:01",
      tools: [{ type: "custom", name: "apply_patch" }],
      input: [{ role: "user", content: "Patch src/app.ts to export VERSION." }],
    });
    const expectedAfterR1 = extendHashWithAssistantTurn(r1.currentInputPrefixHash!, "Applying patch now.", [
      { id: "call_c1", name: "apply_patch" },
    ]);
    const r2 = parseResponsesRequest({
      model: "gpt-5.4",
      instructions: "Codex CLI. Current date: 2026-11-23 23:38:55",
      tools: [{ type: "custom", name: "apply_patch" }],
      input: [
        { role: "user", content: "Patch src/app.ts to export VERSION." },
        { role: "assistant", content: "Applying patch now." },
        { type: "custom_tool_call", call_id: "call_c1", name: "apply_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "call_c1", output: "Patched src/app.ts" },
      ],
    });
    assert.equal(r2.conversationKey, r1.conversationKey);
    assert.equal(r2.priorPrefixHash, expectedAfterR1);
    assert.equal(r2.incrementalUserText, "[TOOL_RESULT id=call_c1]:\nPatched src/app.ts");
  });

  it("recovers malformed JSON (trailing commas, literal newlines) and missing </tool_call> closing tags without mutating user code", () => {
    // 1. Trailing comma + unescaped literal newline inside code string: MUST preserve legal trailing commas INSIDE user code!
    const malformed = `Updating file now.\n<tool_call>\n{\n  "name": "write_file",\n  "arguments": {\n    "path": "src/a.ts",\n    "content": "const arr = [\n  1,\n  2,\n];",\n  },\n}\n</tool_call>`;
    const r1 = parseToolCallsFromText(malformed);
    assert.equal(r1.cleanText, "Updating file now.");
    assert.equal(r1.toolCalls.length, 1);
    assert.equal(r1.toolCalls[0]!.name, "write_file");
    assert.equal(r1.toolCalls[0]!.argsObject.path, "src/a.ts");
    assert.equal(r1.toolCalls[0]!.argsObject.content, "const arr = [\n  1,\n  2,\n];");

    // 2. Missing closing </tool_call> tag at end of turn
    const unclosed = `Checking status.\n<tool_call>\n{"name": "run_shell", "arguments": {"command": "git status"}}`;
    const r2 = parseToolCallsFromText(unclosed);
    assert.equal(r2.cleanText, "Checking status.");
    assert.equal(r2.toolCalls.length, 1);
    assert.equal(r2.toolCalls[0]!.name, "run_shell");
    assert.equal(r2.toolCalls[0]!.argsObject.command, "git status");

    // 3. StreamingToolCallFilter ignores <tool_call> inside Markdown code fences & undeclared tool names,
    //    while capturing real declared case-insensitive <TOOL_CALL>
    const f = new StreamingToolCallFilter(new Set(["read_file"]));
    const out1 = f.feed("Example:\n```xml\n<tool_call>{\"name\":\"demo\",\"arguments\":{\"x\":1}}</tool_call>\n```\nInline `<tool_call>{\"name\":\"demo\"}</tool_call>` and bare <tool_call>{\"name\":\"demo\"}</tool_call>\nNow real: ");
    const out2 = f.feed("<TOOL_CALL>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}</TOOL_CALL>");
    const fl = f.flush();
    assert.ok((out1 + out2 + fl.remainingText).includes("\"name\":\"demo\""));
    assert.equal(fl.toolCalls.length, 1);
    assert.equal(fl.toolCalls[0]!.name, "read_file");

    // 4. Heavy JSON-escaped code payload stays strictly <= 50KB AFTER JSON.stringify encoding
    const heavyCode = `const s = "quoted \\\\ \\n line";\n`.repeat(1600); // ~51KB raw, ~64KB JSON-escaped
    const escapedSplit = splitPromptIntoSafeChunks(heavyCode, "sys");
    assert.equal(escapedSplit.chunks.join(""), heavyCode);
    for (const c of escapedSplit.chunks) {
      assert.ok(Buffer.byteLength(JSON.stringify(c), "utf8") <= 46_500);
    }
  });

  it("classifies AWS Quick LimitExceededException (Too many active connections) as transient rate/conn limit, never quota exhaustion", () => {
    assert.ok(MAX_PARKED_WS_PER_SLOT >= 1 && MAX_PARKED_WS_PER_SLOT <= 3);

    const connLimit = classifyUpstreamError(
      new GatewayError(
        `AWS Quick error: [LimitExceededException] {"Message":"Too many active connections. Maximum allowed: 5"}`,
        502,
        "upstream_error",
      ),
    );
    assert.equal(connLimit.isConnLimitErr, true);
    assert.equal(connLimit.isQuotaErr, false);
    assert.equal(connLimit.isRateLimitErr, true);
    assert.equal(connLimit.isAuthErr, false);

    // Real quota exhaustion must still be detected as isQuotaErr
    const realQuota = classifyUpstreamError(
      new GatewayError("Monthly usage limit exceeded / insufficient quota", 402, "quota_exhausted"),
    );
    assert.equal(realQuota.isConnLimitErr, false);
    assert.equal(realQuota.isQuotaErr, true);

    // Pseudo-200 usage-limit reply detection (zero-delay for non-"You" text; catches ASCII & curly apostrophe)
    assert.equal(isPseudo200UsageLimitPrefix("好的，我来帮你"), false);
    assert.equal(isPseudo200UsageLimitPrefix("You can run npm test"), false);
    assert.equal(isPseudo200UsageLimitPrefix("You’ve reached"), true);
    assert.equal(isPseudo200UsageLimitText("You’ve reached your usage limit. Check your profile for details."), true);
    assert.equal(isPseudo200UsageLimitText("You've reached your usage limit. Check your profile for details."), true);
    assert.equal(isPseudo200UsageLimitText("You can reach your usage limit if you run too many jobs."), false);
  });

  it("validates, persists, and resolves global + per-account chat_agent_id overrides", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    assert.equal(validateChatAgentId(undefined), undefined);
    assert.equal(validateChatAgentId("   "), undefined);
    assert.equal(validateChatAgentId("  11111111-2222-3333-4444-555555555555  "), "11111111-2222-3333-4444-555555555555");
    assert.equal(validateChatAgentId("arn:aws:quicksight:us-east-1:123456789012:agent/abc-123"), "arn:aws:quicksight:us-east-1:123456789012:agent/abc-123");
    assert.throws(() => validateChatAgentId("bad id with spaces"), /invalid_chat_agent_id|Invalid chat_agent_id/);
    assert.throws(() => validateChatAgentId("bad\nid"), /invalid_chat_agent_id|Invalid chat_agent_id/);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aq-agent-id-"));
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "HOST=127.0.0.1\n", "utf8");
    try {
      const cfg = loadConfigFromEnv(
        {
          QUICK_TOKENS: "ws.example.com|tok_alpha_1234,ws.example.com|tok_beta_5678",
          CHAT_AGENT_ID: "agent-global-001",
        },
        envPath,
      );
      assert.equal(cfg.chatAgentId, "agent-global-001");

      const pool = new UpstreamKeyPool(cfg);
      assert.equal(pool.getSettings().chatAgentId, "agent-global-001");

      const slots = pool.statusSnapshot();
      assert.equal(slots.length, 2);
      const slotA = slots[0]!;
      const slotB = slots[1]!;

      // Per-account override on slotA
      pool.updateSlotMeta(slotA.slotId, { chatAgentId: "agent-slot-a" });
      assert.equal(pool.statusSnapshot().find((s) => s.slotId === slotA.slotId)?.chatAgentId, "agent-slot-a");
      assert.equal(pool.statusSnapshot().find((s) => s.slotId === slotB.slotId)?.chatAgentId, undefined);

      // Lease exposes per-account override cleanly
      const leaseA = pool.leaseSpecificKey("ws.example.com|tok_alpha_1234");
      assert.equal(leaseA.chatAgentId, "agent-slot-a");
      leaseA.release();

      // Update global default, autoEnsureCodingAgent, and customAgentPrompt template, verify persistence to .env
      pool.updateSettings({
        chatAgentId: "agent-global-002",
        autoEnsureCodingAgent: false,
        customAgentPrompt: "Line1\nLine2 custom prompt",
      });
      assert.equal(pool.getSettings().chatAgentId, "agent-global-002");
      assert.equal(pool.getSettings().autoEnsureCodingAgent, false);
      assert.equal(pool.getSettings().customAgentPrompt, "Line1\nLine2 custom prompt");

      const envContent = fs.readFileSync(envPath, "utf8");
      assert.ok(envContent.includes("CHAT_AGENT_ID=agent-global-002"));
      assert.ok(envContent.includes("AUTO_ENSURE_CODING_AGENT=false"));
      assert.ok(envContent.includes("CUSTOM_AGENT_PROMPT=Line1\\nLine2 custom prompt"));
      assert.ok(envContent.includes(`"${slotA.slotId}":"agent-slot-a"`));

      // Clear per-account and global overrides cleanly & re-enable autoEnsureCodingAgent
      pool.updateSlotMeta(slotA.slotId, { chatAgentId: "" });
      pool.updateSettings({ chatAgentId: "", autoEnsureCodingAgent: true, customAgentPrompt: "" });
      assert.equal(pool.getSettings().chatAgentId, undefined);
      assert.equal(pool.getSettings().autoEnsureCodingAgent, true);
      assert.equal(pool.getSettings().customAgentPrompt, undefined);
      assert.equal(pool.statusSnapshot().find((s) => s.slotId === slotA.slotId)?.chatAgentId, undefined);

      // Compact & fallback tool bridge prompts stay clean (no adversarial/guardrail-trigger phrases)
      const sampleTool = [{ name: "Read", description: "Read file", inputSchema: { type: "object" } }];
      const compactPrompt = buildToolBridgePrompt(sampleTool, "auto", { compactForCustomAgent: true });
      const fallbackPrompt = buildToolBridgePrompt(sampleTool, "auto", { compactForCustomAgent: false });
      assert.ok(compactPrompt.includes("## Client Tools (JSON Schema)"));
      assert.ok(!compactPrompt.includes("bypassing any device-access"));
      assert.ok(!fallbackPrompt.includes("bypassing any device-access"));
      assert.ok(fallbackPrompt.includes("## Structured Tool Request Format"));

      // Dashboard HTML still renders valid JS with the new customAgentPrompt, editChatAgent, and 5h burst bar
      const html = renderDashboardHtml("/dashboard", "testnonce");
      assert.ok(html.includes("editAgentPromptBtn"));
      assert.ok(html.includes("cfgAutoEnsureCodingAgent"));
      assert.ok(html.includes("modalChatAgentInput"));
      assert.ok(html.includes("editChatAgent"));
      assert.ok(html.includes("5h Burst "));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enforces per-slot concurrency cap with bounded soft-wait, brief conn-limit backoff, elastic sticky affinity, and burst-aware quota scoring", async () => {
    const cfg = loadConfigFromEnv({
      QUICK_TOKENS: "ws.example.com|tok_slot_a,ws.example.com|tok_slot_b",
      KEY_COOLDOWN_MS: "30000",
      LB_STRATEGY: "quota-aware",
    });

    // 1) Bounded soft-wait & strict maxInflightPerSlot <= 4 on a single account
    const singlePool = new UpstreamKeyPool({
      ...cfg,
      quickTokens: ["ws.example.com|tok_only"],
      disabledQuickTokens: [],
      maxInflightPerSlot: 4,
    });

    let active = 0;
    let peak = 0;
    const worker = async () => {
      const lease = await singlePool.leaseKeyWithWait("claude-sonnet-4-6", undefined, undefined, { maxWaitMs: 500 });
      active += 1;
      if (active > peak) peak = active;
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      lease.release();
      return lease.slotId;
    };
    // 8 concurrent callers on 1 slot (cap 4): first 4 run immediately, next 4 wake on release & succeed
    const results = await Promise.all(Array.from({ length: 8 }, () => worker()));
    assert.equal(results.length, 8);
    assert.equal(peak, 4);

    // When all 4 slots are held and maxWaitMs expires, fast-fail with 429 rate_limit_exceeded
    const held = [
      singlePool.leaseKey("claude-sonnet-4-6"),
      singlePool.leaseKey("claude-sonnet-4-6"),
      singlePool.leaseKey("claude-sonnet-4-6"),
      singlePool.leaseKey("claude-sonnet-4-6"),
    ];
    await assert.rejects(
      () => singlePool.leaseKeyWithWait("claude-sonnet-4-6", undefined, undefined, { maxWaitMs: 35 }),
      (err: unknown) => err instanceof GatewayError && err.status === 429 && err.code === "rate_limit_exceeded",
    );
    for (const l of held) l.release();

    // 2) reportConnLimit uses brief non-escalating backoff (~2.5s) and preserves sticky affinity
    const multiPool = new UpstreamKeyPool({ ...cfg, maxInflightPerSlot: 4 });
    const kA = "ws.example.com|tok_slot_a";
    const kB = "ws.example.com|tok_slot_b";
    const stickyInitial = multiPool.leaseKey("quick-smart", undefined, "conv-sticky-1");
    stickyInitial.release();
    for (let i = 0; i < 5; i += 1) {
      multiPool.reportConnLimit(stickyInitial.apiKey, 1_500);
    }
    const snapAfterConnLimit = multiPool.statusSnapshot().find((s) => s.slotId === stickyInitial.slotId)!;
    assert.ok(snapAfterConnLimit.cooldownRemainingMs > 0 && snapAfterConnLimit.cooldownRemainingMs <= 1_600);
    assert.equal(snapAfterConnLimit.stickySessions, 1);

    // 3) Elastic sticky affinity: when sticky account reaches maxInflight (4), burst borrows idle account B
    const elasticPool = new UpstreamKeyPool({ ...cfg, maxInflightPerSlot: 4 });
    const l1 = elasticPool.leaseKey("quick-smart", undefined, "conv-elastic");
    const l2 = elasticPool.leaseKey("quick-smart", undefined, "conv-elastic");
    const l3 = elasticPool.leaseKey("quick-smart", undefined, "conv-elastic");
    const l4 = elasticPool.leaseKey("quick-smart", undefined, "conv-elastic");
    assert.equal(l1.apiKey, l2.apiKey);
    assert.equal(l1.apiKey, l3.apiKey);
    assert.equal(l1.apiKey, l4.apiKey);
    const l5 = elasticPool.leaseKey("quick-smart", undefined, "conv-elastic");
    assert.notEqual(l5.apiKey, l1.apiKey); // migrated to idle account!
    assert.equal(l5.viaAffinity, false);
    for (const l of [l1, l2, l3, l4, l5]) l.release();
    // Next turn stays on the migrated account (l5.apiKey) so it hits warm_incremental instead of bouncing back
    const lNext = elasticPool.leaseKey("quick-smart", undefined, "conv-elastic");
    assert.equal(lNext.apiKey, l5.apiKey);
    assert.equal(lNext.viaAffinity, true);
    lNext.release();

    // 4) quota-aware considers tighter of (monthly, 5h short-term burst) even for api/claude-* models
    const burstPool = new UpstreamKeyPool({ ...cfg, lbStrategy: "quota-aware", maxInflightPerSlot: 4 });
    const makeQuota = (monthlyRem: number, burstRem: number) => ({
      membershipType: "FREE_TRIAL",
      daysRemainingInCycle: 7,
      trialDaysRemaining: 28,
      overallIncludedPlan: { usedPercent: 100 - monthlyRem, remainingPercent: monthlyRem, allowanceUsd: null },
      sessionPool: { usedPercent: 100 - burstRem, remainingPercent: burstRem },
      premiumApiPool: { usedPercent: 100 - monthlyRem, remainingPercent: monthlyRem },
      onDemandSpend: { enabled: false, usedUsd: 0, limitUsd: null, remainingUsd: null },
    });
    // Account A: 80% monthly left, but only 5% burst left (95% used!)
    // Account B: 50% monthly left, 80% burst left (20% used) -> should win for claude-sonnet-4-6!
    burstPool.updateSlotQuotaCache(kA, undefined, makeQuota(80, 5));
    burstPool.updateSlotQuotaCache(kB, undefined, makeQuota(50, 80));
    const picked = burstPool.leaseKey("claude-sonnet-4-6");
    assert.equal(picked.apiKey, kB);
    picked.release();

    // 5) metadata.user_id is scoped per conversation (firstUserText) so separate windows & subagents rotate
    const { deriveConversationAffinityKey } = await import("../src/core/session-affinity.js");
    const convA1 = deriveConversationAffinityKey({
      headers: {},
      rawBody: { metadata: { user_id: "user_abc_account__session_111" } },
      firstUserText: "Help me refactor the auth middleware in server.ts",
    });
    const convA2 = deriveConversationAffinityKey({
      headers: {},
      rawBody: { metadata: { user_id: "user_abc_account__session_111" } },
      firstUserText: "Help me refactor the auth middleware in server.ts",
    });
    const convSubagent = deriveConversationAffinityKey({
      headers: {},
      rawBody: { metadata: { user_id: "user_abc_account__session_111" } },
      firstUserText: "Explore src/core/key-pool.ts and summarize its methods",
    });
    assert.equal(convA1, convA2);
    assert.notEqual(convA1, convSubagent);

    // 6) [P1-3] metadata.user_id ignores volatile systemPrompt on short prompts and strips <system-reminder>
    const shortSys1 = deriveConversationAffinityKey({
      headers: {},
      rawBody: { metadata: { user_id: "user_short_1" } },
      systemPrompt: "Active file: a.ts\nTools: Read",
      firstUserText: "<system-reminder>Dynamic date 12:00</system-reminder>\n继续",
    });
    const shortSys2 = deriveConversationAffinityKey({
      headers: {},
      rawBody: { metadata: { user_id: "user_short_1" } },
      systemPrompt: "Active file: b.ts\nTools: Read, Bash",
      firstUserText: "<system-reminder>Dynamic date 12:05</system-reminder>\n继续",
    });
    assert.equal(shortSys1, shortSys2);

    // 7) [P1-2] reportConnLimit migrates sticky affinity to the borrowed idle account when a turn arrives
    //    during brief cooldown so Turn N+1 hits warm_incremental on the new account (zero double cold-replay)
    const connStickyPool = new UpstreamKeyPool({ ...cfg, maxInflightPerSlot: 4 });
    const cs1 = connStickyPool.leaseKey("quick-smart", undefined, "conv-conn-sticky");
    cs1.release();
    connStickyPool.reportConnLimit(cs1.apiKey, 1_500);
    const duringBackoff = connStickyPool.leaseKey("quick-smart", undefined, "conv-conn-sticky");
    assert.notEqual(duringBackoff.apiKey, cs1.apiKey);
    duringBackoff.release();
    const migratedSnap = connStickyPool.statusSnapshot().find((s) => s.slotId === duringBackoff.slotId)!;
    assert.equal(migratedSnap.stickySessions, 1);

    // 8) [P0-5] reportQuotaExhausted on claude-* (api pool) auto-disables even if stale cached sessionPool > 0%
    const { computeKeySlotId } = await import("../src/core/key-pool.js");
    const stalePool = new UpstreamKeyPool({ ...cfg, autoDisableExhaustedKeys: true });
    stalePool.updateSlotQuotaCache(kA, undefined, makeQuota(60, 40));
    stalePool.reportQuotaExhausted(kA, "claude-sonnet-4-6", "AWS Quick account reached its usage limit");
    const staleSnapA = stalePool.statusSnapshot().find((s) => s.slotId === computeKeySlotId(kA))!;
    assert.equal(staleSnapA.enabled, false);
    assert.equal(staleSnapA.autoDisabledKind, "quota");

    // 9) [P0-3] allCoolingDown fallback never overflows a full slot
    const fullCoolPool = new UpstreamKeyPool({ ...cfg, maxInflightPerSlot: 2 });
    const fc1 = fullCoolPool.leaseSpecificKey(kA);
    const fc2 = fullCoolPool.leaseSpecificKey(kA);
    fullCoolPool.reportConnLimit(kA, 2_000);
    fullCoolPool.reportRateLimit(kB);
    const fcPicked = await fullCoolPool.leaseKeyWithWait("quick-smart", undefined, undefined, { maxWaitMs: 30 });
    assert.equal(fcPicked.apiKey, kB);
    fcPicked.release();
    fc1.release();
    fc2.release();

    // 10) [P1-1] notifySlotAvailable wakes a compatible waiter even if head waiter excludes the released slot
    const wakePool = new UpstreamKeyPool({ ...cfg, maxInflightPerSlot: 1 });
    const wA = wakePool.leaseSpecificKey(kA);
    const wB = wakePool.leaseSpecificKey(kB);
    const startMs = Date.now();
    const headExcludesA = wakePool.leaseKeyWithWait("quick-smart", new Set([kA]), undefined, { maxWaitMs: 250 })
      .catch(() => null);
    const tailAcceptsA = wakePool.leaseKeyWithWait("quick-smart", undefined, undefined, { maxWaitMs: 500 });
    setTimeout(() => wA.release(), 30);
    const tailLease = await tailAcceptsA;
    assert.equal(tailLease.apiKey, kA);
    assert.ok(Date.now() - startMs < 200);
    tailLease.release();
    wB.release();
    await headExcludesA;
  });

  it("handles Claude Code tool_reference blocks, assistant prefill, and required-param schema compaction", async () => {
    const { parseAnthropicMessagesRequest } = await import("../src/protocols/anthropic.js");
    const { buildToolBridgePrompt } = await import("../src/core/tool-bridge.js");

    // 1) tool_reference inside tool_result (Claude Code ToolSearch deferred MCP tools) must NOT throw 400
    const refTurn = parseAnthropicMessagesRequest({
      model: "quick-smart",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Start the preview server" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "ToolSearch", input: { query: "preview" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "tool_reference", tool_name: "mcp__Claude_Preview__preview_start" },
                { type: "text", text: "Loaded preview tool." },
              ],
            },
          ],
        },
      ],
    });
    assert.ok(refTurn.fullTranscriptText.includes("[TOOL_REFERENCE: mcp__Claude_Preview__preview_start]"));
    assert.ok(refTurn.trailingToolResults[0]?.content.includes("[TOOL_REFERENCE: mcp__Claude_Preview__preview_start]"));

    // 2) Trailing assistant prefill appends continuation cue without entering warm prefix cache
    const prefillTurn = parseAnthropicMessagesRequest({
      model: "quick-fast",
      max_tokens: 64,
      messages: [
        { role: "user", content: "Is `python3 -m http.server` safe? Reply inside <block>yes|no</block>." },
        { role: "assistant", content: "<block>" },
      ],
    });
    assert.ok(prefillTurn.fullTranscriptText.includes("[CONTINUE_ASSISTANT_PREFILL]"));
    assert.equal(prefillTurn.priorPrefixHash, undefined);

    // Normal user-ending turn must NOT get the prefill cue
    const normalTurn = parseAnthropicMessagesRequest({
      model: "quick-fast",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
    });
    assert.ok(!normalTurn.fullTranscriptText.includes("[CONTINUE_ASSISTANT_PREFILL]"));

    // 3) Tier-3 schema compaction (>28 KB after Tier-2, <=36 KB): keeps required param desc, strips optional param desc
    const bigTools = Array.from({ length: 65 }, (_, idx) => ({
      name: `mcp_preview_tool_${idx}`,
      description: `Detailed preview tool #${idx} description `.repeat(8),
      inputSchema: {
        type: "object",
        properties: {
          server_name: { type: "string", description: `REQ_MARKER_${idx}: preview server name in launch.json` },
          extra_opt: { type: "string", description: `OPT_MARKER_${idx}: optional verbose setting `.repeat(6) },
        },
        required: ["server_name"],
      },
    }));
    const bridged = buildToolBridgePrompt(bigTools, "auto", { compactForCustomAgent: true });
    assert.ok(bridged.includes("REQ_MARKER_0"), "required parameter description should be preserved in Tier 3");
    assert.ok(!bridged.includes("OPT_MARKER_0"), "optional parameter description should be stripped in Tier 3");
  });

  it("uses session.resume_in_minutes for 5h burst auto-recovery without prematurely reviving monthly-exhausted accounts", async () => {
    const { computeKeySlotId } = await import("../src/core/key-pool.js");
    const kBurst = "quick-oauth:eyJhY2Nlc3NUb2tlbiI6InRlc3QtYnVyc3QifQ==";
    const kMonthly = "quick-oauth:eyJhY2Nlc3NUb2tlbiI6InRlc3QtbW9udGhseSJ9";
    const pool = new UpstreamKeyPool({
      ...loadConfigFromEnv({
        QUICK_TOKENS: `${kBurst},${kMonthly}`,
        AUTO_DISABLE_EXHAUSTED_KEYS: "true",
      }),
    });

    const nextMonthIso = new Date(Date.now() + 15 * 86_400_000).toISOString();
    const shortResumeIso = new Date(Date.now() + 60).toISOString();

    // 1) Only 5h burst exhausted (monthly 50% left) -> auto-disables with short resumeAt (~60ms), NOT nextMonth
    pool.updateSlotQuotaCache(kBurst, undefined, {
      membershipType: "QUICK_LITE_FREE_TRIAL",
      billingCycleEnd: nextMonthIso,
      daysRemainingInCycle: 15,
      sessionPool: { usedPercent: 100, remainingPercent: 0, resumeInMinutes: 1, resumeAt: shortResumeIso },
      premiumApiPool: { usedPercent: 50, remainingPercent: 50 },
      overallIncludedPlan: { usedPercent: 50, remainingPercent: 50, allowanceUsd: null },
      onDemandSpend: { enabled: false, usedUsd: 0, limitUsd: null, remainingUsd: null },
    });
    const snapBurst = pool.statusSnapshot().find((s) => s.slotId === computeKeySlotId(kBurst))!;
    assert.equal(snapBurst.enabled, false);
    assert.equal(snapBurst.autoDisabledKind, "quota");
    assert.equal(snapBurst.autoRecoverAt, shortResumeIso);

    // 2) Monthly 100% exhausted even with short session resume -> MUST wait for billingCycleEnd (nextMonth)
    pool.updateSlotQuotaCache(kMonthly, undefined, {
      membershipType: "QUICK_LITE_FREE_TRIAL",
      billingCycleEnd: nextMonthIso,
      daysRemainingInCycle: 15,
      sessionPool: { usedPercent: 100, remainingPercent: 0, resumeInMinutes: 1, resumeAt: shortResumeIso },
      premiumApiPool: { usedPercent: 100, remainingPercent: 0 },
      overallIncludedPlan: { usedPercent: 100, remainingPercent: 0, allowanceUsd: null },
      onDemandSpend: { enabled: false, usedUsd: 0, limitUsd: null, remainingUsd: null },
    });
    const snapMonthly = pool.statusSnapshot().find((s) => s.slotId === computeKeySlotId(kMonthly))!;
    assert.equal(snapMonthly.enabled, false);
    assert.equal(snapMonthly.autoRecoverAt, nextMonthIso);

    // 3) Wait 80ms -> kBurst auto-recovers on its own, while kMonthly remains disabled!
    await new Promise((r) => setTimeout(r, 80));
    const snapAfter = pool.statusSnapshot();
    const afterBurst = snapAfter.find((s) => s.slotId === computeKeySlotId(kBurst))!;
    const afterMonthly = snapAfter.find((s) => s.slotId === computeKeySlotId(kMonthly))!;
    assert.equal(afterBurst.enabled, true);
    assert.equal(afterBurst.autoDisabledKind, undefined);
    assert.equal(afterBurst.autoRecoverAt, undefined);
    assert.equal(afterMonthly.enabled, false);

    // 4) Stale past resumeAt while still exhausted must NOT thrash-revive (falls back to billingCycleEnd)
    const pastIso = new Date(Date.now() - 5_000).toISOString();
    pool.updateSlotQuotaCache(kBurst, undefined, {
      membershipType: "QUICK_LITE_FREE_TRIAL",
      billingCycleEnd: nextMonthIso,
      daysRemainingInCycle: 15,
      sessionPool: { usedPercent: 100, remainingPercent: 0, resumeInMinutes: 0, resumeAt: pastIso },
      premiumApiPool: { usedPercent: 40, remainingPercent: 60 },
      overallIncludedPlan: { usedPercent: 40, remainingPercent: 60, allowanceUsd: null },
      onDemandSpend: { enabled: false, usedUsd: 0, limitUsd: null, remainingUsd: null },
    });
    const snapStale = pool.statusSnapshot().find((s) => s.slotId === computeKeySlotId(kBurst))!;
    assert.equal(snapStale.enabled, false);
    assert.ok(snapStale.autoRecoverAt && Date.parse(snapStale.autoRecoverAt) > Date.now() + 4 * 3600 * 1000);
  });

  it("hardens OpenAI protocol parsing/streaming, guardrail-safe prompt sanitization, and runtime quota on-trip recovery", async () => {
    const { parseResponsesRequest, parseChatCompletionsRequest, openAiChatAdapter } = await import("../src/protocols/openai.js");
    const { sanitizeClientSystemPromptForQuick } = await import("../src/core/tool-bridge.js");
    const { computeKeySlotId } = await import("../src/core/key-pool.js");

    // 1) Pure passthrough for plain chat (hasTools=false), and neutral fast-mode preference line in custom_prompt only
    const rawClaudeSys = "You are Claude Code, Anthropic's CLI. Be helpful.";
    assert.equal(sanitizeClientSystemPromptForQuick(rawClaudeSys, false), rawClaudeSys);
    const sanitizedFallback = sanitizeClientSystemPromptForQuick(rawClaudeSys, true);
    assert.ok(!sanitizedFallback.includes("You are Claude Code"));
    assert.ok(sanitizedFallback.includes("Be helpful."));
    const fastBridge = buildToolBridgePrompt(
      [{ name: "Read", description: "Read file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } }],
      "auto",
      { compactForCustomAgent: true, preferClientToolsOverWorkspace: true },
    );
    assert.ok(fastBridge.includes("Prefer the `<tool_call>` schemas above over built-in workspace tools."));
    const sonnetBridge = buildToolBridgePrompt(
      [{ name: "Read", description: "Read file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } }],
      "auto",
      { compactForCustomAgent: true, preferClientToolsOverWorkspace: false },
    );
    assert.ok(!sonnetBridge.includes("built-in workspace tools"));

    // 2) OpenAI /v1/responses unwraps single-turn user array input to plain text (no [USER]: prefix)
    const singleResp = parseResponsesRequest({
      model: "quick-smart",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello world" }] }],
    }, {});
    assert.equal(singleResp.fullTranscriptText, "Hello world");

    // System-only /v1/responses input promotes system message instead of empty prompt
    const sysOnlyResp = parseResponsesRequest({
      model: "quick-smart",
      input: [{ role: "developer", content: "Summarize this." }],
    }, {});
    assert.equal(sysOnlyResp.fullTranscriptText, "Summarize this.");

    // input_image object form { image_url: { url } } + object tool_calls.arguments
    const imgTurn = parseChatCompletionsRequest({
      model: "quick-smart",
      messages: [
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: { file_path: "/a.txt" } } }] },
        { role: "tool", tool_call_id: "c1", content: [{ type: "input_image", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
        { role: "user", content: "Describe the screenshot" },
      ],
    }, {});
    assert.ok(imgTurn.fullTranscriptText.includes('{"file_path":"/a.txt"}'));
    assert.ok(imgTurn.fullTranscriptText.includes("[Image]"));

    // OpenAI Chat SSE emits fallback finish_reason: "stop" if upstream generator ends without done
    async function* truncatedStream() {
      yield { type: "text" as const, text: "partial" };
    }
    const sseFrames: string[] = [];
    for await (const frame of openAiChatAdapter.streamSse(truncatedStream(), imgTurn)) {
      sseFrames.push(frame);
    }
    assert.ok(sseFrames.some((f) => f.includes('"finish_reason":"stop"')));
    assert.equal(sseFrames[sseFrames.length - 1], "data: [DONE]\n\n");

    // 3) reportQuotaExhausted sets provisional 5h autoResetAtMs, invokes debounced onQuotaExhausted probe,
    // and reviveCycleResetAccounts clears stale 0% quota & cooldowns
    const cfg = loadConfigFromEnv({
      QUICK_TOKENS: "ws.example.com|tok_runtime_trip",
      AUTO_DISABLE_EXHAUSTED_KEYS: "true",
    });
    const pool = new UpstreamKeyPool(cfg);
    const k = "ws.example.com|tok_runtime_trip";
    const probedSlots: string[] = [];
    pool.setOnQuotaExhausted((sid) => probedSlots.push(sid));
    pool.reportQuotaExhausted(k, "quick-smart", "AWS Quick account reached its usage limit");
    pool.reportQuotaExhausted(k, "quick-smart", "duplicate trip within debounce window");
    assert.equal(probedSlots.length, 1);
    assert.equal(probedSlots[0], computeKeySlotId(k));
    const trippedSnap = pool.statusSnapshot()[0]!;
    assert.equal(trippedSnap.enabled, false);
    assert.ok(trippedSnap.autoRecoverAt && Date.parse(trippedSnap.autoRecoverAt) > Date.now() + 4 * 3600 * 1000);

    // 4) Runtime quota-trip grace period: stale >0% usage-summary right after a live WS trip must NOT re-enable the slot,
    //    yet still refines autoResetAtMs when resumeInMinutes is present.
    pool.updateSlotQuotaCache(k, undefined, {
      membershipType: "QUICK_LITE_FREE_TRIAL",
      billingCycleEnd: new Date(Date.now() + 15 * 86400 * 1000).toISOString(),
      daysRemainingInCycle: 15,
      sessionPool: { usedPercent: 99, remainingPercent: 1, resumeInMinutes: 42 },
      premiumApiPool: { usedPercent: 50, remainingPercent: 50 },
      overallIncludedPlan: { usedPercent: 50, remainingPercent: 50, allowanceUsd: null },
      onDemandSpend: { enabled: false, usedUsd: 0, limitUsd: null, remainingUsd: null },
    });
    const graceSnap = pool.statusSnapshot()[0]!;
    assert.equal(graceSnap.enabled, false, "stale >0% usage-summary must not prematurely re-enable a just-tripped slot");
    assert.ok(
      graceSnap.autoRecoverAt && Date.parse(graceSnap.autoRecoverAt) < Date.now() + 60 * 60 * 1000,
      "resumeInMinutes should still refine provisional 5h autoResetAtMs to ~42m",
    );

    // 5) classifyUpstreamError: strict separation of rate-limit, proxy-407, OIDC invalid_grant vs slow_down, and quota
    const { classifyUpstreamError } = await import("../src/core/engine.js");
    const oidcErr = new GatewayError(
      'OIDC refresh_token failed (400): {"error":"invalid_grant","error_description":"Invalid refresh token provided"}',
      502,
      "upstream_error",
    );
    assert.equal(classifyUpstreamError(oidcErr).isAuthErr, true);

    // P2-5 + P1-1: OIDC permanent auth whitelist vs transient slow_down
    const oidcSlowDown = new GatewayError(
      'OIDC refresh_token failed (400): {"error":"slow_down"}',
      502,
      "upstream_error",
    );
    assert.equal(classifyUpstreamError(oidcSlowDown).isAuthErr, false);
    for (const code of ["invalid_client", "unauthorized_client", "expired_token", "access_denied"]) {
      const permErr = new GatewayError(`OIDC refresh_token failed (400): {"error":"${code}"}`, 502, "upstream_error");
      assert.equal(classifyUpstreamError(permErr).isAuthErr, true, `expected ${code} to classify as isAuthErr`);
    }

    // P1-C + P2-2: Ordinary "Rate limit exceeded" / retries exhausted != quota, while explicit quota messages ARE quota
    const rateLimitExceeded = new GatewayError("Rate limit exceeded (TooManyRequestsException)", 429, "upstream_error");
    assert.equal(classifyUpstreamError(rateLimitExceeded).isRateLimitErr, true);
    assert.equal(classifyUpstreamError(rateLimitExceeded).isQuotaErr, false);
    const retriesExhausted = new GatewayError("Upstream retries exhausted", 502, "upstream_error");
    assert.equal(classifyUpstreamError(retriesExhausted).isQuotaErr, false);
    assert.equal(classifyUpstreamError(new GatewayError("You have exceeded your quota", 502, "upstream_error")).isQuotaErr, true);
    assert.equal(classifyUpstreamError(new GatewayError("Monthly quota has been exhausted", 502, "upstream_error")).isQuotaErr, true);

    // P1-D: Proxy CONNECT 407 must classify as proxy error, NEVER permanent auth disable
    const proxy407 = new GatewayError("Proxy CONNECT failed (407 Proxy Authentication Required)", 502, "upstream_error");
    assert.equal(classifyUpstreamError(proxy407).isProxyOrConnErr, true);
    assert.equal(classifyUpstreamError(proxy407).isAuthErr, false);

    // P2-13: Default-agent fallback bridge contains zero anti-refusal / device phrasing
    const fallbackBridge = buildToolBridgePrompt(
      [{ name: "Read", description: "Read file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } }],
      "auto",
      { compactForCustomAgent: false },
    );
    assert.ok(!/missing local devices|declining/i.test(fallbackBridge));

    // Claude alias + prefix/suffix effort parsing in resolveModelSelection
    assert.equal(resolveModelSelection("claude-opus-5-5", {}).selection.agentMode, "smart");
    assert.equal(resolveModelSelection("claude-haiku-5-5", {}).selection.agentMode, "fast");
    assert.equal(resolveModelSelection("claude-sonnet-5-5", {}).selection.agentMode, "balanced");
    assert.deepEqual(resolveModelSelection("quick/claude-opus-5-5-high", {}).selection, {
      model: "quick-smart",
      agentMode: "smart",
      thinkingEffort: "high",
    });
    assert.deepEqual(resolveModelSelection("amazon-quick/quick-balanced(medium)", {}).selection, {
      model: "quick-balanced",
      agentMode: "balanced",
      thinkingEffort: "medium",
    });
    assert.deepEqual(resolveModelSelection("[aws]-quick-smart-thinking", {}).selection, {
      model: "quick-smart",
      agentMode: "smart",
      thinkingEffort: "high",
    });

    // resolveKnownModelId canonicalizes aliases/prefixes and rejects unknown models (prevents DISABLED_MODELS bypass & 404 on aliases)
    const { resolveKnownModelId } = await import("../src/services/model-catalog.js");
    assert.equal(resolveKnownModelId("quick/claude-opus-5-5-high"), "quick-smart");
    assert.equal(resolveKnownModelId("[aws]-quick-advanced"), "quick-advanced");
    assert.equal(resolveKnownModelId("amazon-quick/quick-balanced(medium)"), "quick-balanced");
    assert.equal(resolveKnownModelId("totally-unknown-model-999"), null);

    // Out-of-band attachment wrapper prompt keeps tail inline and stays well under 50KB single frame
    const { buildOutOfBandContextPrompt } = await import("../src/core/engine.js");
    const hugePrompt = `${"Earlier log line.\n".repeat(12_000)}FINAL_USER_QUESTION=Extract all needles`;
    const wrapped = buildOutOfBandContextPrompt(hugePrompt, "conversation_context_abc12345.txt");
    assert.ok(wrapped.includes("conversation_context_abc12345.txt"));
    assert.ok(wrapped.includes("FINAL_USER_QUESTION=Extract all needles"));
    assert.ok(Buffer.byteLength(wrapped, "utf8") < 6_000);
  });
});

describe(".env-seeded gateway keys: delete means revoke", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aq-keys-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const ENV_TOK = "sk-aq-0123456789abcdef0123456789abcdef";

  it("seeds an env token once, tags it `env`, and a console delete survives restart via a hashed tombstone", () => {
    withDir((dir) => {
      const a = new ClientGatewayKeyManager({ gatewayTokens: new Set([ENV_TOK]), dataDir: dir });
      const keys = a.listKeys();
      assert.equal(keys.length, 1);
      assert.equal(keys[0]!.source, "env");
      assert.equal(a.deleteKey(keys[0]!.id).source, "env");
      assert.equal(a.listKeys().length, 0);

      // Restart with the SAME .env token: must not come back.
      const b = new ClientGatewayKeyManager({ gatewayTokens: new Set([ENV_TOK]), dataDir: dir });
      assert.equal(b.listKeys().length, 0);
      assert.throws(() => b.authenticateClient(ENV_TOK));

      // Tombstone file holds only a SHA-256 digest, never the plaintext token.
      const tomb = readFileSync(path.join(dir, "env-key-tombstones.json"), "utf8");
      assert.ok(!tomb.includes(ENV_TOK));
      assert.match(tomb, /[a-f0-9]{64}/);

      // Rotating GATEWAY_TOKEN to a new value seeds the new key; the old one stays revoked.
      const NEW_TOK = "sk-aq-fedcba9876543210fedcba9876543210";
      const c = new ClientGatewayKeyManager({ gatewayTokens: new Set([NEW_TOK]), dataDir: dir });
      assert.equal(c.listKeys().length, 1);
      assert.doesNotThrow(() => c.authenticateClient(NEW_TOK));
      assert.throws(() => c.authenticateClient(ENV_TOK));
    });
  });

  it("removes an env-sourced key when its token leaves .env, but never touches console-created keys", () => {
    withDir((dir) => {
      const a = new ClientGatewayKeyManager({ gatewayTokens: new Set([ENV_TOK]), dataDir: dir });
      const created = a.createKey({ name: "console-key" });
      assert.equal(created.view.source, "dashboard");
      a.flushStatsToDisk();

      const b = new ClientGatewayKeyManager({ gatewayTokens: new Set(), dataDir: dir });
      assert.deepEqual(b.listKeys().map((k) => k.name), ["console-key"]);
      assert.ok(b.startupEvents.some((e) => e.event === "gateway_env_key_pruned"));
      assert.doesNotThrow(() => b.authenticateClient(created.rawToken));
      assert.throws(() => b.authenticateClient(ENV_TOK));
    });
  });

  it("disabled env keys stay disabled across restarts, and re-creating a deleted env token in the console is an explicit re-add", () => {
    withDir((dir) => {
      const a = new ClientGatewayKeyManager({ gatewayTokens: new Set([ENV_TOK]), dataDir: dir });
      const id = a.listKeys()[0]!.id;
      a.updateKey(id, { enabled: false });
      const b = new ClientGatewayKeyManager({ gatewayTokens: new Set([ENV_TOK]), dataDir: dir });
      assert.equal(b.listKeys().length, 1);
      assert.equal(b.listKeys()[0]!.enabled, false);

      b.deleteKey(id);
      const readded = b.createKey({ name: "readded", customToken: ENV_TOK });
      assert.equal(readded.view.source, "dashboard");
      const c = new ClientGatewayKeyManager({ gatewayTokens: new Set([ENV_TOK]), dataDir: dir });
      assert.deepEqual(c.listKeys().map((k) => k.name), ["readded"]);
    });
  });

  it("upgrades legacy gateway-keys.json (no `source`) without losing keys", () => {
    withDir((dir) => {
      const legacy = [
        { id: "gk_aaaaaaaaaaaaaaaa", name: "friend", token: "sk-aq-friend-token-1234567890", enabled: true, allowAllModels: true, allowedModels: [], maxRequests: null, maxConcurrent: null, expiresAt: null, createdAt: "2026-11-01T00:00:00.000Z", stats: { requests: 3, inputTokens: 1, outputTokens: 1 } },
        { id: "gk_bbbbbbbb", name: "Env Key #1", token: ENV_TOK, enabled: true, allowAllModels: true, allowedModels: [], maxRequests: null, maxConcurrent: null, expiresAt: null, createdAt: "2026-11-01T00:00:00.000Z", stats: { requests: 5, inputTokens: 2, outputTokens: 2 } },
      ];
      writeFileSync(path.join(dir, "gateway-keys.json"), JSON.stringify(legacy));
      const m = new ClientGatewayKeyManager({ gatewayTokens: new Set([ENV_TOK]), dataDir: dir });
      const bySource = Object.fromEntries(m.listKeys().map((k) => [k.name, k.source]));
      assert.deepEqual(bySource, { friend: "dashboard", "Env Key #1": "env" });
      assert.equal(m.listKeys().find((k) => k.name === "friend")!.stats.requests, 3);
      // Persisted file stays an array so a rollback to the previous release can still read it.
      assert.ok(Array.isArray(JSON.parse(readFileSync(path.join(dir, "gateway-keys.json"), "utf8"))));
    });
  });

  it("rejects documented placeholder secrets at startup but accepts real ones", () => {
    assert.equal(findInsecurePlaceholderConfig({ gatewayTokens: new Set(["sk-aq-change-me"]), adminPassword: undefined }).length, 1);
    assert.equal(findInsecurePlaceholderConfig({ gatewayTokens: new Set(), adminPassword: "change-this-admin-password" }).length, 1);
    assert.equal(findInsecurePlaceholderConfig({ gatewayTokens: new Set(["sk-aq-change-me"]), adminPassword: "<set-a-strong-password>" }).length, 2);
    assert.deepEqual(findInsecurePlaceholderConfig({ gatewayTokens: new Set([ENV_TOK]), adminPassword: "Zq7!v9Lx2#pRm4Tw" }), []);
    assert.deepEqual(findInsecurePlaceholderConfig({ gatewayTokens: new Set(), adminPassword: undefined }), []);
  });
});

describe("Security hardening regressions (SSRF, CBOR/EventStream, wsHost, redaction, model normalization)", () => {
  it("blocks all IPv6 SSRF encodings including hex IPv4-mapped, NAT64, 6to4, Teredo, and expanded loopback", async () => {
    const blockedIps = [
      "::ffff:7f00:1",
      "::ffff:127.0.0.1",
      "::ffff:a9fe:a9fe",
      "0:0:0:0:0:0:0:1",
      "0000:0000:0000:0000:0000:ffff:7f00:0001",
      "::7f00:1",
      "64:ff9b::127.0.0.1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "2002:a9fe:a9fe::",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "fe80::1",
      "fc00::1",
    ];
    for (const ip of blockedIps) {
      assert.equal(isPrivateOrReservedIp(ip), true, `Expected ${ip} to be blocked`);
    }
    assert.equal(isPrivateOrReservedIp("1.1.1.1"), false);
    assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false);

    await assert.rejects(() => assertSafeRemoteImageUrl("http://[::ffff:127.0.0.1]/a.png"), /ssrf_blocked|Blocked/i);
    await assert.rejects(() => assertSafeRemoteImageUrl("http://[::ffff:169.254.169.254]/latest/meta-data/"), /ssrf_blocked|Blocked/i);
    await assert.rejects(() => assertSafeRemoteImageUrl("http://[0:0:0:0:0:0:0:1]/a.png"), /ssrf_blocked|Blocked/i);
    await assert.rejects(() => assertSafeRemoteImageUrl("http://[64:ff9b::127.0.0.1]/a.png"), /ssrf_blocked|Blocked/i);
  });

  it("hardens CBOR and EventStream decoders against OOM, deep recursion, prototype pollution, and bad headersLen", () => {
    // 4-billion-element CBOR array header with 0 payload bytes
    assert.throws(() => cborDecode(new Uint8Array([0x9a, 0xff, 0xff, 0xff, 0xff])), /out of bounds/i);

    // 40-level nested CBOR arrays exceed MAX_CBOR_DEPTH (32)
    const deep = new Uint8Array(41);
    deep.fill(0x81, 0, 40);
    deep[40] = 0x01;
    assert.throws(() => cborDecode(deep), /depth exceeds limit/i);

    // Prototype pollution via __proto__ key is stripped safely
    const encodedMap = cborEncode({ __proto__: { polluted: true }, safe: "ok" } as Record<string, unknown>);
    // Manually craft CBOR map with explicit "__proto__" key: a2 69 "__proto__" a1 61 "x" 01 62 "ok" 01
    const manualProtoMap = new Uint8Array([
      0xa2,
      0x69, ...Buffer.from("__proto__"),
      0xa1, 0x61, 0x78, 0x01,
      0x62, 0x6f, 0x6b, 0x01,
    ]);
    assert.ok(encodedMap.length > 0);
    const decoded = cborDecode(manualProtoMap) as Record<string, unknown>;
    assert.equal(decoded.ok, 1);
    assert.equal(({} as Record<string, unknown>).x, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(decoded, "__proto__"), false);

    // EventStream frame where headersLen > totalLen - 16
    const badFrame = new Uint8Array(20);
    const dv = new DataView(badFrame.buffer);
    dv.setUint32(0, 20, false);
    dv.setUint32(4, 12, false); // > 20 - 16 = 4
    assert.throws(() => drainEventStream(badFrame, 0), /Invalid EventStream frame dimensions/i);
  });

  it("enforces AWS Quick domain allowlist on wsHost", () => {
    assert.equal(assertSafeWsHost("api.us-east-1.quick.aws.com"), "api.us-east-1.quick.aws.com");
    assert.equal(assertSafeWsHost("chat.quick.aws.dev"), "chat.quick.aws.dev");
    assert.equal(assertSafeWsHost("us-east-1.quicksight.aws.amazon.com"), "us-east-1.quicksight.aws.amazon.com");

    assert.throws(() => assertSafeWsHost("evil.com"), /untrusted/i);
    assert.throws(() => assertSafeWsHost("evil.s3.amazonaws.com"), /untrusted/i);
    assert.throws(() => assertSafeWsHost("127.0.0.1"), /untrusted/i);
    assert.throws(() => assertSafeWsHost("quick.aws.com.evil.com"), /untrusted/i);
    assert.throws(() => assertSafeWsHost("chat.quick.aws.dev:8443/path"), /untrusted/i);
  });

  it("normalizes prefixed models consistently, redacts all secret formats, and rejects commas in addKey", async () => {
    const { normalizeBaseModelId, redactSecrets } = await import("../src/utils/hash.js");
    assert.equal(normalizeBaseModelId("[aws]-quick-advanced"), "quick-advanced");
    assert.equal(normalizeBaseModelId("quick/quick-smart[effort=high]"), "quick-smart");
    assert.equal(normalizeBaseModelId("amazon-quick/quick-balanced(medium)"), "quick-balanced");

    const fakeHttpProxy = ["http://", "alice", ":", "s3cr3t", "@", "1.2.3.4:8080"].join("");
    const fakeSocksProxy = ["socks5://", "bob", ":", "pw", "@", "5.6.7.8:1080"].join("");
    const dirty =
      `oauth:eyJyZWZyZXNoVG9rZW4iOiJzZWNyZXQifQ== web:123456|mbtc_secret|cookie=xyz aoa123456789012345678901234 ${fakeHttpProxy} ${fakeSocksProxy}`;
    const clean = redactSecrets(dirty);
    assert.ok(!clean.includes("eyJyZWZyZXNo"));
    assert.ok(!clean.includes("mbtc_secret"));
    assert.ok(!clean.includes("aoa1234567890"));
    assert.ok(!clean.includes("alice:s3cr3t"));
    assert.ok(!clean.includes("bob:pw"));
    assert.ok(clean.includes("oauth:[REDACTED]"));
    assert.ok(clean.includes("web:[REDACTED]"));
    assert.ok(clean.includes("aoa[REDACTED]"));
    assert.ok(clean.includes("http://***:***@1.2.3.4:8080"));
    assert.ok(clean.includes("socks5://***:***@5.6.7.8:1080"));

    const pool = new UpstreamKeyPool({
      quickTokens: [],
      disabledQuickTokens: [],
      keyLabels: {},
      keyProxies: {},
      keyAddedAt: {},
      keyAutoDisabled: {},
      keyCooldownMs: 1000,
      lbStrategy: "round-robin",
      sessionAffinityEnabled: false,
      sessionAffinityTtlMs: 60_000,
      autoDisableExhaustedKeys: false,
      incognitoMode: true,
    });
    assert.throws(() => pool.addKey("tok_abc,tok_def"), /commas\/newlines are not allowed/i);
  });

  it("evaluates DLP poll states strictly and decouples 5xx transient backoff from 429 rate-limit penalties", () => {
    assert.deepEqual(evaluateDlpPollResponse({ dlpJobStatus: "COMPLETED", policyAction: "ALLOW" }), { state: "ready" });
    assert.deepEqual(evaluateDlpPollResponse({ dlpJobStatus: "COMPLETED", policyAction: "WARN" }), { state: "ready" });
    assert.deepEqual(evaluateDlpPollResponse({ status: "SKIPPED" }), { state: "ready" });
    assert.deepEqual(evaluateDlpPollResponse({ dlpJobStatus: "IN_PROGRESS" }), { state: "pending" });
    assert.equal(evaluateDlpPollResponse({ dlpJobStatus: "COMPLETED", policyAction: "BLOCK" }).state, "failed");
    assert.equal(evaluateDlpPollResponse({ dlpJobStatus: "FAILED" }).state, "failed");
    assert.equal(evaluateDlpPollResponse({ status: "ERROR" }).state, "failed");

    const pool = new UpstreamKeyPool({
      quickTokens: ["ws.example.com|tok_alpha", "ws.example.com|tok_beta"],
      disabledQuickTokens: [],
      keyLabels: {},
      keyProxies: {},
      keyAddedAt: {},
      keyAutoDisabled: {},
      keyCooldownMs: 30_000,
      lbStrategy: "round-robin",
      sessionAffinityEnabled: true,
      sessionAffinityTtlMs: 60_000,
      autoDisableExhaustedKeys: false,
      incognitoMode: true,
    });

    const leaseA = pool.leaseKey("quick-smart", undefined, "conv-transient-test");
    leaseA.release();

    // 502/503 transient hiccup: short jittered backoff (<6s), does NOT increment rateLimits or wipe sticky affinity
    pool.reportTransientError(leaseA.apiKey, 2_500);
    pool.reportTransientError(leaseA.apiKey, 2_500);
    const snapAfterTransient = pool.statusSnapshot().find((s) => s.slotId === leaseA.slotId)!;
    assert.equal(snapAfterTransient.rateLimitHits, 0);
    assert.ok(snapAfterTransient.cooldownRemainingMs > 0 && snapAfterTransient.cooldownRemainingMs <= 6_000);
    assert.equal(snapAfterTransient.stickySessions, 1);

    // Real 429 with Retry-After: honors 12s Retry-After, increments rateLimitHits, and evicts sticky sessions
    pool.reportRateLimit(leaseA.apiKey, 12_000);
    const snapAfter429 = pool.statusSnapshot().find((s) => s.slotId === leaseA.slotId)!;
    assert.equal(snapAfter429.rateLimitHits, 1);
    assert.ok(snapAfter429.cooldownRemainingMs >= 10_000 && snapAfter429.cooldownRemainingMs <= 12_500);
    assert.equal(snapAfter429.stickySessions, 0);
  });

  it("covers P0/P1 audit regressions: domain pinnedHttpGet (Node >=20 all:true), auto/default model gate, quota classifier, >4KB system-reminder affinity, loopback headers, and placeholder regex", async () => {
    // P0-1: pinnedHttpGet works with domain hostnames under Node >=20 autoSelectFamily ({ all: true })
    const imgServer = http.createServer((req, res) => {
      assert.ok(String(req.headers.host || "").startsWith("img.example.test:"));
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    await new Promise<void>((r) => imgServer.listen(0, "127.0.0.1", r));
    try {
      const port = (imgServer.address() as net.AddressInfo).port;
      const got = await pinnedHttpGet(new URL(`http://img.example.test:${port}/a.png`), "127.0.0.1", 4);
      assert.equal(got.status, 200);
      assert.equal(got.buf.byteLength, 4);
    } finally {
      imgServer.close();
    }

    // P1-1: auto / default resolve to quick-balanced so DISABLED_MODELS=quick-balanced cannot be bypassed
    const { resolveKnownModelId } = await import("../src/services/model-catalog.js");
    assert.equal(resolveKnownModelId("auto"), "quick-balanced");
    assert.equal(resolveKnownModelId("default"), "quick-balanced");
    assert.equal(resolveKnownModelId("quick/auto"), "quick-balanced");
    assert.equal(resolveKnownModelId("auto[effort=high]"), "quick-balanced");

    // P1-2 & P2: quota errors beat generic 429; rate limit stays rate limit; SOCKS5 auth stays proxy error
    assert.equal(classifyUpstreamError(new GatewayError("QuotaExceededException: monthly limit exceeded", 429, "upstream_error")).isQuotaErr, true);
    assert.equal(classifyUpstreamError(new GatewayError("You exceeded your current quota", 429, "upstream_error")).isQuotaErr, true);
    assert.equal(classifyUpstreamError(new GatewayError("quota exhausted", 502, "upstream_error")).isQuotaErr, true);
    const rateOnly = classifyUpstreamError(new GatewayError("Rate limit exceeded", 429, "rate_limit_exceeded"));
    assert.equal(rateOnly.isRateLimitErr, true);
    assert.equal(rateOnly.isQuotaErr, false);
    const socksAuth = classifyUpstreamError(new GatewayError("SOCKS5 username/password authentication failed (0x1)", 502, "upstream_error"));
    assert.equal(socksAuth.isProxyOrConnErr, true);
    assert.equal(socksAuth.isAuthErr, false);

    // P1-5: >4KB <system-reminder> prefix is stripped cleanly so parallel subagents get distinct affinity keys
    const { deriveConversationAffinityKey } = await import("../src/core/session-affinity.js");
    const bigReminder = `<system-reminder>${"CLAUDE.md instruction line.\n".repeat(300)}</system-reminder>\n`;
    const key1 = deriveConversationAffinityKey({
      headers: {},
      rawBody: { metadata: { user_id: "user_123" } },
      firstUserText: `${bigReminder}Subagent task Alpha`,
    });
    const key2 = deriveConversationAffinityKey({
      headers: {},
      rawBody: { metadata: { user_id: "user_123" } },
      firstUserText: `${bigReminder}Subagent task Beta`,
    });
    assert.notEqual(key1, key2);

    // P1-7: placeholder regex catches .env.example literals like sk-aq-<generate-your-own>
    assert.equal(findInsecurePlaceholderConfig({ gatewayTokens: new Set(["sk-aq-<generate-your-own>"]), adminPassword: undefined }).length, 1);

    // P1-8: isDirectLoopbackRequest rejects CF/Forwarded headers and non-loopback Host
    const { isDirectLoopbackRequest } = await import("../src/web/admin-auth.js");
    const fakeReq = (headers: Record<string, string>, remoteAddress = "127.0.0.1") =>
      ({ headers, socket: { remoteAddress } }) as unknown as http.IncomingMessage;
    assert.equal(isDirectLoopbackRequest(fakeReq({ host: "127.0.0.1:3456" })), true);
    assert.equal(isDirectLoopbackRequest(fakeReq({ host: "127.0.0.1:3456", "cf-connecting-ip": "1.2.3.4" })), false);
    assert.equal(isDirectLoopbackRequest(fakeReq({ host: "127.0.0.1:3456", forwarded: "for=1.2.3.4" })), false);
    assert.equal(isDirectLoopbackRequest(fakeReq({ host: "public.example.com" })), false);

    // P2: redactSecrets handles passwords containing `@`
    const { redactSecrets } = await import("../src/utils/hash.js");
    const fakeAtProxy = ["http://", "user", ":", "p@ss", "@", "1.2.3.4:8080"].join("");
    assert.equal(redactSecrets(fakeAtProxy), "http://***:***@1.2.3.4:8080");

    // Multimodal budget guard: 9 images stay safely under AWS Quick's 50KB single-frame limit
    const sharpMod = (await import("sharp")).default;
    const samplePng = await sharpMod({ create: { width: 200, height: 200, channels: 3, background: { r: 80, g: 140, b: 220 } } }).png().toBuffer();
    const nineImages = Array.from({ length: 9 }, () => ({ mimeType: "image/png", data: samplePng.toString("base64") }));
    const builtNine = await buildQuickImageAttachments(nineImages, undefined, 34_000);
    assert.equal(builtNine.length, 9);
    const totalJsonBytes = Buffer.byteLength(JSON.stringify(builtNine), "utf8");
    assert.ok(totalJsonBytes < 46_000, `Expected 9 images JSON (${totalJsonBytes}B) to fit under 46KB`);

    // Native thinking_effort="max" passthrough
    assert.equal(resolveModelSelection("quick-smart-max", {}).selection.thinkingEffort, "max");
    assert.equal(resolveModelSelection("quick-smart[effort=max]", {}).selection.thinkingEffort, "max");
    assert.equal(resolveModelSelection("quick-balanced(xhigh)", {}).selection.thinkingEffort, "max");
    assert.equal(resolveModelSelection("quick-smart-think", { reasoning_effort: "max" }).selection.thinkingEffort, "max");
    assert.equal(resolveModelSelection("quick-smart", { reasoning: { effort: "max" } }).selection.thinkingEffort, "max");
    assert.equal(resolveModelSelection("quick-fast", { reasoning_effort: "max" }).selection.thinkingEffort, "off");
    assert.equal(resolveKnownModelId("quick-smart-max"), "quick-smart");
  });

  it("parses PDF/document/file blocks across all 3 protocols, isolates incremental files, and uploads binary attachments cleanly", async () => {
    const { estimateAnthropicTokens, parseAnthropicMessagesRequest } = await import("../src/protocols/anthropic.js");
    const { parseChatCompletionsRequest, parseResponsesRequest } = await import("../src/protocols/openai.js");
    const { uploadOAuthBinaryAttachment } = await import("../src/aws-quick/oauth-client.js");
    const { fetchViaOptionalProxy } = await import("../src/utils/proxy-agent.js");

    const fakePdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n", "utf8");
    const pdfB64 = fakePdf.toString("base64");

    // 1. Anthropic `document` (base64 PDF + text + token estimation)
    const anthBody = {
      model: "quick-smart",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
            { type: "document", title: "notes.txt", source: { type: "text", data: "hello plain doc" } },
            { type: "text", text: "Summarize spec.pdf" },
          ],
        },
      ],
    };
    const anthTurn = parseAnthropicMessagesRequest(anthBody);
    assert.equal(anthTurn.files?.length, 1);
    assert.equal(anthTurn.files?.[0]?.filename, "spec.pdf");
    assert.equal(anthTurn.files?.[0]?.mimeType, "application/pdf");
    assert.equal(anthTurn.files?.[0]?.data, pdfB64);
    assert.ok(anthTurn.fullTranscriptText.includes("hello plain doc"));
    assert.ok(estimateAnthropicTokens({ ...anthBody, messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "A".repeat(100_000) } }] }] }) < 2_000);

    // 2. OpenAI Chat `file` + OpenAI Responses `input_file` + `file_id` rejection
    const oaiTurn = parseChatCompletionsRequest({
      model: "quick-balanced",
      messages: [
        {
          role: "user",
          content: [
            { type: "file", file: { filename: "report.pdf", file_data: `data:application/pdf;base64,${pdfB64}` } },
            { type: "text", text: "Check report" },
          ],
        },
      ],
    });
    assert.equal(oaiTurn.files?.length, 1);
    assert.equal(oaiTurn.files?.[0]?.filename, "report.pdf");
    assert.equal(oaiTurn.files?.[0]?.mimeType, "application/pdf");

    const respTurn = parseResponsesRequest({
      model: "quick-balanced",
      input: [
        {
          role: "user",
          content: [
            { type: "input_file", filename: "remote.pdf", file_url: "https://example.com/remote.pdf" },
            { type: "input_text", text: "Inspect remote.pdf" },
          ],
        },
      ],
    });
    assert.equal(respTurn.files?.length, 1);
    assert.equal(respTurn.files?.[0]?.url, "https://example.com/remote.pdf");

    assert.throws(
      () => parseResponsesRequest({
        model: "quick-balanced",
        input: [{ role: "user", content: [{ type: "input_file", file_id: "file-abc123" }] }],
      }),
      /file_id/,
    );

    // 3. Binary attachment upload pipeline (preserves exact bytes & mimeType)
    const origFetch = globalThis.fetch;
    const binaryPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    let uploadedBytes: Buffer | undefined;
    let uploadedQuery = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("upload-attachment")) {
        uploadedQuery = new URL(u).search;
        uploadedBytes = Buffer.isBuffer(init?.body) ? init.body : Buffer.from(init?.body as Uint8Array);
        return new Response(JSON.stringify({ attachmentId: "att-bin-1" }), { status: 200 });
      }
      if (u.includes("attachment-dlp-status")) {
        return new Response(JSON.stringify({ dlpJobStatus: "COMPLETED", policyAction: "ALLOW" }), { status: 200 });
      }
      if (u.includes("qbs-event")) {
        return new Response(JSON.stringify({ eventResponse: { invokeAgentResponse: JSON.stringify({ body: JSON.stringify({ path: "/workspace/user_image_001.png" }) }) } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${u}`);
    }) as typeof fetch;

    try {
      const att = await uploadOAuthBinaryAttachment(
        {
          clientId: "cid-1",
          clientSecret: "csec-1",
          refreshToken: "rt-1",
          accessToken: "at-1",
          expiresAt: Date.now() + 3600_000,
          wsHost: "chat.quick.aws.com",
          region: "us-east-1",
          issuerUrl: "https://oidc.us-east-1.amazonaws.com",
        },
        "thread-123",
        "user_image_001.png",
        binaryPayload,
        "image/png",
      );
      assert.equal(att.type, "image");
      assert.equal(att.size, binaryPayload.byteLength);
      assert.equal(att.mimeType, "image/png");
      assert.equal(att.path, "/workspace/user_image_001.png");
      assert.ok(uploadedQuery.includes("contentType=image%2Fpng"));
      assert.ok(uploadedBytes && Buffer.compare(uploadedBytes, binaryPayload) === 0);

      // Direct fetchViaOptionalProxy binary Buffer passthrough check
      const proxyRes = await fetchViaOptionalProxy(
        "https://chat.quick.aws.com/integration/quick-work/upload-attachment",
        { method: "POST", body: binaryPayload },
      );
      assert.equal(proxyRes.ok, true);
    } finally {
      globalThis.fetch = origFetch;
    }

    // 4. Responses single-file placeholder, tool-result incrementalFiles, and upload error classification
    const respFileOnly = parseResponsesRequest({
      model: "quick-balanced",
      input: [{ role: "user", content: [{ type: "input_file", filename: "only.pdf", file_data: pdfB64 }] }],
    });
    assert.equal(respFileOnly.fullTranscriptText, "[File: only.pdf]");

    const chatToolFile = parseChatCompletionsRequest({
      model: "quick-balanced",
      messages: [
        { role: "user", content: "Run tool" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "fetch_doc", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: [{ type: "file", file: { filename: "tool_out.pdf", file_data: pdfB64 } }] },
      ],
    });
    assert.equal(chatToolFile.incrementalFiles?.length, 1);
    assert.equal(chatToolFile.incrementalFiles?.[0]?.filename, "tool_out.pdf");

    const respToolFile = parseResponsesRequest({
      model: "quick-balanced",
      input: [
        { role: "user", content: "Run tool" },
        { type: "function_call", call_id: "c1", name: "fetch_doc", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: [{ type: "input_file", filename: "resp_tool.pdf", file_data: pdfB64 }] },
      ],
    });
    assert.equal(respToolFile.incrementalFiles?.length, 1);
    assert.equal(respToolFile.incrementalFiles?.[0]?.filename, "resp_tool.pdf");

    const { classifyUpstreamError, mapAttachmentUploadError } = await import("../src/core/engine.js");
    const err429 = mapAttachmentUploadError(new Error("upload-attachment failed (429)"), "Upload failed");
    assert.equal(err429.status, 429);
    assert.equal(classifyUpstreamError(err429).isRateLimitErr, true);
    const err401 = mapAttachmentUploadError(new Error("attachment-dlp-status failed (401)"), "Upload failed");
    assert.equal(err401.status, 401);
    assert.equal(classifyUpstreamError(err401).isAuthErr, true);
    const errOidcGrant = mapAttachmentUploadError(new Error('OIDC refresh_token failed (400): {"error":"invalid_grant"}'), "Upload failed");
    assert.equal(classifyUpstreamError(errOidcGrant).isAuthErr, true);
    const errDlp = mapAttachmentUploadError(new Error("Attachment blocked by AWS Quick DLP policy (BLOCK)."), "Upload failed");
    assert.equal(errDlp.status, 400);
    assert.equal(errDlp.code, "content_filtered");
    const err400 = mapAttachmentUploadError(new Error("upload-attachment failed (400)"), "Upload failed");
    assert.equal(err400.status, 400);
    assert.equal(classifyUpstreamError(err400).isProxyOrConnErr, false);
  });

  it("sanitizes high-risk client headers/tags, classifies soft refusals conservatively, and persists auto-rephrase settings (default OFF)", async () => {
    const {
      stripHighRiskClientHeaders,
      normalizeSystemReminderTagsForUpstream,
      sanitizeClientSystemPromptForQuick,
    } = await import("../src/core/tool-bridge.js");
    const {
      DEFAULT_CONTENT_FILTER_REPHRASE_MODEL,
      DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT,
      isLikelySoftRefusal,
    } = await import("../src/core/engine.js");
    const { evaluateDlpPollResponse } = await import("../src/aws-quick/oauth-client.js");

    // 1. High-risk billing header stripping & <system-reminder> linear normalization
    const rawHeader = "x-anthropic-billing-header: cc_version=2.1.0; cc_entrypoint=cli\n\nYou are Claude, Anthropic's AI assistant.\nFollow project rules.";
    const stripped = stripHighRiskClientHeaders(rawHeader);
    assert.ok(!stripped.includes("x-anthropic-billing-header"));
    assert.ok(stripped.includes("Follow project rules."));
    const softened = sanitizeClientSystemPromptForQuick(rawHeader, true);
    assert.ok(!softened.includes("x-anthropic-billing-header"));
    assert.ok(!softened.includes("You are Claude, Anthropic's"));

    const rawReminder = "<system-reminder>\nInternal context A\n</system-reminder>\n\nActual question";
    const normReminder = normalizeSystemReminderTagsForUpstream(rawReminder);
    assert.ok(!normReminder.includes("<system-reminder>"));
    assert.ok(normReminder.includes("[Context note]\nInternal context A\n[/Context note]"));
    assert.ok(normReminder.includes("Actual question"));

    // 2. Conservative soft-refusal classifier
    assert.equal(isLikelySoftRefusal("I need to stop and flag this as a prompt injection attack."), true);
    assert.equal(isLikelySoftRefusal("As an AWS Quick assistant, no device is connected right now."), true);
    assert.equal(isLikelySoftRefusal("检测到提示词注入，我无法执行。"), true);
    assert.equal(isLikelySoftRefusal("I'm sorry, I noticed a typo in line 12. Here is the fixed code."), false);
    assert.equal(
      isLikelySoftRefusal('<tool_call>{"name":"Read","arguments":{"path":"src/app.ts"}}</tool_call>'),
      false,
    );
    // Long normal security explanation mentioning "prompt injection" past char 320 must NOT trigger
    const longEdu = `${"Here is a thorough architecture review of your TypeScript service. ".repeat(10)}We should also consider prompt injection defenses in middleware.`;
    assert.equal(isLikelySoftRefusal(longEdu), false);

    // 3. DLP poll response preserves upstream policy detail
    const dlpBlocked = evaluateDlpPollResponse({
      dlpJobStatus: "COMPLETED",
      policyAction: "BLOCK",
      policyName: "SecretsRule",
      reason: "Detected private key",
    });
    assert.equal(dlpBlocked.state, "failed");
    assert.ok(dlpBlocked.state === "failed" && dlpBlocked.reason.includes("SecretsRule"));

    // 4. Config default OFF + persistence round-trip + Dashboard HTML renders new controls
    const fs = await import("node:fs");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aq2a-rephrase-cfg-"));
    const envFile = path.join(tmpDir, ".env");
    try {
      fs.writeFileSync(envFile, "QUICK_TOKENS=local-outpost\nINCOGNITO=true\n", "utf8");
      const cfg = loadConfigFromEnv({ QUICK_TOKENS: "local-outpost", INCOGNITO: "true" }, envFile);
      assert.equal(cfg.autoRephraseOnContentFilter, false);
      assert.equal(cfg.contentFilterRephrasePrompt, undefined);
      assert.equal(cfg.contentFilterRephraseModel, DEFAULT_CONTENT_FILTER_REPHRASE_MODEL);
      assert.ok(DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT.includes("content moderation"));
      assert.ok(DEFAULT_CONTENT_FILTER_REPHRASE_PROMPT.includes("neutral"));

      const pool = new UpstreamKeyPool(cfg);
      assert.equal(pool.getSettings().autoRephraseOnContentFilter, false);
      pool.updateSettings({
        autoRephraseOnContentFilter: true,
        contentFilterRephrasePrompt: "Rule 1\nRule 2",
        contentFilterRephraseModel: "quick-balanced",
      });
      assert.equal(pool.getSettings().autoRephraseOnContentFilter, true);
      assert.equal(pool.getSettings().contentFilterRephrasePrompt, "Rule 1\nRule 2");
      assert.equal(pool.getSettings().contentFilterRephraseModel, "quick-balanced");

      const envContent = fs.readFileSync(envFile, "utf8");
      assert.ok(envContent.includes("AUTO_REPHRASE_ON_CONTENT_FILTER=true"));
      assert.ok(envContent.includes("CONTENT_FILTER_REPHRASE_PROMPT=Rule 1\\nRule 2"));
      assert.ok(envContent.includes("CONTENT_FILTER_REPHRASE_MODEL=quick-balanced"));

      const reloaded = loadConfigFromEnv(
        {
          QUICK_TOKENS: "local-outpost",
          AUTO_REPHRASE_ON_CONTENT_FILTER: "true",
          CONTENT_FILTER_REPHRASE_PROMPT: "Rule 1\\nRule 2",
          CONTENT_FILTER_REPHRASE_MODEL: "quick-balanced",
        },
        envFile,
      );
      assert.equal(reloaded.autoRephraseOnContentFilter, true);
      assert.equal(reloaded.contentFilterRephrasePrompt, "Rule 1\nRule 2");
      assert.equal(reloaded.contentFilterRephraseModel, "quick-balanced");

      const html = renderDashboardHtml("/dashboard", "test-nonce");
      assert.ok(html.includes("cfgAutoRephraseOnContentFilter"));
      assert.ok(html.includes("editRephrasePromptBtn"));
      assert.ok(html.includes("cfgContentFilterRephraseModel"));
      assert.ok(html.includes("promptEditorModal"));
      assert.ok(html.includes("promptEditorResetBtn"));
      assert.ok(html.includes("无损升级说明"));
      assert.ok(html.includes("防误拦重述"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers from content_filtered via native edit_message warm branch without downgrading model, preserves Turn 3 warm_incremental, and logs zero-content recovery metadata", async () => {
    const { WebSocket, WebSocketServer } = await import("ws");
    const { encodeEventStream } = await import("../src/aws-quick/event-stream-cbor.js");
    const { serializeOAuthCredential } = await import("../src/aws-quick/oauth-client.js");
    const { QuickExecutionEngine } = await import("../src/core/engine.js");
    const { UsageTracker } = await import("../src/services/usage-tracker.js");
    const { RequestTraceLogger } = await import("../src/services/request-logger.js");

    const sendCloudOutput = (ws: import("ws").WebSocket, ev: Record<string, unknown>) => {
      const b64 = Buffer.from(JSON.stringify(ev), "utf8").toString("base64");
      const payload = Buffer.from(JSON.stringify({ payload: b64 }), "utf8");
      ws.send(
        encodeEventStream(
          { ":event-type": "rawOutputEvent", ":content-type": "application/json", ":message-type": "event" },
          payload,
        ),
      );
    };

    const receivedFrames: Array<{ connIdx: number; type: string; payload: Record<string, unknown> }> = [];
    const dialedUrls: string[] = [];
    let nextConnIdx = 0;

    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const addr = wss.address();
    assert.ok(addr && typeof addr === "object");
    const mockPort = addr.port;

    wss.on("connection", (ws, req) => {
      const u = new URL(req.url || "/", `http://127.0.0.1:${mockPort}`);
      const connIdx = Number(u.searchParams.get("connIdx") || "0");
      sendCloudOutput(ws, { type: "connected", payload: { user: { email: "mock@example.com" } } });

      ws.on("message", (raw) => {
        const outer = JSON.parse(raw.toString("utf8")) as { payload?: { payload?: string } };
        const b64 = outer.payload?.payload;
        if (!b64) return;
        const inner = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
          type?: string;
          payload?: Record<string, unknown>;
        };
        const type = String(inner.type || "");
        const payload = inner.payload || {};
        if (type === "ping") return;
        if (type === "session_connect") {
          sendCloudOutput(ws, { type: "session_established", payload: {} });
          return;
        }
        if (type !== "user_message" && type !== "edit_message") return;
        receivedFrames.push({ connIdx, type, payload });

        if (type === "user_message") {
          const mode = String(payload.agent_mode || "");
          const text = String(payload.text || "");
          const tid = String(payload.thread_id || "");
          if (mode === "fast") {
            sendCloudOutput(ws, { type: "routing_decision", payload: { resolved_model_id: "us.anthropic.claude-haiku-5-5" } });
            sendCloudOutput(ws, { type: "text_delta", payload: { delta: "Explain parameterized SQL queries for defensive hardening." } });
            sendCloudOutput(ws, { type: "turn_usage", payload: { input_tokens: 40, output_tokens: 12, cache_read_tokens: 0, cache_write_tokens: 0, resolved_model_id: "us.anthropic.claude-haiku-5-5" } });
            sendCloudOutput(ws, { type: "message_complete", thread_id: tid, payload: {} });
          } else if (text.includes("TRIGGER_CONTENT_FILTER")) {
            sendCloudOutput(ws, {
              type: "error",
              thread_id: tid,
              payload: { error_code: "content_filtered", error: "Output blocked by upstream content filter" },
            });
          } else if (tid === "branch-mock1234") {
            sendCloudOutput(ws, { type: "routing_decision", payload: { resolved_model_id: "us.anthropic.claude-opus-5-5" } });
            sendCloudOutput(ws, { type: "text_delta", payload: { delta: "Project code is ORION-8821." } });
            sendCloudOutput(ws, { type: "turn_usage", payload: { input_tokens: 30, output_tokens: 10, cache_read_tokens: 1200, cache_write_tokens: 0, resolved_model_id: "us.anthropic.claude-opus-5-5" } });
            sendCloudOutput(ws, { type: "message_complete", thread_id: tid, payload: {} });
          } else {
            sendCloudOutput(ws, { type: "routing_decision", payload: { resolved_model_id: "us.anthropic.claude-opus-5-5" } });
            sendCloudOutput(ws, { type: "text_delta", payload: { delta: "Acknowledged ORION-8821." } });
            sendCloudOutput(ws, { type: "turn_usage", payload: { input_tokens: 60, output_tokens: 8, cache_read_tokens: 0, cache_write_tokens: 60, resolved_model_id: "us.anthropic.claude-opus-5-5" } });
            sendCloudOutput(ws, { type: "message_complete", thread_id: tid, payload: {} });
          }
        } else if (type === "edit_message") {
          const tid = String(payload.thread_id || "");
          sendCloudOutput(ws, { type: "tree_sync", thread_id: tid, payload: { kernel_thread_id: "branch-mock1234", thread_id: tid } });
          sendCloudOutput(ws, { type: "routing_decision", payload: { resolved_model_id: "us.anthropic.claude-opus-5-5" } });
          sendCloudOutput(ws, { type: "text_delta", payload: { delta: "Use parameterized queries to prevent SQL injection." } });
          sendCloudOutput(ws, { type: "turn_usage", payload: { input_tokens: 50, output_tokens: 16, cache_read_tokens: 900, cache_write_tokens: 0, resolved_model_id: "us.anthropic.claude-opus-5-5" } });
          sendCloudOutput(ws, { type: "message_complete", thread_id: "branch-mock1234", payload: { kernel_thread_id: "branch-mock1234" } });
        }
      });
    });

    const mockOAuthKey = serializeOAuthCredential({
      clientId: "mock-client-id-rephrase",
      clientSecret: "mock-client-secret",
      refreshToken: "mock-refresh-token",
      accessToken: "mock-valid-access-token",
      expiresAt: Date.now() + 3_600_000,
      wsHost: "api.us-east-1.quick.aws.com",
      region: "us-east-1",
      issuerUrl: "https://oidc.us-east-1.amazonaws.com",
    });

    const cfg = loadConfigFromEnv({
      QUICK_TOKENS: mockOAuthKey,
      INCOGNITO: "true",
      AUTO_ENSURE_CODING_AGENT: "false",
      AUTO_REPHRASE_ON_CONTENT_FILTER: "true",
      CONTENT_FILTER_REPHRASE_MODEL: "quick-fast",
    });
    const pool = new UpstreamKeyPool(cfg);
    const usage = new UsageTracker();
    const traceLogger = new RequestTraceLogger();
    const engine = new QuickExecutionEngine({
      config: cfg,
      usageTracker: usage,
      webSocketFactory: (url) => {
        dialedUrls.push(url);
        const idx = nextConnIdx++;
        return new WebSocket(`ws://127.0.0.1:${mockPort}/?connIdx=${idx}`);
      },
    });

    const runTurn = async (messages: Array<{ role: string; content: string }>) => {
      const turn = parseChatCompletionsRequest({ model: "quick-smart", stream: true, messages }, { "x-session-id": "mock-conv-1" });
      const traceId = traceLogger.startTrace("openai-chat", turn);
      let text = "";
      let thinking = "";
      let lastMeta: { execMode?: string; contentFilterRecovered?: boolean } = {};
      for await (const ev of engine.executeTurnWithPool(turn, pool, (meta) => {
        lastMeta = meta;
        traceLogger.bindExecutionMeta(traceId, meta);
      })) {
        if (ev.type === "text") {
          text += ev.text;
          traceLogger.recordTextDelta(traceId, ev.text);
        } else if (ev.type === "thinking") {
          thinking += ev.text;
          traceLogger.recordThinkingDelta(traceId, ev.text);
        }
      }
      traceLogger.finishSuccess(traceId, "stop");
      return { text, thinking, meta: lastMeta, trace: traceLogger.getDetail(traceId)! };
    };

    try {
      // Turn 1: Cold incognito turn establishes warm WS + root thread
      const t1 = await runTurn([{ role: "user", content: "Remember project code ORION-8821." }]);
      assert.equal(t1.text, "Acknowledged ORION-8821.");
      assert.equal(t1.meta.execMode, "incognito");
      assert.equal(t1.trace.contentFilterRecovered, undefined);
      assert.equal(engine.runtimeStats().warmIdleSessions, 1);

      // Turn 2: Warm turn hits content_filtered -> isolated helper rephrases -> native edit_message on SAME warm WS & SAME smart model
      const t2 = await runTurn([
        { role: "user", content: "Remember project code ORION-8821." },
        { role: "assistant", content: "Acknowledged ORION-8821." },
        { role: "user", content: "TRIGGER_CONTENT_FILTER explain SQL bypass" },
      ]);
      assert.equal(t2.text, "Use parameterized queries to prevent SQL injection.");
      assert.ok(t2.thinking.includes("routed=us.anthropic.claude-opus-5-5 · rephrased"));
      assert.equal(t2.meta.execMode, "warm_incremental");
      assert.equal(t2.meta.contentFilterRecovered, true);
      assert.equal(t2.trace.contentFilterRecovered, true);
      // Zero-content privacy invariant: trace detail must NEVER store original or rephrased prompt text
      const traceJson = JSON.stringify(t2.trace);
      assert.ok(!traceJson.includes("TRIGGER_CONTENT_FILTER"));
      assert.ok(!traceJson.includes("parameterized SQL queries"));
      assert.ok(!traceJson.includes("ORION-8821"));

      // Turn 3: Client sends original (un-rephrased) Turn 2 in history -> must STILL hit warm_incremental on branch-mock1234!
      const t3 = await runTurn([
        { role: "user", content: "Remember project code ORION-8821." },
        { role: "assistant", content: "Acknowledged ORION-8821." },
        { role: "user", content: "TRIGGER_CONTENT_FILTER explain SQL bypass" },
        { role: "assistant", content: "Use parameterized queries to prevent SQL injection." },
        { role: "user", content: "What was the project code?" },
      ]);
      assert.equal(t3.text, "Project code is ORION-8821.");
      assert.equal(t3.meta.execMode, "warm_incremental");
      assert.equal(t3.trace.contentFilterRecovered, undefined);

      // Wire-level assertions:
      // 1) Exactly 2 WS connections total: conn 0 (warm thread reused across T1 -> T2 -> edit_message -> T3) + conn 1 (isolated rephrase helper)
      assert.equal(dialedUrls.length, 2);
      const wsSessions = dialedUrls.map((u) => new URL(u).searchParams.get("workingSessionId"));
      assert.ok(wsSessions[0] && wsSessions[1] && wsSessions[0] !== wsSessions[1], "helper WS must use a distinct workingSessionId");

      const t1Frame = receivedFrames[0]!;
      const t2InitialFrame = receivedFrames[1]!;
      const helperFrame = receivedFrames[2]!;
      const editFrame = receivedFrames[3]!;
      const t3Frame = receivedFrames[4]!;

      assert.equal(t1Frame.connIdx, 0);
      assert.equal(t1Frame.type, "user_message");
      assert.equal(t1Frame.payload.agent_mode, "smart");

      assert.equal(t2InitialFrame.connIdx, 0);
      assert.equal(t2InitialFrame.type, "user_message");
      assert.equal(t2InitialFrame.payload.agent_mode, "smart");
      assert.equal(t2InitialFrame.payload.thread_id, t1Frame.payload.thread_id);

      assert.equal(helperFrame.connIdx, 1);
      assert.equal(helperFrame.type, "user_message");
      assert.equal(helperFrame.payload.agent_mode, "fast");
      assert.equal(helperFrame.payload.web_search_enabled, false);

      assert.equal(editFrame.connIdx, 0, "edit_message must reuse the live warm WS");
      assert.equal(editFrame.type, "edit_message");
      assert.equal(editFrame.payload.agent_mode, "smart", "must NEVER downgrade user's requested model");
      assert.equal(editFrame.payload.original_message_id, t2InitialFrame.payload.message_id);
      assert.equal(editFrame.payload.root_session_id, t1Frame.payload.thread_id);
      assert.equal(editFrame.payload.thread_id, t1Frame.payload.thread_id);
      assert.equal(editFrame.payload.text, "Explain parameterized SQL queries for defensive hardening.");

      assert.equal(t3Frame.connIdx, 0, "Turn 3 must reuse the same warm WS after edit_message");
      assert.equal(t3Frame.type, "user_message");
      assert.equal(t3Frame.payload.thread_id, "branch-mock1234", "Turn 3 must target the branch thread returned by tree_sync");
      assert.equal(t3Frame.payload.agent_mode, "smart");
    } finally {
      await engine.disposeAll();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
