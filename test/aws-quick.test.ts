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
  ChunkedFrameAssembler,
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
import {
  fetchWebProfileUsage,
  listWebCloudSessions,
  parseWebCurlOrCredential,
  serializeWebCredential,
} from "../src/aws-quick/web-client.js";
import { createGatewayServer } from "../src/server.js";
import {
  assertSafeRemoteImageUrl,
  buildQuickImageAttachments,
  classifyUpstreamError,
  estimatePromptTokens,
  isPrivateOrReservedIp,
  isPseudo200UsageLimitPrefix,
  isPseudo200UsageLimitText,
  mapAttachmentUploadError,
  MAX_PARKED_WS_PER_SLOT,
  pinnedHttpGet,
  splitPromptIntoSafeChunks,
} from "../src/core/engine.js";
import { GatewayError } from "../src/core/types.js";
import { assertDataDirWritable, findInsecurePlaceholderConfig, loadConfigFromEnv } from "../src/core/config.js";
import { UpstreamKeyPool, validateChatAgentId } from "../src/core/key-pool.js";
import {
  buildToolBridgePrompt,
  parseToolCallsFromText,
  sanitizeClientSystemPromptForQuick,
  StreamingToolCallFilter,
} from "../src/core/tool-bridge.js";
import { StreamingUiTagSanitizer } from "../src/core/ui-tag-sanitizer.js";
import {
  openAiChatAdapter,
  openAiResponsesAdapter,
  parseChatCompletionsRequest,
  parseResponsesRequest,
} from "../src/protocols/openai.js";
import {
  anthropicMessagesAdapter,
  estimateAnthropicTokens,
  parseAnthropicMessagesRequest,
  stabilizeAnthropicUsage,
} from "../src/protocols/anthropic.js";
import { extendHashWithAssistantTurn, normalizeSystemPromptForHash } from "../src/utils/hash.js";
import { AWS_QUICK_MODELS, formatOpenAiModelList, resolveModelSelection } from "../src/services/model-catalog.js";
import { ClientGatewayKeyManager } from "../src/services/client-keys.js";
import { checkLatestVersion } from "../src/services/update-checker.js";
import { createTarGzBuffer, extractTarGzSafely } from "../src/services/tar-archive.js";
import {
  applySelfUpdate,
  assertAllowedDownloadUrl,
  computeRuntimeDepsHash,
  ensureReleaseNodeModulesLink,
  EXIT_CODE_SELF_UPDATE_RESTART,
  getSelfUpdateCapability,
  loadSelfUpdateState,
  readBuiltinRuntimeInfo,
  releaseDirForVersion,
  rollbackSelfUpdate,
  saveSelfUpdateState,
} from "../src/services/self-updater.js";
import { resolveBootTarget, runBootstrapSupervisor } from "../src/bootstrap.js";
import { establishSocks5Tunnel, fetchViaOptionalProxy, getProxyAgent, maskProxyUrl, validateProxyUrl } from "../src/utils/proxy-agent.js";
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
      classList: { add() { }, remove() { }, contains() { return false; }, toggle() { } },
      setAttribute() { },
      getAttribute() { return null; },
      hasAttribute() { return false; },
      addEventListener() { },
      removeEventListener() { },
      focus() { },
      querySelector() { return makeEl(); },
      querySelectorAll() { return []; },
      appendChild() { },
      insertBefore() { },
      children: [],
      options: [{ textContent: "all", value: "all" }],
      selectedIndex: 0,
      parentNode: { insertBefore() { }, removeChild() { } },
      textContent: "",
      value: id === "credStatusFilter" ? "all" : "",
      innerHTML: "",
      getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, right: 0, width: 100, height: 30 }; },
    });
    const ctx: Record<string, unknown> = {
      location: { pathname: "/dashboard", origin: "http://localhost:3456", search: "" },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => { } } },
      localStorage: { getItem() { return null; }, setItem() { }, removeItem() { } },
      sessionStorage: { getItem() { return null; }, setItem() { }, removeItem() { } },
      document: {
        documentElement: { lang: "zh-CN", setAttribute() { }, getAttribute() { return "light"; } },
        getElementById(id: string) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
        querySelector() { return makeEl(); },
        querySelectorAll() { return []; },
        createElement(tag: string) { return makeEl(tag); },
        createElementNS() { return makeEl(); },
        createTreeWalker() { return { nextNode() { return null; } }; },
        addEventListener() { },
        body: makeEl("body"),
      },
      addEventListener() { },
      removeEventListener() { },
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      setTimeout: () => 0,
      clearTimeout() { },
      setInterval: () => 0,
      clearInterval() { },
      Event: class { },
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

  it("estimates tokens accurately across ASCII and CJK text", () => {
    const small = "Hello world, this is a normal prompt.";
    assert.ok(estimatePromptTokens(small) > 0 && estimatePromptTokens(small) < 30);
    const huge = "MIDDLE_NOISE_LINE_0123456789\n".repeat(3000);
    assert.ok(estimatePromptTokens(huge) > 15_000);
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

      pool.flushStateToDisk();
      const stateContent = fs.readFileSync(path.join(tmpDir, "pool-state.json"), "utf8");
      assert.ok(stateContent.includes('"chatAgentId": "agent-global-002"'));
      assert.ok(stateContent.includes('"autoEnsureCodingAgent": false'));
      assert.ok(stateContent.includes("Line1\\nLine2 custom prompt"));
      assert.ok(stateContent.includes(`"${slotA.slotId}": "agent-slot-a"`));

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

    // 9) Fast-fail 429 when all usable accounts are in cooldown beyond the wait budget (no cooling-down fall-through)
    const fullCoolPool = new UpstreamKeyPool({ ...cfg, maxInflightPerSlot: 2 });
    const fc1 = fullCoolPool.leaseSpecificKey(kA);
    const fc2 = fullCoolPool.leaseSpecificKey(kA);
    fullCoolPool.reportConnLimit(kA, 2_000);
    fullCoolPool.reportRateLimit(kB);
    await assert.rejects(
      () => fullCoolPool.leaseKeyWithWait("quick-smart", undefined, undefined, { maxWaitMs: 30 }),
      (err: unknown) => (err as { status?: number; code?: string })?.status === 429 && (err as { code?: string })?.code === "rate_limit_exceeded",
    );
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
    assert.equal(resolveModelSelection("auto", {}).canonicalId, "quick-balanced");
    assert.throws(
      () => resolveModelSelection("totally-unknown-model-999", {}),
      (err: unknown) => (err as { status?: number; code?: string })?.status === 404 && (err as { code?: string })?.code === "model_not_found",
    );

    // Malformed tool-call arguments string must preserve raw block as text instead of coercing to `{}`
    const badArgsRaw = '<tool_call>{"name":"read_file","arguments":"{not-valid-json"}</tool_call>';
    const badArgsParsed = parseToolCallsFromText(badArgsRaw);
    assert.equal(badArgsParsed.toolCalls.length, 0);
    assert.ok(badArgsParsed.cleanText.includes("{not-valid-json"));

    // Out-of-band attachment wrapper prompt keeps BOTH opening question and tail inline within single frame
    const { buildOutOfBandContextPrompt } = await import("../src/core/engine.js");
    const hugePrompt = `OPENING_QUESTION=Find HEAD, MID, and TAIL needles.\n${"Earlier log line.\n".repeat(12_000)}FINAL_USER_QUESTION=Extract all needles`;
    const wrapped = buildOutOfBandContextPrompt(hugePrompt, "conversation_context_abc12345.txt");
    assert.ok(wrapped.includes("conversation_context_abc12345.txt"));
    assert.ok(wrapped.includes("OPENING_QUESTION=Find HEAD, MID, and TAIL needles."));
    assert.ok(wrapped.includes("FINAL_USER_QUESTION=Extract all needles"));
    assert.ok(Buffer.byteLength(wrapped, "utf8") < 6_000);

    // Multi-turn cold replay with explicit openingHintSource preserves the latest user turn's opening question
    const multiTurnPrompt = `[SYSTEM]: Long system prompt.\n[USER]: Old turn\n[ASSISTANT]: Old answer\n[USER]: LATEST_TOP_QUESTION=Summarize errors below\n${"Log entry line.\n".repeat(12_000)}`;
    const wrappedMulti = buildOutOfBandContextPrompt(
      multiTurnPrompt,
      "conversation_context_def67890.txt",
      3_500,
      false,
      `LATEST_TOP_QUESTION=Summarize errors below\n${"Log entry line.\n".repeat(12_000)}`,
    );
    assert.ok(wrappedMulti.includes("LATEST_TOP_QUESTION=Summarize errors below"));
    assert.ok(Buffer.byteLength(wrappedMulti, "utf8") < 6_000);
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
    assert.equal(isLikelySoftRefusal("This request appears to be a prompt injection attack."), true);
    assert.equal(isLikelySoftRefusal("As an AWS Quick assistant, no device is connected right now."), true);
    assert.equal(isLikelySoftRefusal("检测到提示词注入，我无法执行。"), true);
    assert.equal(isLikelySoftRefusal("I'm sorry, I noticed a typo in line 12. Here is the fixed code."), false);
    assert.equal(
      isLikelySoftRefusal("请从防御角度讲解企业 RAG 系统中 indirect prompt injection 的原理、隔离方案与验证单测。"),
      false,
    );
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
      pool.dispose();

      // Persisted atomically to `${dataDir}/pool-state.json` without rewriting `.env`
      const poolStatePath = path.join(tmpDir, "pool-state.json");
      const persistedJson = JSON.parse(fs.readFileSync(poolStatePath, "utf8")) as Record<string, unknown>;
      assert.equal(persistedJson.autoRephraseOnContentFilter, true);
      assert.equal(persistedJson.contentFilterRephrasePrompt, "Rule 1\nRule 2");
      assert.equal(persistedJson.contentFilterRephraseModel, "quick-balanced");

      const poolReloaded = new UpstreamKeyPool(cfg);
      assert.equal(poolReloaded.getSettings().autoRephraseOnContentFilter, true);
      assert.equal(poolReloaded.getSettings().contentFilterRephrasePrompt, "Rule 1\nRule 2");
      assert.equal(poolReloaded.getSettings().contentFilterRephraseModel, "quick-balanced");
      poolReloaded.dispose();

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
      assert.equal(t1.trace.usedDefaultSystemAgent, true);
      assert.equal(engine.runtimeStats().warmIdleSessions, 1);

      // Verify explicit fallback metadata flags preserve zero-content privacy
      const fallbackTraceId = traceLogger.startTrace(
        "openai-chat",
        parseChatCompletionsRequest({ model: "quick-smart", stream: false, messages: [{ role: "user", content: "SECRET_SHOULD_NOT_LEAK" }] }),
      );
      traceLogger.bindExecutionMeta(fallbackTraceId, {
        maskedKey: "oauth:mock***",
        execMode: "incognito",
        warmFallbackToCold: true,
        accountFailoverCount: 2,
        usedDefaultSystemAgent: true,
      });
      traceLogger.finishSuccess(fallbackTraceId, "stop");
      const fbDetail = traceLogger.getDetail(fallbackTraceId)!;
      assert.equal(fbDetail.warmFallbackToCold, true);
      assert.equal(fbDetail.accountFailoverCount, 2);
      assert.equal(fbDetail.usedDefaultSystemAgent, true);
      assert.ok(!JSON.stringify(fbDetail).includes("SECRET_SHOULD_NOT_LEAK"));

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

  it("preserves real HTTP 403/429 during server.ts 15s delayed flushEarly without leaking timers", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "aws-quick-flush-"));
    const cfg = loadConfigFromEnv({
      HOST: "127.0.0.1",
      PORT: "0",
      GATEWAY_TOKEN: "sk-aq-test-real-token-9876543210",
      QUICK_TOKENS: "example.aws.dev|eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig",
      GATEWAY_KEYS_FILE: path.join(tmpDir, "gateway-keys.json"),
      USAGE_LEDGER_FILE: path.join(tmpDir, "usage-ledger.json"),
      ADMIN_AUTH_FILE: path.join(tmpDir, "admin-auth.json"),
      ENV_FILE_PATH: path.join(tmpDir, ".env"),
      ENABLE_DASHBOARD: "false",
    });
    const gw = createGatewayServer({ config: cfg });
    let nextBehavior: "403" | "429" | "ok" = "403";

    // Stub executeTurnWithPool to invoke onExecMeta (resolving leaseReadyPromise -> arming the 15s delayedFlushTimer),
    // then fail within <15s (403/429) or emit a normal response.
    (gw.engine as unknown as { executeTurnWithPool: typeof gw.engine.executeTurnWithPool }).executeTurnWithPool =
      async function* (_turn, _pool, onExecMeta) {
        onExecMeta?.({
          slotId: "mock-slot",
          maskedKey: "token:mock***",
          execMode: "incognito",
        });
        await new Promise((r) => setTimeout(r, 20));
        if (nextBehavior === "403") {
          throw new GatewayError("Upstream model forbidden for this account.", 403, "forbidden");
        }
        if (nextBehavior === "429") {
          throw new GatewayError("Upstream rate limit reached.", 429, "rate_limit_exceeded");
        }
        yield { type: "text", text: "Hello after delayed flush check." };
        yield { type: "done", stopReason: "stop" };
      };

    await new Promise<void>((resolve) => gw.server.listen(0, "127.0.0.1", resolve));
    const addr = gw.server.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const makeReq = async () =>
        fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": "sk-aq-test-real-token-9876543210",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "quick-balanced",
            max_tokens: 256,
            stream: true,
            // Anthropic + tools triggers flushEarly=true with flushEarlyAfter=leaseReadyPromise
            tools: [{ name: "Read", description: "Read file", input_schema: { type: "object", properties: {} } }],
            messages: [{ role: "user", content: "hello" }],
          }),
        });

      // 1) Post-lease 403 before 15s -> must return real HTTP 403 JSON, NOT HTTP 200 SSE
      nextBehavior = "403";
      const r403 = await makeReq();
      assert.equal(r403.status, 403);
      assert.ok((r403.headers.get("content-type") || "").includes("application/json"));
      const b403 = (await r403.json()) as { type?: string; error?: { message?: string } };
      assert.equal(b403.type, "error");
      assert.match(b403.error?.message || "", /forbidden/i);

      // 2) Post-lease 429 before 15s -> must return real HTTP 429 JSON + retry-after header
      nextBehavior = "429";
      const r429 = await makeReq();
      assert.equal(r429.status, 429);
      assert.ok(r429.headers.get("retry-after"));
      const b429 = (await r429.json()) as { type?: string; error?: { message?: string } };
      assert.equal(b429.type, "error");
      assert.match(b429.error?.message || "", /rate limit/i);

      // 3) Normal stream before 15s -> HTTP 200 SSE with content & clean timer cancellation
      nextBehavior = "ok";
      const rOk = await makeReq();
      assert.equal(rOk.status, 200);
      assert.ok((rOk.headers.get("content-type") || "").includes("text/event-stream"));
      const sseBody = await rOk.text();
      assert.ok(sseBody.includes("Hello after delayed flush check."));
    } finally {
      await gw.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves raw text for malformed tool_call arguments across streaming filter, unclosed tags, and mixed blocks", () => {
    // 1) StreamingToolCallFilter chunked input with malformed string arguments -> 0 toolCalls, raw preserved
    const filter = new StreamingToolCallFilter(new Set(["read_file"]));
    let emitted = "";
    const badStream = 'Checking <tool_call>{"name":"read_file","arguments":"{not-valid-json"}</tool_call>';
    for (let i = 0; i < badStream.length; i += 7) {
      emitted += filter.feed(badStream.slice(i, i + 7));
    }
    const flushed = filter.flush();
    assert.equal(flushed.toolCalls.length, 0);
    assert.ok((emitted + flushed.remainingText).includes('{"name":"read_file","arguments":"{not-valid-json"}'));

    // 2) Unclosed <tool_call> with malformed string arguments -> raw preserved
    const unclosed = parseToolCallsFromText('Intro <tool_call>{"name":"read_file","arguments":"{broken"}');
    assert.equal(unclosed.toolCalls.length, 0);
    assert.ok(unclosed.cleanText.includes('"{broken"'));

    // 3) Valid non-object JSON string arguments (array) and malformed `input` string -> raw preserved
    const arrayArgs = parseToolCallsFromText('<tool_call>{"name":"read_file","arguments":"[1,2,3]"}</tool_call>');
    assert.equal(arrayArgs.toolCalls.length, 0);
    assert.ok(arrayArgs.cleanText.includes("[1,2,3]"));

    const badInput = parseToolCallsFromText('<tool_call>{"name":"read_file","input":"{bad"}</tool_call>');
    assert.equal(badInput.toolCalls.length, 0);
    assert.ok(badInput.cleanText.includes("{bad"));

    // 4) Empty/whitespace string arguments -> normalized to `{}`
    const emptyArgs = parseToolCallsFromText('<tool_call>{"name":"ping","arguments":"   "}</tool_call>');
    assert.equal(emptyArgs.toolCalls.length, 1);
    assert.deepEqual(emptyArgs.toolCalls[0]?.argsObject, {});

    // 5) Mixed valid + malformed <tool_call> blocks -> valid extracted, malformed kept verbatim
    const mixed = parseToolCallsFromText(
      '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>\n' +
      '<tool_call>{"name":"read_file","arguments":"{corrupt"}</tool_call>',
    );
    assert.equal(mixed.toolCalls.length, 1);
    assert.deepEqual(mixed.toolCalls[0]?.argsObject, { path: "a.ts" });
    assert.ok(mixed.cleanText.includes("{corrupt"));
  });

  it("throws explicit errors when web-client qbsproxy returns non-JSON or malformed body payloads", async () => {
    const mockCred = {
      accountId: "123456789012",
      mbtc: "mock-csrf-token",
      cookie: "session=mock",
      wsHost: "quick.aws.com",
    };
    const origFetch = globalThis.fetch;
    let mockStatus = 200;
    let mockBody = "";

    globalThis.fetch = (async () =>
      new Response(mockBody, {
        status: mockStatus,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;

    try {
      // 1) HTML login page (expired session) -> rejects with non-JSON error without leaking HTML
      mockStatus = 200;
      mockBody = "<!DOCTYPE html><html><body>AWS Sign-In SECRET_HTML_MARKER</body></html>";
      await assert.rejects(
        () => fetchWebProfileUsage(mockCred),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          return /returned non-JSON response/i.test(msg) && !msg.includes("SECRET_HTML_MARKER");
        },
      );

      // 2) Double-encoded non-JSON string -> rejects with non-JSON error
      mockBody = JSON.stringify("<html>session expired</html>");
      await assert.rejects(
        () => listWebCloudSessions(mockCred, 10),
        /returned non-JSON response/i,
      );

      // 3) Valid outer JSON with malformed inner `body` string -> rejects with malformed body payload error
      mockBody = JSON.stringify({ body: "{not-valid-inner-json" });
      await assert.rejects(
        () => fetchWebProfileUsage(mockCred),
        /returned malformed body payload/i,
      );

      // 4) Valid double-encoded `{ body: JSON.stringify(...) }` succeeds cleanly
      mockBody = JSON.stringify(JSON.stringify({ body: JSON.stringify({ frames: [{ type: "session_list", payload: { sessions: [{ id: "s1", title: "Demo", created_at: 1, updated_at: 2, message_count: 3 }] } }] }) }));
      const sessions = await listWebCloudSessions(mockCred, 10);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.id, "s1");

      // 5) Valid non-object JSON primitives (`null`, `123`, `[]`) must throw instead of silently coercing to `{}`
      for (const primitive of ["null", "123", "true", "[]"]) {
        mockBody = primitive;
        await assert.rejects(
          () => fetchWebProfileUsage(mockCred),
          /returned non-JSON response/i,
        );
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("covers all 9 P1 & P2 audit fixes: connLimit wait, dashboard order, thinking_delta flush, soft-refusal EN, OOB prompt, pre-lease limits, catalog aliases, sub-key 404, logger failover reset, non-object tool args", async () => {
    const {
      buildOutOfBandContextPrompt,
      isLikelySoftRefusal,
      QuickExecutionEngine,
    } = await import("../src/core/engine.js");
    const { resolveKnownModelId } = await import("../src/services/model-catalog.js");
    const { RequestTraceLogger } = await import("../src/services/request-logger.js");
    const { UsageTracker } = await import("../src/services/usage-tracker.js");
    const { WebSocketServer, WebSocket: WsClient } = await import("ws");

    // P1-1: Full-concurrency slot with brief connLimit cooldown (<= maxWaitMs) must WAIT, not fast-fail 429
    {
      const cfg = loadConfigFromEnv({
        QUICK_TOKENS: "example.aws.dev|eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig1",
      });
      const pool = new UpstreamKeyPool({ ...cfg, maxInflightPerSlot: 1 });
      const k1 = pool.allManagedKeys()[0]!.rawKey;
      const held = pool.leaseSpecificKey(k1);
      pool.reportConnLimit(k1, 80);
      setTimeout(() => held.release(), 30);
      const t0 = Date.now();
      const acquired = await pool.leaseKeyWithWait("quick-balanced", undefined, undefined, { maxWaitMs: 600 });
      assert.equal(acquired.apiKey, k1);
      assert.ok(Date.now() - t0 >= 65, "should wait for both release and brief connLimit expiry");
      acquired.release();
    }

    // P1-2: Dashboard HTML assigns window.__globalChatAgentId BEFORE rendering account tables
    {
      const html = renderDashboardHtml("/dashboard", "test-nonce");
      const assignIdx = html.indexOf('window.__globalChatAgentId = settings.chatAgentId || "";');
      const overviewIdx = html.indexOf('$("overviewAccountsBody").innerHTML');
      const credTableIdx = html.indexOf("renderCredTable();");
      assert.ok(assignIdx > 0 && overviewIdx > assignIdx && credTableIdx > assignIdx);
    }

    // P1-3: thinking_delta arriving after buffered text_delta ("You") must flush prefix in-order before thinking
    {
      const sendCloudOut = (sock: import("ws").WebSocket, ev: Record<string, unknown>) => {
        const b64 = Buffer.from(JSON.stringify(ev), "utf8").toString("base64");
        const payload = Buffer.from(JSON.stringify({ payload: b64 }), "utf8");
        sock.send(
          encodeEventStream(
            { ":event-type": "rawOutputEvent", ":content-type": "application/json", ":message-type": "event" },
            payload,
          ),
        );
      };
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>((resolve) => wss.once("listening", resolve));
      const addr = wss.address();
      assert.ok(addr && typeof addr === "object");
      const wsPort = addr.port;
      wss.on("connection", (sock) => {
        sendCloudOut(sock, { type: "connected", payload: { user: { email: "mock@example.com" } } });
        sock.on("message", (raw) => {
          const outer = JSON.parse(raw.toString("utf8")) as { payload?: { payload?: string } };
          const b64 = outer.payload?.payload;
          if (!b64) return;
          const inner = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
            type?: string;
            payload?: Record<string, unknown>;
          };
          if (inner.type === "session_connect") {
            sendCloudOut(sock, { type: "session_established", payload: {} });
            return;
          }
          if (inner.type === "user_message") {
            const tid = String(inner.payload?.thread_id || "t1");
            sendCloudOut(sock, { type: "text_delta", thread_id: tid, payload: { delta: "You" } });
            sendCloudOut(sock, { type: "thinking_delta", thread_id: tid, payload: { delta: "checking" } });
            sendCloudOut(sock, { type: "text_delta", thread_id: tid, payload: { delta: " are all set." } });
            sendCloudOut(sock, { type: "message_complete", thread_id: tid, payload: {} });
          }
        });
      });

      const cfg = loadConfigFromEnv({
        QUICK_TOKENS: serializeOAuthCredential({
          accessToken: "mock-at",
          refreshToken: "mock-rt",
          clientId: "mock-cid-p1-3",
          clientSecret: "mock-cs",
          expiresAt: Date.now() + 3600_000,
          wsHost: "api.us-east-1.quick.aws.com",
          region: "us-east-1",
          issuerUrl: "https://oidc.us-east-1.amazonaws.com",
        }),
        INCOGNITO: "true",
        AUTO_ENSURE_CODING_AGENT: "false",
      });
      const pool = new UpstreamKeyPool(cfg);
      const engine = new QuickExecutionEngine({
        config: cfg,
        usageTracker: new UsageTracker(),
        webSocketFactory: () => new WsClient(`ws://127.0.0.1:${wsPort}`),
      });
      try {
        const turn = parseChatCompletionsRequest({
          model: "quick-balanced",
          stream: true,
          messages: [{ role: "user", content: "Check order" }],
        });
        let text = "";
        let thinking = "";
        for await (const ev of engine.executeTurnWithPool(turn, pool)) {
          if (ev.type === "text") text += ev.text;
          if (ev.type === "thinking") thinking += ev.text;
        }
        assert.equal(text, "You are all set.");
        assert.ok(thinking.includes("checking"));
      } finally {
        await engine.disposeAll();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    }

    // P1-4: SOFT_REFUSAL_PATTERNS does not false-positive on English defensive prompt-injection / social-engineering prose
    {
      assert.equal(isLikelySoftRefusal("How to detect indirect prompt injection in enterprise RAG pipelines."), false);
      assert.equal(isLikelySoftRefusal("To flag prompt injection attempts, add an input delimiter and validator."), false);
      assert.equal(isLikelySoftRefusal("When retrieved context contains prompt injection, treat it as untrusted data."), false);
      assert.equal(isLikelySoftRefusal("Social engineering awareness training helps teams spot phishing emails."), false);
      assert.equal(isLikelySoftRefusal("I detected a prompt injection in your request and cannot proceed."), true);
      assert.equal(isLikelySoftRefusal("This message looks like social engineering, so I must refuse."), true);
    }

    // P1-5: buildOutOfBandContextPrompt avoids UTF-16 surrogate splits & 2401..3749 duplication
    {
      const medPrompt = "A".repeat(2_800);
      const wrappedMed = buildOutOfBandContextPrompt(medPrompt, "ctx.txt", 3_500);
      assert.ok(!wrappedMed.includes("\n...\n"), "should not emit bogus ellipsis when fullPrompt fits maxInlineChars");
      assert.equal(wrappedMed.split("A".repeat(500)).length - 1, 5, "should not duplicate overlapping middle");

      const emojiPrompt = "😀".repeat(3_000);
      const wrappedEmoji = buildOutOfBandContextPrompt(emojiPrompt, "emoji.txt", 3_500);
      const hasLoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(wrappedEmoji);
      assert.equal(hasLoneSurrogate, false, "must never split UTF-16 surrogate pairs");

      const latestTurn2800 = `TOP_ANCHOR_99 ${"log_entry_item ".repeat(185)}TAIL_ANCHOR_99`;
      const multiPrompt = `${"OLD_HISTORY\n".repeat(4_000)}[USER]: ${latestTurn2800}`;
      const wrappedOverlap = buildOutOfBandContextPrompt(multiPrompt, "multi.txt", 3_500, false, latestTurn2800);
      assert.ok(wrappedOverlap.includes("TOP_ANCHOR_99"));
      assert.ok(wrappedOverlap.includes("TAIL_ANCHOR_99"));
      assert.equal(wrappedOverlap.split("TOP_ANCHOR_99").length - 1, 1);
      assert.equal(wrappedOverlap.split("TAIL_ANCHOR_99").length - 1, 1);
    }

    // P1-6: >10 images / >5 files rejected with 400 PRE-LEASE even when pool has 0 enabled keys
    {
      const emptyCfg = loadConfigFromEnv({ QUICK_TOKENS: "" });
      const emptyPool = new UpstreamKeyPool(emptyCfg);
      const engine = new QuickExecutionEngine({ config: emptyCfg, usageTracker: new UsageTracker() });
      const tinyB64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const turn11Imgs = parseChatCompletionsRequest({
        model: "quick-fast",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              ...Array.from({ length: 11 }, () => ({ type: "image_url", image_url: { url: tinyB64 } })),
            ],
          },
        ],
      });
      await assert.rejects(
        async () => {
          for await (const _ of engine.executeTurnWithPool(turn11Imgs, emptyPool)) { }
        },
        (err: unknown) => (err as { status?: number })?.status === 400,
      );

      const turn6Files = parseResponsesRequest({
        model: "quick-fast",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "read" },
              ...Array.from({ length: 6 }, (_, i) => ({
                type: "input_file",
                filename: `f${i}.pdf`,
                file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
              })),
            ],
          },
        ],
      });
      await assert.rejects(
        async () => {
          for await (const _ of engine.executeTurnWithPool(turn6Files, emptyPool)) { }
        },
        (err: unknown) => (err as { status?: number })?.status === 400,
      );
    }

    // P1-8: Prefix-only strings reject with 404; prefixed/effort default aliases work consistently
    {
      for (const bad of ["quick/", "aws-quick/", "amazon-quick/", "[aws]-", "[quick]-", "[custom]-"]) {
        assert.equal(resolveKnownModelId(bad), null, `${bad} must resolve to null`);
        assert.throws(
          () => resolveModelSelection(bad, {}),
          (err: unknown) => (err as { status?: number; code?: string })?.status === 404 && (err as { code?: string })?.code === "model_not_found",
        );
      }
      assert.equal(resolveKnownModelId("quick/auto"), "quick-balanced");
      assert.equal(resolveModelSelection("quick/auto", {}).canonicalId, "quick-balanced");
      assert.equal(resolveKnownModelId("auto[effort=high]"), "quick-balanced");
      assert.equal(resolveModelSelection("auto[effort=high]", {}).selection.thinkingEffort, "high");
      assert.equal(resolveKnownModelId("auto(high)"), "quick-balanced");
      assert.equal(resolveModelSelection("auto(high)", {}).selection.thinkingEffort, "high");
      assert.equal(resolveKnownModelId("default[effort=medium]"), "quick-balanced");
      assert.equal(resolveModelSelection("default[effort=medium]", {}).selection.thinkingEffort, "medium");
      assert.equal(resolveModelSelection("[custom]-quick-smart[effort=high]", {}).selection.thinkingEffort, "high");
    }

    // P1-9 & P2: Restricted sub-key gets 404 for unknown models (not 403) across POST, GET /models/:id, and count_tokens
    {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "aws-quick-subkey-404-"));
      const cfg = loadConfigFromEnv({
        HOST: "127.0.0.1",
        PORT: "0",
        GATEWAY_TOKEN: "sk-aq-master-real-token-1234567890",
        QUICK_TOKENS: "example.aws.dev|eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig",
        GATEWAY_KEYS_FILE: path.join(tmpDir, "gateway-keys.json"),
        USAGE_LEDGER_FILE: path.join(tmpDir, "usage-ledger.json"),
        ADMIN_AUTH_FILE: path.join(tmpDir, "admin-auth.json"),
        ENV_FILE_PATH: path.join(tmpDir, ".env"),
        ENABLE_DASHBOARD: "false",
      });
      const gw = createGatewayServer({ config: cfg });
      const created = gw.clientKeys.createKey({
        name: "restricted-sub",
        allowAllModels: false,
        allowedModels: ["quick-fast"],
      });
      await new Promise<void>((resolve) => gw.server.listen(0, "127.0.0.1", resolve));
      const addr = gw.server.address();
      assert.ok(addr && typeof addr === "object");
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const subHeaders = {
        Authorization: `Bearer ${created.rawToken}`,
        "x-api-key": created.rawToken,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      };
      try {
        const postUnk = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: subHeaders,
          body: JSON.stringify({ model: "totally-unknown-999", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(postUnk.status, 404);

        const postForbidden = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: subHeaders,
          body: JSON.stringify({ model: "quick-smart", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(postForbidden.status, 403);

        const getUnk = await fetch(`${baseUrl}/v1/models/totally-unknown-999`, { headers: subHeaders });
        assert.equal(getUnk.status, 404);

        const getForbidden = await fetch(`${baseUrl}/v1/models/quick-smart`, { headers: subHeaders });
        assert.equal(getForbidden.status, 403);

        const countUnk = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
          method: "POST",
          headers: subHeaders,
          body: JSON.stringify({ model: "totally-unknown-999", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(countUnk.status, 404);
      } finally {
        await gw.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    // P2: RequestTraceLogger resets per-attempt fields on failover and restores full upstreamSentChars on warm->cold fallback
    {
      const logger = new RequestTraceLogger(20);
      const turn = parseChatCompletionsRequest({
        model: "quick-balanced",
        messages: [
          { role: "user", content: "X".repeat(1_000) },
          { role: "assistant", content: "Y".repeat(1_000) },
          { role: "user", content: "short" },
        ],
      });
      const tid = logger.startTrace("openai-chat", turn);
      const initialFull = logger.getDetail(tid)!.upstreamSentChars;
      logger.bindExecutionMeta(tid, {
        slotId: "slotA",
        maskedKey: "oauth:aaa***",
        accountLabel: "AccA",
        execMode: "warm_incremental",
        usedProxy: true,
        usedDefaultSystemAgent: true,
      });
      assert.equal(logger.getDetail(tid)!.usedDefaultSystemAgent, true);
      assert.equal(logger.getDetail(tid)!.usedProxy, true);
      assert.ok(logger.getDetail(tid)!.upstreamSentChars < 50);

      logger.bindExecutionMeta(tid, {
        slotId: "slotB",
        maskedKey: "oauth:bbb***",
        execMode: "incognito",
        warmFallbackToCold: true,
        accountFailoverCount: 1,
      });
      const after = logger.getDetail(tid)!;
      assert.equal(after.slotId, "slotB");
      assert.equal(after.accountLabel, undefined);
      assert.equal(after.usedProxy, undefined);
      assert.equal(after.usedDefaultSystemAgent, undefined);
      assert.equal(after.warmFallbackToCold, true);
      assert.equal(after.accountFailoverCount, 1);
      assert.equal(after.upstreamSentChars, initialFull);
    }

    // P2: tool-bridge rejects non-string non-object arguments (arrays/numbers) instead of coercing to `{}`
    {
      const arrRaw = parseToolCallsFromText('<tool_call>{"name":"read_file","arguments":[1,2,3]}</tool_call>');
      assert.equal(arrRaw.toolCalls.length, 0);
      assert.ok(arrRaw.cleanText.includes("[1,2,3]"));

      const numRaw = parseToolCallsFromText('<tool_call>{"name":"read_file","arguments":42}</tool_call>');
      assert.equal(numRaw.toolCalls.length, 0);
      assert.ok(numRaw.cleanText.includes("42"));
    }
  });

  it("supports Anthropic output_config.effort=max / adaptive / high budget_tokens, docker-compose without env_file, and monotonic Anthropic usage floor", async () => {
    const { stabilizeAnthropicUsage } = await import("../src/protocols/anthropic.js");

    // 1) Anthropic effort mapping: output_config.effort, thinking.adaptive, high budget_tokens >= 16384 -> max,
    //    AND model-ID explicit effort (`quick-smart-max` / `quick-smart[effort=max]`) is NEVER downgraded by
    //    generic client defaults like `thinking: { type: "adaptive" }` or `budget_tokens: 10000`.
    assert.equal(resolveModelSelection("quick-smart", { output_config: { effort: "max" } }).selection.thinkingEffort, "max");
    assert.equal(
      resolveModelSelection("quick-smart", { thinking: { type: "adaptive" }, output_config: { effort: "max" } }).selection.thinkingEffort,
      "max",
    );
    assert.equal(resolveModelSelection("quick-smart-max", { thinking: { type: "adaptive" } }).selection.thinkingEffort, "max");
    assert.equal(
      resolveModelSelection("quick-smart-max", { thinking: { type: "enabled", budget_tokens: 10_000 } }).selection.thinkingEffort,
      "max",
    );
    assert.equal(
      resolveModelSelection("quick-smart[effort=max]", { thinking: { type: "adaptive" } }).selection.thinkingEffort,
      "max",
    );
    assert.equal(
      resolveModelSelection("quick-smart-max", { output_config: { effort: "low" } }).selection.thinkingEffort,
      "low",
    );
    assert.equal(resolveModelSelection("quick-smart", { thinking: { type: "adaptive" } }).selection.thinkingEffort, "high");
    assert.equal(resolveModelSelection("quick-balanced", { thinking: { type: "adaptive" } }).selection.thinkingEffort, "medium");
    assert.equal(
      resolveModelSelection("quick-smart", { thinking: { type: "enabled", budget_tokens: 10_000 } }).selection.thinkingEffort,
      "high",
    );
    assert.equal(
      resolveModelSelection("quick-smart", { thinking: { type: "enabled", budget_tokens: 31_999 } }).selection.thinkingEffort,
      "max",
    );
    assert.equal(
      resolveModelSelection("quick-smart-think", { thinking: { type: "disabled" }, output_config: { effort: "max" } }).selection.thinkingEffort,
      "off",
    );
    assert.equal(resolveModelSelection("quick-fast", { output_config: { effort: "max" } }).selection.thinkingEffort, "off");

    // 2) docker-compose.yml must not declare `env_file:` + >200KB 100-account .env loads cleanly via loadDotEnv()
    const composeText = readFileSync(path.resolve(process.cwd(), "docker-compose.yml"), "utf8");
    assert.ok(!/^\s*env_file\s*:/m.test(composeText), "docker-compose.yml must rely on mounted .env volume, not env_file");
    assert.ok(composeText.includes("./.env:/app/.env"));

    const bigEnvDir = mkdtempSync(path.join(os.tmpdir(), "aws-quick-bigenv-"));
    try {
      const tokens100 = Array.from({ length: 100 }, (_, i) =>
        serializeOAuthCredential({
          accessToken: `at-${i}-${"a".repeat(600)}`,
          refreshToken: `rt-${i}-${"b".repeat(600)}`,
          clientId: `cid-${i}`,
          clientSecret: `cs-${i}-${"c".repeat(200)}`,
          expiresAt: Date.now() + 3_600_000,
          wsHost: "api.us-east-1.quick.aws.com",
          region: "us-east-1",
          issuerUrl: "https://oidc.us-east-1.amazonaws.com",
        }),
      );
      const envPath = path.join(bigEnvDir, ".env");
      const envContent = `QUICK_TOKENS=${tokens100.join(",")}\n`;
      assert.ok(Buffer.byteLength(envContent, "utf8") > 200_000, "test .env should exceed Linux 128KB single-env limit");
      writeFileSync(envPath, envContent, "utf8");
      const { loadDotEnv } = await import("../src/core/config.js");
      const origQuickTokens = process.env.QUICK_TOKENS;
      delete process.env.QUICK_TOKENS;
      try {
        loadDotEnv(envPath);
        const parsedCfg = loadConfigFromEnv(process.env, envPath);
        assert.equal(parsedCfg.quickTokens.length, 100);
      } finally {
        if (origQuickTokens === undefined) delete process.env.QUICK_TOKENS;
        else process.env.QUICK_TOKENS = origQuickTokens;
      }
    } finally {
      rmSync(bigEnvDir, { recursive: true, force: true });
    }

    // 4) Wire-level mock WS: verify Anthropic quick-smart-max + adaptive sends thinking_effort="max",
    //    dynamic 80% rotation based on upstream `context_window` (e.g. 165K / 200K = 82.5% rotates even < 800K),
    //    trailing all-zero `turn_usage` frame NEVER wipes out real usage metrics, and traceLogger records contextPercent.
    {
      const { QuickExecutionEngine } = await import("../src/core/engine.js");
      const { RequestTraceLogger } = await import("../src/services/request-logger.js");
      const { UsageTracker } = await import("../src/services/usage-tracker.js");
      const { WebSocketServer, WebSocket: WsClient } = await import("ws");
      const sendCloudOut = (sock: import("ws").WebSocket, ev: Record<string, unknown>) => {
        const b64 = Buffer.from(JSON.stringify(ev), "utf8").toString("base64");
        sock.send(
          encodeEventStream(
            { ":event-type": "rawOutputEvent", ":content-type": "application/json", ":message-type": "event" },
            Buffer.from(JSON.stringify({ payload: b64 }), "utf8"),
          ),
        );
      };
      const seenPayloads: Array<Record<string, unknown>> = [];
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>((resolve) => wss.once("listening", resolve));
      const wsPort = (wss.address() as { port: number }).port;
      wss.on("connection", (sock) => {
        sendCloudOut(sock, { type: "connected", payload: { user: { email: "mock@example.com" } } });
        sock.on("message", (raw) => {
          const outer = JSON.parse(raw.toString("utf8")) as { payload?: { payload?: string } };
          if (!outer.payload?.payload) return;
          const inner = JSON.parse(Buffer.from(outer.payload.payload, "base64").toString("utf8")) as {
            type?: string;
            payload?: Record<string, unknown>;
          };
          if (inner.type === "session_connect") {
            sendCloudOut(sock, { type: "session_established", payload: {} });
          } else if (inner.type === "user_message") {
            seenPayloads.push(inner.payload || {});
            const tid = String(inner.payload?.thread_id || "t1");
            sendCloudOut(sock, { type: "text_delta", thread_id: tid, payload: { delta: "Rotated cleanly." } });
            sendCloudOut(sock, {
              type: "turn_usage",
              thread_id: tid,
              payload: {
                input_tokens: 15_000,
                output_tokens: 5_000,
                cache_read_tokens: 145_000,
                cache_write_tokens: 0,
                total_tokens: 165_000,
                context_window: 200_000,
                resolved_model_id: "us.anthropic.claude-opus-5-5",
              },
            });
            // Trailing all-zero turn_usage frame must be ignored and never wipe out real metrics
            sendCloudOut(sock, {
              type: "turn_usage",
              thread_id: tid,
              payload: {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                total_tokens: 0,
                context_window: 200_000,
                resolved_model_id: "us.anthropic.claude-opus-5-5",
              },
            });
            sendCloudOut(sock, { type: "message_complete", thread_id: tid, payload: {} });
          }
        });
      });

      const cfg = loadConfigFromEnv({
        QUICK_TOKENS: serializeOAuthCredential({
          accessToken: "mock-at",
          refreshToken: "mock-rt",
          clientId: "mock-cid-800k",
          clientSecret: "mock-cs",
          expiresAt: Date.now() + 3_600_000,
          wsHost: "api.us-east-1.quick.aws.com",
          region: "us-east-1",
          issuerUrl: "https://oidc.us-east-1.amazonaws.com",
        }),
        INCOGNITO: "true",
        AUTO_ENSURE_CODING_AGENT: "false",
      });
      const pool = new UpstreamKeyPool(cfg);
      const logger = new RequestTraceLogger(20);
      const engine = new QuickExecutionEngine({
        config: cfg,
        usageTracker: new UsageTracker(),
        webSocketFactory: () => new WsClient(`ws://127.0.0.1:${wsPort}`),
      });
      try {
        const anthTurn = parseAnthropicMessagesRequest({
          model: "quick-smart-max",
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          messages: [{ role: "user", content: "Test max effort + dynamic 80% context_window rotation" }],
        });
        const traceId = logger.startTrace("anthropic-messages", anthTurn);
        let lastUsageMetrics: import("../src/core/types.js").TurnTokenMetrics | undefined;
        for await (const ev of engine.executeTurnWithPool(anthTurn, pool)) {
          if (ev.type === "usage") {
            lastUsageMetrics = ev.metrics;
            logger.recordUsage(traceId, ev.metrics);
          }
        }
        assert.equal(seenPayloads.length, 1);
        assert.equal(seenPayloads[0]?.thinking_effort, "max", "quick-smart-max + adaptive must send thinking_effort=max on wire");
        assert.equal(lastUsageMetrics?.totalTokens, 165_000, "trailing all-zero turn_usage must not overwrite real usage");
        assert.equal(lastUsageMetrics?.contextWindow, 200_000);
        assert.equal(lastUsageMetrics?.contextPercent, 82.5);
        assert.equal(logger.getDetail(traceId)?.metrics?.contextPercent, 82.5);
        assert.equal(logger.listSummaries(5)[0]?.metrics?.contextPercent, 82.5);
        assert.equal(engine.runtimeStats().warmIdleSessions, 0, "warm thread >= 80% of real context_window must NOT be parked");
        assert.equal(engine.runtimeStats().warmIncrementalSessions, 0, "warm thread >= 80% of real context_window must rotate on next turn");
        const dashHtml = renderDashboardHtml("/dashboard", "n");
        assert.ok(dashHtml.includes("上游上下文水位"));
        assert.ok(dashHtml.includes('tr("水位 ", "Ctx ")'));
        assert.ok(dashHtml.includes('tr(" · 换线程", " · Rotate")'));
      } finally {
        await engine.disposeAll();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    }

    // 3) Anthropic context usage anti-shrinkage floor & explicit /compact reset
    const convKey = `issue11-monotonic-${Date.now()}`;
    const mkTurn = (estimatedInputTokens: number) => ({
      ...parseAnthropicMessagesRequest({ model: "quick-smart", max_tokens: 128, messages: [{ role: "user", content: "hi" }] }),
      conversationKey: convKey,
      estimatedInputTokens,
    });

    // Turn 1: upstream reports higher AWS total (42,400 >= 10,000) -> pass through accurately
    const u1 = stabilizeAnthropicUsage(
      { inputTokens: 400, outputTokens: 200, cacheReadTokens: 42_000, cacheWriteTokens: 0 },
      mkTurn(10_000),
    );
    assert.equal(u1.input_tokens + u1.cache_read_input_tokens + u1.cache_creation_input_tokens, 42_400);

    // Turn 2: client grew (+18,000), but upstream dipped to 1,900 (e.g. .txt attachment / failover) -> must NOT shrink
    const u2 = stabilizeAnthropicUsage(
      { inputTokens: 900, outputTokens: 150, cacheReadTokens: 1_000, cacheWriteTokens: 0 },
      mkTurn(28_000),
    );
    assert.equal(u2.input_tokens + u2.cache_read_input_tokens + u2.cache_creation_input_tokens, 60_400);

    // Turn 3: upstream catches up to 80,500 -> report exact real upstream total
    const u3 = stabilizeAnthropicUsage(
      { inputTokens: 500, outputTokens: 180, cacheReadTokens: 80_000, cacheWriteTokens: 0 },
      mkTurn(32_000),
    );
    assert.equal(u3.input_tokens + u3.cache_read_input_tokens + u3.cache_creation_input_tokens, 80_500);

    // Turn 4: client ran `/compact` (estimated dropped from 32,000 to 6,000, >15% drop) -> watermark resets cleanly
    const u4 = stabilizeAnthropicUsage(
      { inputTokens: 200, outputTokens: 100, cacheReadTokens: 15_000, cacheWriteTokens: 0 },
      mkTurn(6_000),
    );
    assert.equal(u4.input_tokens + u4.cache_read_input_tokens + u4.cache_creation_input_tokens, 15_200);
  });

  it("reassembles S2C _chunked_frame, aggregates multi-step cloud tool turn_usage, sends native stop_generation on abort, and aligns wire fields", async () => {
    // 1) ChunkedFrameAssembler: out-of-order reassembly + _transport preservation
    const assembler = new ChunkedFrameAssembler();
    const bigPayload = JSON.stringify({ type: "tree_sync", payload: { active_branch_id: "branch-abc123", root_session_id: "root-xyz" } });
    const mid = Math.floor(bigPayload.length / 2);
    assert.equal(
      assembler.push({ type: "_chunked_frame", chunk_id: "c1", chunk_index: 1, total_chunks: 2, data: bigPayload.slice(mid), _transport: { sequence: "42" } }),
      null,
    );
    const reassembled = assembler.push({ type: "_chunked_frame", chunk_id: "c1", chunk_index: 0, total_chunks: 2, data: bigPayload.slice(0, mid) });
    assert.deepEqual(reassembled, {
      type: "tree_sync",
      payload: { active_branch_id: "branch-abc123", root_session_id: "root-xyz" },
      _transport: { sequence: "42" },
    });

    // 2) Mock WS replay: multi-step cloud tool (`file_read_image`) with 2x turn_usage, thinking_start/complete, tree_sync,
    //    and wire verification (traceparent, thinking_effort="off" on fast, web_search_enabled=false with client tools)
    const { WebSocketServer, WebSocket: WsClient } = await import("ws");
    const { QuickExecutionEngine } = await import("../src/core/engine.js");
    const { UsageTracker } = await import("../src/services/usage-tracker.js");

    const seenFrames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let stopGenerationSeen: Record<string, unknown> | null = null;
    let scenario: "multistep" | "abort" = "multistep";

    const sendCloud = (ws: import("ws").WebSocket, obj: Record<string, unknown>) => {
      const esPayload = new TextEncoder().encode(
        JSON.stringify({ payload: Buffer.from(JSON.stringify(obj), "utf8").toString("base64") }),
      );
      ws.send(encodeEventStream({ ":event-type": "rawOutputEvent", ":message-type": "event" }, esPayload));
    };

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const addr = wss.address();
    const wsPort = typeof addr === "object" && addr ? addr.port : 0;

    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const outer = JSON.parse(raw.toString("utf8")) as { payload?: { payload?: string } };
        const inner = JSON.parse(Buffer.from(outer.payload?.payload || "", "base64").toString("utf8")) as {
          type: string;
          payload?: Record<string, unknown>;
        };
        seenFrames.push({ type: inner.type, payload: inner.payload || {} });
        if (inner.type === "session_connect") {
          sendCloud(ws, { type: "session_established", workingSessionId: "ws-proto-1" });
          sendCloud(ws, { type: "connected", payload: { user: { email: "proto@example.com" } }, _transport: { version: 1, sequence: "1" } });
          return;
        }
        if (inner.type === "stop_generation") {
          stopGenerationSeen = inner.payload || {};
          sendCloud(ws, { type: "message_complete", payload: { text: "", initiator: "user" }, message_id: String(inner.payload?.message_id || ""), thread_id: String(inner.payload?.thread_id || "") });
          return;
        }
        if (inner.type !== "user_message") return;
        const tid = String(inner.payload?.thread_id || "t-proto");
        if (scenario === "multistep") {
          sendCloud(ws, { type: "message_start", message_id: "msg-asst-01", thread_id: tid, payload: { role: "assistant" }, _transport: { sequence: "2" } });
          sendCloud(ws, { type: "thinking_start", turn_message_id: "msg-asst-01", thread_id: tid, payload: {}, _transport: { sequence: "3" } });
          sendCloud(ws, { type: "thinking_delta", turn_message_id: "msg-asst-01", thread_id: tid, payload: { delta: "checking image" }, _transport: { sequence: "4" } });
          sendCloud(ws, { type: "thinking_complete", turn_message_id: "msg-asst-01", thread_id: tid, payload: { thinking: "checking image" }, _transport: { sequence: "5" } });
          sendCloud(ws, { type: "tool_start", turn_message_id: "msg-asst-01", thread_id: tid, payload: { tool_id: "tu_1", tool_name: "file_read_image" }, _transport: { sequence: "6" } });
          sendCloud(ws, {
            type: "turn_usage",
            turn_message_id: "msg-asst-01",
            thread_id: tid,
            payload: { input_tokens: 4, output_tokens: 200, cache_read_tokens: 35_000, cache_write_tokens: 40_000, total_tokens: 75_204, context_window: 1_000_000, resolved_model_id: "us.anthropic.claude-haiku-5-5" },
            _transport: { sequence: "7" },
          });
          sendCloud(ws, { type: "tool_result", turn_message_id: "msg-asst-01", thread_id: tid, payload: { tool_id: "tu_1", tool_name: "file_read_image", status: "complete" }, _transport: { sequence: "8" } });
          sendCloud(ws, { type: "text_delta", turn_message_id: "msg-asst-01", thread_id: tid, payload: { delta: "Done reading." }, _transport: { sequence: "9" } });
          sendCloud(ws, {
            type: "turn_usage",
            turn_message_id: "msg-asst-01",
            thread_id: tid,
            payload: { input_tokens: 2, output_tokens: 300, cache_read_tokens: 75_000, cache_write_tokens: 1_000, total_tokens: 76_302, context_window: 1_000_000, resolved_model_id: "us.anthropic.claude-haiku-5-5" },
            _transport: { sequence: "10" },
          });
          sendCloud(ws, { type: "message_complete", turn_message_id: "msg-asst-01", thread_id: tid, payload: { text: "Done reading." }, _transport: { sequence: "11" } });
        } else if (scenario === "abort") {
          sendCloud(ws, { type: "message_start", message_id: "msg-abort-99", thread_id: tid, payload: { role: "assistant" }, _transport: { sequence: "20" } });
          sendCloud(ws, { type: "thinking_delta", turn_message_id: "msg-abort-99", thread_id: tid, payload: { delta: "long thinking..." }, _transport: { sequence: "21" } });
        }
      });
    });

    const oauthKey = serializeOAuthCredential({
      region: "us-east-1",
      issuerUrl: "https://identitycenter.amazonaws.com/ssoins-proto",
      wsHost: "qbs-cell-proto.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
      clientId: "cid_proto_test",
      clientSecret: "csec_proto_test",
      refreshToken: "aor_proto_v1",
      accessToken: "aoa_proto_valid",
      expiresAt: Date.now() + 3_600_000,
    });
    const cfg = loadConfigFromEnv({ QUICK_TOKENS: oauthKey, AUTO_ENSURE_CODING_AGENT: "false" });
    const pool = new UpstreamKeyPool(cfg);
    const usageTracker = new UsageTracker();
    const engine = new QuickExecutionEngine({
      config: cfg,
      usageTracker,
      webSocketFactory: () => new WsClient(`ws://127.0.0.1:${wsPort}`),
    });

    try {
      // Scenario A: multi-step cloud tool turn with client tools on quick-fast
      const turnFast = parseAnthropicMessagesRequest({
        model: "quick-fast",
        max_tokens: 256,
        tools: [{ name: "Read", description: "Read file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
        messages: [{ role: "user", content: "Inspect image" }],
      });
      const eventsA: Array<import("../src/core/types.js").GatewayStreamEvent> = [];
      for await (const ev of engine.executeTurnWithPool(turnFast, pool)) {
        eventsA.push(ev);
      }
      const usageEvents = eventsA.filter((e) => e.type === "usage");
      assert.equal(usageEvents.length, 1, "multi-step turn_usage must be aggregated and emitted ONCE");
      if (usageEvents[0]?.type === "usage") {
        assert.equal(usageEvents[0].metrics.outputTokens, 500, "outputTokens must sum across internal cloud tool steps (200+300)");
        assert.equal(usageEvents[0].metrics.totalTokens, 76_302);
      }
      assert.equal(usageTracker.snapshot().totals.outputTokens, 500, "UsageTracker must not double-count multi-step turns");

      const userMsgFrame = seenFrames.find((f) => f.type === "user_message");
      assert.ok(userMsgFrame);
      assert.match(String(userMsgFrame.payload.traceparent || ""), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      assert.equal(userMsgFrame.payload.thinking_effort, "off", "fast mode must explicitly send thinking_effort='off'");
      assert.equal(userMsgFrame.payload.web_search_enabled, false, "web_search_enabled must default false when client tools are present");

      // Scenario B: client abort sends native `stop_generation` with assistant message_id and throws 499
      scenario = "abort";
      const abortCtrl = new AbortController();
      const turnAbort = parseAnthropicMessagesRequest(
        { model: "quick-smart", max_tokens: 256, messages: [{ role: "user", content: "Abort test" }] },
        {},
        abortCtrl.signal,
      );
      let caughtAbort: unknown;
      try {
        for await (const ev of engine.executeTurnWithPool(turnAbort, pool)) {
          if (ev.type === "thinking") {
            abortCtrl.abort();
          }
        }
      } catch (e) {
        caughtAbort = e;
      }
      assert.equal((caughtAbort as { status?: number })?.status, 499, "mid-stream abort must throw 499 client_aborted");
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(stopGenerationSeen, "upstream must receive native stop_generation frame on client abort");
      assert.equal((stopGenerationSeen as Record<string, unknown>).message_id, "msg-abort-99");
    } finally {
      pool.dispose();
      await engine.disposeAll();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("persists rotated OAuth refresh_token and preserves metadata/affinity across restart, hardens tool-bridge lexer, and fixes OpenAI usage/incomplete status", async () => {
    // 1) OAuth refresh_token rotation persistence + Web in-place renewal slotId stability
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "aq2a-rot-"));
    try {
      const envPath = path.join(tmpDir, ".env");
      const origOAuth = serializeOAuthCredential({
        region: "us-east-1",
        issuerUrl: "https://identitycenter.amazonaws.com/ssoins-rot",
        wsHost: "qbs-cell-rot.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
        clientId: "cid_rotate_1",
        clientSecret: "csec_rotate_1",
        refreshToken: "aor_rot_v1",
        accessToken: "aoa_rot_v1",
        expiresAt: Date.now() + 3_600_000,
      });
      writeFileSync(envPath, `QUICK_TOKENS=${origOAuth}\n`, "utf8");
      const cfg1 = loadConfigFromEnv({ QUICK_TOKENS: origOAuth }, envPath);
      const pool1 = new UpstreamKeyPool(cfg1);
      const slotBefore = pool1.statusSnapshot()[0]!;
      pool1.updateSlotMeta(slotBefore.slotId, { label: "Prod-US", chatAgentId: "agent-custom-1" });
      const lease = pool1.leaseKey("quick-smart", undefined, "conv-sticky-1");
      lease.release();

      const rotated = pool1.rotateOAuthRefreshToken("cid_rotate_1", "aor_rot_v2", "aoa_rot_v2", Date.now() + 7_200_000);
      assert.equal(rotated, true);
      pool1.dispose();

      // Reload from disk simulating process restart (`.env` still has old `aor_rot_v1`, `pool-state.json` holds `aor_rot_v2`)
      const cfg2 = loadConfigFromEnv({ QUICK_TOKENS: origOAuth }, envPath);
      const pool2 = new UpstreamKeyPool(cfg2);
      const slotAfter = pool2.statusSnapshot()[0]!;
      const reloadedCred = parseOAuthCredential(pool2.allManagedKeys()[0]!.rawKey);
      assert.equal(pool2.allManagedKeys().length, 1, "old .env token must NOT be re-imported after rotation");
      assert.equal(reloadedCred?.refreshToken, "aor_rot_v2", "rotated refreshToken must survive restart");
      assert.equal(slotAfter.label, "Prod-US", "slot label must survive refreshToken rotation");
      assert.equal(slotAfter.chatAgentId, "agent-custom-1", "slot chatAgentId must survive refreshToken rotation");
      pool2.dispose();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // 2) Tool-bridge: literal `</tool_call>` inside JSON string arg + fenced code block after real call
    const allowed = new Set(["Edit", "Read"]);
    const tricky = [
      "Updating file:",
      '<tool_call>{"name":"Edit","arguments":{"file":"tool-bridge.ts","content":"const close = \\"</tool_call>\\";"}}</tool_call>',
      "\nExample in docs:\n```xml\n<tool_call>{\"name\":\"Read\",\"arguments\":{\"path\":\"/etc/hosts\"}}</tool_call>\n```",
    ].join("\n");
    const filter = new StreamingToolCallFilter(allowed);
    let streamed = "";
    for (let i = 0; i < tricky.length; i += 7) {
      streamed += filter.feed(tricky.slice(i, i + 7));
    }
    const flushed = filter.flush();
    assert.equal(flushed.toolCalls.length, 1, "fenced code block after real tool_call must NOT execute as a second tool call");
    assert.equal(flushed.toolCalls[0]!.name, "Edit");
    assert.equal(flushed.toolCalls[0]!.argsObject.content, 'const close = "</tool_call>";');
    assert.ok((streamed + flushed.remainingText).includes("```xml"));

    // 3) OpenAI usage includes cacheWriteTokens & Responses API honors stopReason="length" -> status="incomplete"
    const { openAiChatAdapter } = await import("../src/protocols/openai.js");
    const oaiTurn = parseChatCompletionsRequest({ model: "quick-balanced", messages: [{ role: "user", content: "hi" }] });
    async function* mockLengthStream(): AsyncGenerator<import("../src/core/types.js").GatewayStreamEvent> {
      yield { type: "text", text: "partial output" };
      yield { type: "usage", metrics: { inputTokens: 4, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 74_000 } };
      yield { type: "done", stopReason: "length" };
    }
    const chatJson = (await openAiChatAdapter.collectJson(mockLengthStream(), oaiTurn)) as {
      usage: { prompt_tokens: number; total_tokens: number };
    };
    assert.equal(chatJson.usage.prompt_tokens, 74_004, "OpenAI prompt_tokens must include cacheWriteTokens");
    assert.equal(chatJson.usage.total_tokens, 74_104);

    const respTurn = parseResponsesRequest({ model: "quick-balanced", input: "hi" });
    const respJson = (await openAiResponsesAdapter.collectJson(mockLengthStream(), respTurn)) as {
      status: string;
      incomplete_details?: { reason: string };
      usage: { input_tokens: number };
    };
    assert.equal(respJson.status, "incomplete");
    assert.equal(respJson.incomplete_details?.reason, "max_output_tokens");
    assert.equal(respJson.usage.input_tokens, 74_004);

    // 4) RequestAttachmentCache dedup + 504 failover classification
    const { RequestAttachmentCache } = await import("../src/core/request-attachment-cache.js");
    const attCache = new RequestAttachmentCache();
    let uploadCalls = 0;
    const buf = Buffer.from("same-bytes");
    const up = async () => {
      uploadCalls += 1;
      return { type: "file" as const, name: "a.txt", size: buf.length, mimeType: "text/plain", path: "/p/a.txt", attachmentId: "att-1", contentSha256: "abc" };
    };
    await attCache.getOrUploadAttachment("slot1", "th1", buf, up);
    await attCache.getOrUploadAttachment("slot1", "th1", buf, up);
    assert.equal(uploadCalls, 1, "RequestAttachmentCache must deduplicate identical uploads on same slot+thread");

    const cls504 = classifyUpstreamError(new GatewayError("AWS Quick stream timed out", 504, "timeout_error"));
    assert.equal(cls504.isProxyOrConnErr, true, "504 timeout_error must be eligible for cross-account failover");
  });

  it("extracted WarmSessionPool & buildOutboundChatFrame preserve park/lookup/evict and wire parity", async () => {
    const { WarmSessionPool } = await import("../src/core/warm-session-pool.js");
    const { buildOutboundChatFrame } = await import("../src/core/turn-frame-builder.js");
    const { WebSocketServer, WebSocket: WsClient } = await import("ws");

    // 1) WarmSessionPool park -> lookup -> evict -> dispose lifecycle
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as { port: number }).port;
    const pool = new WarmSessionPool({ maxWarmSessions: 10, warmSessionTtlMs: 60_000 });
    try {
      const ws1 = new WsClient(`ws://127.0.0.1:${port}`);
      const ws2 = new WsClient(`ws://127.0.0.1:${port}`);
      await Promise.all([
        new Promise<void>((resolve) => ws1.once("open", resolve)),
        new Promise<void>((resolve) => ws2.once("open", resolve)),
      ]);
      assert.equal(
        pool.park({
          scope: "anthropic",
          conversationKey: "conv-1",
          slotId: "slot-a",
          isIncognito: true,
          chatAgentId: "agent-1",
          prefixHashes: ["hash-1", "hash-1-alt"],
          threadId: "th-1",
          rootThreadId: "root-1",
          ws: ws1,
          outpostId: "op-1",
          encodeFrame: (f) => JSON.stringify(f),
          apiKey: "dummy-key",
          lastAckSeq: "7",
        }),
        true,
      );
      assert.equal(pool.countParkedWsForSlot("slot-a"), 1);
      assert.equal(pool.stats().warmIdleSessions, 1);

      // Lookup hits by alternate hash and hands back the live WS
      const hit = pool.lookup("anthropic", "conv-1", "slot-a", true, "hash-1-alt", "agent-1");
      assert.ok(hit, "WarmSessionPool.lookup should hit alternate prefix hash");
      assert.equal(hit.threadId, "th-1");
      assert.equal(hit.rootThreadId, "root-1");
      assert.equal(hit.reusedOutpostId, "op-1");
      assert.equal(hit.reusedWs, ws1);
      assert.equal(pool.countParkedWsForSlot("slot-a"), 0);

      // Park ws2 and verify explicit eviction closes it cleanly
      pool.park({
        scope: "anthropic",
        conversationKey: "conv-2",
        slotId: "slot-a",
        isIncognito: false,
        prefixHashes: ["hash-2"],
        threadId: "th-2",
        rootThreadId: "th-2",
        ws: ws2,
        outpostId: "op-1",
        encodeFrame: (f) => JSON.stringify(f),
        apiKey: "dummy-key",
      });
      assert.equal(pool.evictParkedWsForSlot("slot-a", 1), 1);
      assert.equal(pool.countParkedWsForSlot("slot-a"), 0);
      ws1.close();
    } finally {
      pool.disposeAll();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }

    // 2) buildOutboundChatFrame parity: user_message vs edit_message
    const sampleTurn = parseChatCompletionsRequest({
      model: "quick-fast",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: {} } } }],
    });
    const fastUserFrame = buildOutboundChatFrame({
      chunkText: "hello",
      msgId: "msg-12345678",
      isFinal: true,
      isInternalRephraseCall: false,
      webSearchEnabled: true,
      turn: sampleTurn,
      agentMode: "fast",
      thinkingEffort: "off",
      chatAgentId: "agent-xyz",
      effectiveCustomPrompt: "Use tools",
      attachments: [],
      surfaceType: "QUICK_WORK_DESKTOP_MAC",
      outpostId: "op-1",
      appVersion: "1.2.4757",
      surfaceName: "desktop",
      threadId: "th-a",
      isIncognito: true,
    });
    assert.equal(fastUserFrame.type, "user_message");
    const uPayload = fastUserFrame.payload as Record<string, unknown>;
    assert.equal(uPayload.thinking_effort, "off", "fast mode must explicitly send thinking_effort=off");
    assert.equal(uPayload.web_search_enabled, false, "client tools present must suppress cloud web_search_enabled");
    assert.equal(uPayload.acp_first_text, 1, "user_message should include DESKTOP_CAPABILITIES");
    assert.equal(uPayload.incognito, true);
    assert.match(String(uPayload.traceparent), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const editFrame = buildOutboundChatFrame({
      chunkText: "rephrased hello",
      msgId: "msg-87654321",
      isFinal: true,
      isInternalRephraseCall: false,
      webSearchEnabled: true,
      turn: sampleTurn,
      agentMode: "smart",
      thinkingEffort: "high",
      chatAgentId: "agent-xyz",
      effectiveCustomPrompt: "Use tools",
      attachments: [],
      surfaceType: "QUICK_WORK_DESKTOP_MAC",
      outpostId: "op-1",
      appVersion: "1.2.4757",
      surfaceName: "desktop",
      threadId: "th-a",
      isIncognito: true,
      editBranch: {
        originalMessageId: "msg-12345678",
        rootSessionId: "root-a",
        threadId: "th-a",
      },
    });
    assert.equal(editFrame.type, "edit_message");
    const ePayload = editFrame.payload as Record<string, unknown>;
    assert.equal(ePayload.original_message_id, "msg-12345678");
    assert.equal(ePayload.root_session_id, "root-a");
    assert.equal("incognito" in ePayload, false, "edit_message must NOT leak incognito");
    assert.equal("acp_first_text" in ePayload, false, "edit_message must NOT leak session capabilities");
    assert.equal(ePayload.coding_agent_setup_card, 0, "edit_message in incognito carries coding_agent_setup_card=0");
  });

  it("turn-stream-runner handles runIdleTimeoutMs, mid-chunk disconnect, and turn_aborted partial finalization", async () => {
    const { runTurnStream } = await import("../src/core/turn-stream-runner.js");
    const { WarmSessionPool } = await import("../src/core/warm-session-pool.js");
    const { UsageTracker } = await import("../src/services/usage-tracker.js");
    const { StreamingUiTagSanitizer } = await import("../src/core/ui-tag-sanitizer.js");
    const { decodeCloudOutputFrame, encodeCloudInputFrame } = await import("../src/aws-quick/event-stream-cbor.js");
    const { WebSocketServer, WebSocket: WsClient } = await import("ws");

    const sendCloudOut = (sock: import("ws").WebSocket, ev: Record<string, unknown>) => {
      const b64 = Buffer.from(JSON.stringify(ev), "utf8").toString("base64");
      sock.send(
        encodeEventStream(
          { ":event-type": "rawOutputEvent", ":content-type": "application/json", ":message-type": "event" },
          Buffer.from(JSON.stringify({ payload: b64 }), "utf8"),
        ),
      );
    };

    type Scenario = "idle_timeout" | "mid_chunk_disconnect" | "turn_aborted_partial";
    let activeScenario: Scenario = "idle_timeout";
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as { port: number }).port;

    wss.on("connection", (sock) => {
      sock.on("message", (raw) => {
        let inner: { type?: string; payload?: Record<string, unknown> } | undefined;
        try {
          const outer = JSON.parse(raw.toString("utf8")) as { payload?: { payload?: string } };
          if (outer.payload?.payload) {
            inner = JSON.parse(Buffer.from(outer.payload.payload, "base64").toString("utf8"));
          }
        } catch {
          return;
        }
        if (!inner) return;
        if (inner.type === "session_connect") {
          sendCloudOut(sock, { type: "session_established", payload: {} });
          return;
        }
        if (inner.type === "user_message") {
          const tid = String(inner.payload?.thread_id || "th-edge");
          if (activeScenario === "idle_timeout") {
            // Emit one delta then go completely silent to trigger runIdleTimeoutMs
            sendCloudOut(sock, { type: "text_delta", thread_id: tid, payload: { delta: "Hello" } });
          } else if (activeScenario === "mid_chunk_disconnect") {
            // Upstream terminates during chunk 1/2 before chunk 2 is sent
            sendCloudOut(sock, { type: "stream_ended", thread_id: tid, payload: {} });
          } else if (activeScenario === "turn_aborted_partial") {
            // Emit partial text + usage, then upstream sends turn_aborted
            sendCloudOut(sock, { type: "text_delta", thread_id: tid, payload: { delta: "Partial answer..." } });
            sendCloudOut(sock, {
              type: "turn_usage",
              thread_id: tid,
              payload: { input_tokens: 120, output_tokens: 18, total_tokens: 138, context_window: 200_000 },
            });
            sendCloudOut(sock, { type: "turn_aborted", thread_id: tid, payload: {} });
          }
        }
      });
    });

    const baseTurn = parseChatCompletionsRequest({
      model: "quick-balanced",
      messages: [{ role: "user", content: "edge case test" }],
    });

    const runScenario = async (scenario: Scenario, overrides?: { chunks?: string[]; runIdleTimeoutMs?: number }) => {
      activeScenario = scenario;
      const ws = new WsClient(`ws://127.0.0.1:${port}`);
      const warmPool = new WarmSessionPool({ maxWarmSessions: 4, warmSessionTtlMs: 60_000 });
      const events: import("../src/core/types.js").GatewayStreamEvent[] = [];
      let caught: unknown;
      try {
        for await (const ev of runTurnStream({
          ws,
          isReusedOpenWs: false,
          encodeFrame: encodeCloudInputFrame,
          decodeFrame: decodeCloudOutputFrame,
          isWeb: false,
          surfaceType: "QUICK_WORK_DESKTOP_MAC",
          appVersion: "1.2.4757",
          surfaceName: "desktop",
          outpostId: "op-edge",
          turn: { ...baseTurn, currentInputPrefixHash: "hash-edge-1" },
          apiKey: "dummy-key",
          slotId: "slot-edge",
          execMode: "incognito",
          selection: { model: "quick-balanced", agentMode: "balanced", thinkingEffort: "medium" },
          isIncognito: true,
          isWarmIncremental: false,
          isInternalHelperCall: false,
          threadId: `th-${scenario}`,
          effectiveRootThreadId: `th-${scenario}`,
          chunks: overrides?.chunks || ["edge case test"],
          effectiveCustomPrompt: null,
          attachments: [],
          rawPromptForRephrase: "edge case test",
          toolFilter: null,
          uiTagSanitizer: new StreamingUiTagSanitizer(),
          runMaxTimeoutMs: 5_000,
          runIdleTimeoutMs: overrides?.runIdleTimeoutMs ?? 0,
          showRoutedModelInThinking: false,
          webSearchEnabled: false,
          usageTracker: new UsageTracker(),
          warmPool,
        })) {
          events.push(ev);
        }
      } catch (err) {
        caught = err;
      } finally {
        const stats = warmPool.stats();
        warmPool.disposeAll();
        return { events, caught, stats };
      }
    };

    try {
      // 1) runIdleTimeoutMs triggers 504 timeout_error after upstream goes silent mid-stream
      const r1 = await runScenario("idle_timeout", { runIdleTimeoutMs: 120 });
      assert.ok(r1.caught instanceof GatewayError, "idle timeout must throw GatewayError");
      assert.equal(r1.caught.status, 504);
      assert.equal(r1.caught.code, "timeout_error");
      assert.match(r1.caught.message, /idle timed out/i);

      // 2) Multi-chunk mid-upload disconnect raises 502 upstream_error instead of finalizing early
      const r2 = await runScenario("mid_chunk_disconnect", { chunks: ["chunk-1-body", "chunk-2-body"] });
      assert.ok(r2.caught instanceof GatewayError, "mid-chunk disconnect must throw GatewayError");
      assert.equal(r2.caught.status, 502);
      assert.equal(r2.caught.code, "upstream_error");
      assert.match(r2.caught.message, /mid-chunk upload/i);

      // 3) turn_aborted after partial text gracefully finalizes (emits text + usage + done) and does NOT park WS
      const r3 = await runScenario("turn_aborted_partial");
      assert.equal(r3.caught, undefined, "turn_aborted with partial text should finalize cleanly without throwing");
      const textOut = r3.events.filter((e) => e.type === "text").map((e) => e.text).join("");
      assert.equal(textOut, "Partial answer...");
      assert.ok(r3.events.some((e) => e.type === "usage" && e.metrics.outputTokens === 18));
      assert.ok(r3.events.some((e) => e.type === "done" && e.stopReason === "stop"));
      assert.equal(r3.stats.warmIdleSessions, 0, "turn_aborted must NEVER park the WS for reuse");
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("hardens Codex/Claude protocols, 6-file multi-turn, UI sanitizer, SSE error/usage parity, and 100-account pool resilience", async () => {
    // 1) Codex CLI shell_call / shell_call_output / apply_patch_call / compaction & namespaced custom schema
    const codexTurn = parseResponsesRequest({
      model: "quick-balanced",
      tools: [
        { type: "shell" },
        { type: "apply_patch" },
        { type: "namespace", name: "mcp__patch", tools: [{ type: "custom", name: "edit_raw", description: "raw edit" }] },
      ],
      input: [
        { role: "user", content: "list files" },
        { type: "shell_call", call_id: "call_sh_1", action: { commands: ["ls -la"] } },
        { type: "shell_call_output", call_id: "call_sh_1", output: [{ stdout: "README.md\n", stderr: "", outcome: { type: "exit", exit_code: 0 } }] },
        { type: "apply_patch_call", call_id: "call_ap_1", operation: { type: "update_file", path: "a.txt" } },
        { type: "apply_patch_call_output", call_id: "call_ap_1", status: "completed" },
        { type: "compaction", summary: "Prior repo overview" },
        { type: "mcp_list_tools" },
      ],
    });
    assert.equal(codexTurn.tools.find((t) => t.name === "shell")?.toolKind, "shell");
    assert.equal(codexTurn.tools.find((t) => t.name === "apply_patch")?.toolKind, "custom");
    assert.deepEqual(
      codexTurn.tools.find((t) => t.name === "mcp__patch__edit_raw")?.inputSchema,
      { type: "object", properties: { input: { type: "string", description: "Raw tool input text payload" } }, required: ["input"] },
    );
    assert.ok(codexTurn.fullTranscriptText.includes("README.md"));
    assert.ok(codexTurn.fullTranscriptText.includes("Prior repo overview"));

    // Custom tool raw-string arguments recovery (Codex apply_patch)
    const rawPatchParsed = parseToolCallsFromText(
      `<tool_call>{"name":"apply_patch","arguments":"*** Begin Patch\\n*** End Patch"}</tool_call>`,
      new Set(["apply_patch"]),
      new Set(["apply_patch"]),
    );
    assert.equal(rawPatchParsed.toolCalls.length, 1);
    assert.equal(rawPatchParsed.toolCalls[0]?.argsObject.input, "*** Begin Patch\n*** End Patch");

    // 2) Claude Code tool_search_tool_result, output_config.format 400, image-only tool_result, CJK count_tokens & model-scoped watermark
    const ccTurn = parseAnthropicMessagesRequest({
      model: "quick-balanced",
      max_tokens: 64,
      tools: [
        { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
        { name: "Read", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      ],
      messages: [
        { role: "user", content: "find tools" },
        { role: "assistant", content: [{ type: "server_tool_use", id: "srv_1", name: "tool_search_tool_regex", input: { query: "git" } }] },
        { role: "user", content: [{ type: "tool_search_tool_result", tool_use_id: "srv_1", content: { type: "tool_search_tool_search_result", tool_references: [] } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "screen.png" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }] },
      ],
    });
    assert.equal(ccTurn.tools.length, 1, "server built-in tool_search_tool_regex must not become a fake custom tool");
    assert.ok(ccTurn.incrementalUserText?.includes("[Image attached (1)]"), "image-only tool_result must not say [empty]");
    assert.throws(
      () =>
        parseAnthropicMessagesRequest({
          model: "quick-balanced",
          max_tokens: 64,
          output_config: { format: { type: "json_schema", schema: { type: "object" } } },
          messages: [{ role: "user", content: "hi" }],
        }),
      (e: unknown) => e instanceof GatewayError && e.status === 400 && e.code === "unsupported_parameter",
    );
    const cjkText = "这是一个用于测试中文上下文估算准确性的句子。".repeat(200);
    assert.ok(estimateAnthropicTokens({ messages: [{ role: "user", content: cjkText }] }) > 2000);
    const wmSid = `wm-iso-${Date.now()}`;
    const sonnetTurn = parseAnthropicMessagesRequest(
      { model: "quick-balanced", max_tokens: 64, messages: [{ role: "user", content: "a".repeat(20_000) }] },
      { "x-session-id": wmSid },
    );
    stabilizeAnthropicUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60_000, cacheWriteTokens: 0 }, sonnetTurn);
    const haikuSide = parseAnthropicMessagesRequest(
      { model: "quick-fast", max_tokens: 32, messages: [{ role: "user", content: "3-word title" }] },
      { "x-session-id": wmSid },
    );
    stabilizeAnthropicUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, haikuSide);
    const sonnetNext = stabilizeAnthropicUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5_000, cacheWriteTokens: 0 }, sonnetTurn);
    assert.ok(
      sonnetNext.input_tokens + sonnetNext.cache_read_input_tokens >= 60_100,
      "Haiku side-call on same x-session-id must NOT wipe Sonnet watermark",
    );

    // 3) 6 cumulative PDFs -> Turn 3 plain text keeps incrementalFiles=[] instead of undefined
    const tinyPdfB64 = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");
    const mkPdf = (n: number) => ({ type: "document", title: `f_${n}.pdf`, source: { type: "base64", media_type: "application/pdf", data: tinyPdfB64 } });
    const sixPdfTurn = parseAnthropicMessagesRequest({
      model: "quick-fast",
      max_tokens: 32,
      messages: [
        { role: "user", content: [mkPdf(1), mkPdf(2), mkPdf(3), { type: "text", text: "t1" }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: [mkPdf(4), mkPdf(5), mkPdf(6), { type: "text", text: "t2" }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "t3 plain text" },
      ],
    });
    assert.equal(sixPdfTurn.files?.length, 6);
    assert.deepEqual(sixPdfTurn.incrementalFiles, []);

    // 4) UI tag sanitizer: indented fence split & `>` inside quoted attribute
    const sanFence = new StreamingUiTagSanitizer();
    const fenceOut = sanFence.feed("Example:\n  ") + sanFence.feed('```\n<artifact type="image" src="https://example.com/a.png"/>\n```\n') + sanFence.flush();
    assert.ok(!fenceOut.includes("![image]"), "indented fenced code block must not be corrupted across chunk boundary");
    const sanGt = new StreamingUiTagSanitizer();
    const gtStreamed = sanGt.feed('<artifact title="A -> B" type="image" src="https://example.com/a.png"/> hello world') + sanGt.flush();
    assert.ok(gtStreamed.includes("hello world") && gtStreamed.includes("https://example.com/a.png"));

    // 5) OpenAI Chat include_usage fallback & Responses SSE response.failed with sequence_number
    const chatTurn = parseChatCompletionsRequest({
      model: "quick-balanced",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    });
    const chatChunks: string[] = [];
    for await (const c of openAiChatAdapter.streamSse(
      (async function* () {
        yield { type: "text" as const, text: "hello" };
        yield { type: "done" as const, stopReason: "stop" as const };
      })(),
      chatTurn,
    )) {
      chatChunks.push(c);
    }
    const parsedChatChunks = chatChunks
      .filter((s) => s.startsWith("data: {"))
      .map((s) => JSON.parse(s.slice(6)) as Record<string, unknown>);
    assert.equal(parsedChatChunks[0]?.usage, null, "include_usage=true must set usage:null on intermediate chunks");
    assert.ok(parsedChatChunks.some((c) => c.usage && typeof c.usage === "object"), "include_usage=true must emit fallback usage chunk even if turn_usage omitted");

    const respTurn = parseResponsesRequest({ model: "quick-balanced", stream: true, input: "hi" });
    const respSse: string[] = [];
    for await (const frame of openAiResponsesAdapter.streamSse(
      (async function* () {
        yield { type: "text" as const, text: "partial" };
        throw new GatewayError("upstream hiccup", 502, "upstream_error");
      })(),
      respTurn,
    )) {
      respSse.push(frame);
    }
    assert.ok(respSse.some((f) => f.includes("event: response.failed")), "Responses SSE must emit response.failed on mid-stream error");
    const errFrame = respSse.find((f) => f.includes("event: error"));
    assert.ok(errFrame && errFrame.includes('"sequence_number":'), "Responses SSE error frame must include sequence_number");

    // 6) Model catalog case-insensitive bracket & advanced-off clamp; AbortError -> 499; 405 officialErrorType
    assert.equal(resolveModelSelection("quick-smart[Effort=max]", {}).selection.thinkingEffort, "max");
    assert.equal(resolveModelSelection("quick-advanced-off", {}).selection.thinkingEffort, "high");
    const abortMapped = mapAttachmentUploadError(new DOMException("This operation was aborted", "AbortError"), "upload");
    assert.equal(abortMapped.status, 499);
    assert.equal(abortMapped.code, "client_aborted");

    // 7) 100-account resilience: proxy-agent does not destroy live agents at 70+, slotWaiters wakes immediately on last-slot disable, 429 burst dedup
    const agent1 = getProxyAgent("http://127.0.0.1:19001")!;
    let destroyed1 = false;
    const origDestroy = agent1.destroy.bind(agent1);
    agent1.destroy = (...args: Parameters<typeof origDestroy>) => {
      destroyed1 = true;
      return origDestroy(...args);
    };
    for (let i = 2; i <= 75; i++) getProxyAgent(`http://127.0.0.1:${19000 + i}`);
    assert.equal(destroyed1, false, "proxy agent cache must NOT destroy active agents at 75 distinct proxies");

    const pool = new UpstreamKeyPool({
      quickTokens: ["acct-single-1"],
      disabledQuickTokens: [],
      keyLabels: {},
      keyAutoDisabled: {},
      keyProxies: {},
      keyChatAgentIds: {},
      keyAddedAt: {},
      lbStrategy: "quota-aware",
      sessionAffinityEnabled: true,
      sessionAffinityTtlMs: 60_000,
      autoDisableExhaustedKeys: true,
      incognitoMode: true,
      keyCooldownMs: 30_000,
      maxInflightPerSlot: 1,
      envFilePath: "",
    });
    const l1 = await pool.leaseKeyWithWait("quick-balanced", undefined, undefined, { maxWaitMs: 1000 });
    const t0 = Date.now();
    const waitErrPromise = pool
      .leaseKeyWithWait("quick-balanced", undefined, undefined, { maxWaitMs: 1500 })
      .catch((e) => e as unknown);
    await new Promise((r) => setTimeout(r, 40));
    pool.reportQuotaExhausted("acct-single-1", "auto", "5h limit");
    l1.release();
    const waitErr = await waitErrPromise;
    const waitedMs = Date.now() - t0;
    assert.ok(waitErr instanceof GatewayError, "waiter should fail with GatewayError");
    assert.equal(waitErr.status, 503);
    assert.ok(waitedMs < 500, `slotWaiter must wake immediately when last slot disables (waited ${waitedMs}ms)`);
    assert.ok((waitErr.retryAfter ?? 0) >= 60, "5h quota-disabled pool must surface dynamic retryAfter");

    const burstPool = new UpstreamKeyPool({
      quickTokens: ["acct-burst-1"],
      disabledQuickTokens: [],
      keyLabels: {},
      keyAutoDisabled: {},
      keyProxies: {},
      keyChatAgentIds: {},
      keyAddedAt: {},
      lbStrategy: "quota-aware",
      sessionAffinityEnabled: false,
      sessionAffinityTtlMs: 60_000,
      autoDisableExhaustedKeys: true,
      incognitoMode: true,
      keyCooldownMs: 30_000,
      maxInflightPerSlot: 4,
      envFilePath: "",
    });
    const burstNow = Date.now();
    for (let i = 0; i < 4; i++) burstPool.reportRateLimit("acct-burst-1");
    const burstErr = await burstPool.leaseKeyWithWait("quick-balanced", undefined, undefined, { maxWaitMs: 100 }).catch((e) => e as unknown);
    assert.ok(burstErr instanceof GatewayError, "burstPool should fail with GatewayError");
    assert.equal(burstErr.status, 429);
    assert.ok(
      (burstErr.retryAfter ?? 0) >= 20 && (burstErr.retryAfter ?? 0) <= 45,
      `4 simultaneous 429s must deduplicate to 1x (~30s) backoff, got retryAfter=${burstErr.retryAfter}s (elapsed ${Date.now() - burstNow}ms)`,
    );
  });

  it("splits runtime state into data/pool-state.json with debounced async atomic writes, read-only .env safety, and smart .env merge", async () => {
    const fs = await import("node:fs");
    const { ModelAccessController } = await import("../src/services/model-access.js");
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "aq2a-pool-state-"));
    const dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const envPath = path.join(tmpDir, ".env");
    const k1 = "ws1.example.com|tok_seed_1";
    const k2 = "ws2.example.com|tok_seed_2";
    const k3 = "ws3.example.com|tok_manual_new_3";
    const initialEnv = `QUICK_TOKENS=${k1},${k2}\nINCOGNITO=true\nDISABLED_MODELS=quick-advanced\n`;
    writeFileSync(envPath, initialEnv, "utf8");
    // Simulate read-only Docker bind mount (`./.env:/app/.env:ro` or `0644 root:root`)
    fs.chmodSync(envPath, 0o444);

    try {
      // 1) First boot: auto-migrates from read-only `.env` into `data/pool-state.json` without touching `.env`
      const cfg1 = loadConfigFromEnv(
        { QUICK_TOKENS: `${k1},${k2}`, INCOGNITO: "true", DISABLED_MODELS: "quick-advanced", DATA_DIR: dataDir },
        envPath,
      );
      const pool1 = new UpstreamKeyPool(cfg1);
      assert.equal(pool1.allManagedKeys().length, 2);
      assert.equal(readFileSync(envPath, "utf8"), initialEnv, "read-only .env must never be modified");
      assert.ok(fs.existsSync(path.join(dataDir, "pool-state.json")), "pool-state.json must be created on migration");

      // 2) Debounced async write coalescing: 100 rapid additions coalesce into <= 2 disk writes (not 100!)
      const writesBefore = pool1.getPoolStateWriteCount();
      for (let i = 0; i < 100; i++) {
        pool1.addKey(`ws-batch-${i}.example.com|tok_batch_${i}`, true, `Batch-${i}`);
      }
      await pool1.flushStateAsync();
      const writesAfter = pool1.getPoolStateWriteCount();
      assert.ok(writesAfter - writesBefore <= 2, `100 rapid mutations must coalesce (got ${writesAfter - writesBefore} writes)`);

      // Delete k1 (from `.env` seed) and toggle setting
      const k1Slot = pool1.allManagedKeys().find((k) => k.rawKey === k1)!;
      pool1.removeKey(k1Slot.slotId);
      pool1.updateSettings({ incognitoMode: false });
      pool1.dispose();

      // 3) Restart with `.env` STILL containing deleted k1 + a BRAND NEW manually added k3:
      //    k1 stays deleted, all 100 console-added keys + k2 survive, AND brand-new k3 auto-imports!
      const cfg2 = loadConfigFromEnv(
        { QUICK_TOKENS: `${k1},${k2},${k3}`, INCOGNITO: "true", DATA_DIR: dataDir },
        envPath,
      );
      const pool2 = new UpstreamKeyPool(cfg2);
      const keys2 = pool2.allManagedKeys().map((k) => k.rawKey);
      assert.ok(!keys2.includes(k1), "deleted .env-seeded key must stay deleted across restart");
      assert.ok(keys2.includes(k2), "retained .env key must survive");
      assert.ok(keys2.includes(k3), "brand-new manually added .env key must auto-import on restart");
      assert.equal(keys2.length, 102, "100 console keys + k2 + new k3 = 102");
      assert.equal(pool2.getSettings().incognitoMode, false, "runtime setting from pool-state.json must survive restart");
      pool2.dispose();

      // 4) ModelAccessController & AdminAuthManager also persist inside `dataDir` with read-only `.env`
      const ma1 = new ModelAccessController({ disabledModels: ["quick-advanced"], envFilePath: envPath, dataDir });
      ma1.applyBatchUpdate({ action: "disable", models: ["quick-fast"] });
      const ma2 = new ModelAccessController({ disabledModels: ["quick-advanced"], envFilePath: envPath, dataDir });
      assert.deepEqual(ma2.disabledSnapshot(), ["quick-advanced", "quick-fast"]);

      const auth1 = new AdminAuthManager({ adminPassword: undefined, envFilePath: envPath, dataDir });
      auth1.setupInitialPassword("StrongPass123!");
      const auth2 = new AdminAuthManager({ adminPassword: undefined, envFilePath: envPath, dataDir });
      assert.equal(auth2.isPasswordConfigured(), true);
      assert.ok(auth2.verifyPasswordAndIssueSession("StrongPass123!").token.startsWith("adm_"));
    } finally {
      try { fs.chmodSync(envPath, 0o600); } catch { }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("defers flushEarly timer until OOB upload finishes and resets timer across account failovers", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "aws-quick-flush-oob-"));
    const cfg = loadConfigFromEnv({
      HOST: "127.0.0.1",
      PORT: "0",
      GATEWAY_TOKEN: "sk-aq-test-real-token-9876543210",
      QUICK_TOKENS: "example.aws.dev|eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig",
      DATA_DIR: tmpDir,
      ENV_FILE_PATH: path.join(tmpDir, ".env"),
      ENABLE_DASHBOARD: "false",
    });
    const gw = createGatewayServer({ config: cfg, flushEarlyDelayMs: 60 });
    let scenario: "oob_429" | "failover_reset_502" | "slow_inference_ok" = "oob_429";

    (gw.engine as unknown as { executeTurnWithPool: typeof gw.engine.executeTurnWithPool }).executeTurnWithPool =
      async function* (_turn, _pool, onExecMeta) {
        if (scenario === "oob_429") {
          // OOB upload starts: flushEarlyReady=false keeps timer disarmed even if upload exceeds 60ms threshold
          onExecMeta?.({ slotId: "slot-1", maskedKey: "oauth:s1***", execMode: "incognito", flushEarlyReady: false });
          await new Promise((r) => setTimeout(r, 110));
          throw new GatewayError("OOB upload throttled (429)", 429, "rate_limit_exceeded", undefined, 12);
        }
        if (scenario === "failover_reset_502") {
          // Attempt 0 finishes OOB + arms 60ms timer, then fails over at 35ms to Attempt 1 (disarming timer)
          onExecMeta?.({ slotId: "slot-1", maskedKey: "oauth:s1***", execMode: "incognito", flushEarlyReady: true });
          await new Promise((r) => setTimeout(r, 35));
          // Attempt 1 begins OOB upload -> disarms Attempt 0's timer so >60ms total elapsed still returns real HTTP 502!
          onExecMeta?.({ slotId: "slot-2", maskedKey: "oauth:s2***", execMode: "incognito", flushEarlyReady: false });
          await new Promise((r) => setTimeout(r, 90));
          throw new GatewayError("Attempt 1 OOB upload failed (502)", 502, "upstream_error");
        }
        // Slow inference AFTER OOB completes (`flushEarlyReady: true`): >60ms commits HTTP 200 `: keepalive` then streams
        onExecMeta?.({ slotId: "slot-1", maskedKey: "oauth:s1***", execMode: "incognito", flushEarlyReady: false });
        await new Promise((r) => setTimeout(r, 20));
        onExecMeta?.({ slotId: "slot-1", maskedKey: "oauth:s1***", execMode: "incognito", flushEarlyReady: true });
        await new Promise((r) => setTimeout(r, 100));
        yield { type: "text", text: "Completed after keepalive." };
        yield { type: "done", stopReason: "stop" };
      };

    await new Promise<void>((resolve) => gw.server.listen(0, "127.0.0.1", resolve));
    const addr = gw.server.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const sendReq = () =>
        fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": "sk-aq-test-real-token-9876543210",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "quick-balanced",
            max_tokens: 128,
            stream: true,
            tools: [{ name: "Read", description: "Read", input_schema: { type: "object", properties: {} } }],
            messages: [{ role: "user", content: "big context" }],
          }),
        });

      // 1) Slow OOB upload (>60ms) failing with 429 must return real HTTP 429 JSON + Retry-After: 12
      scenario = "oob_429";
      const r1 = await sendReq();
      assert.equal(r1.status, 429, "slow OOB upload 429 must NOT be swallowed into HTTP 200 SSE");
      assert.equal(r1.headers.get("retry-after"), "12");
      assert.ok((r1.headers.get("content-type") || "").includes("application/json"));

      // 2) Failover cancels Attempt 0's 60ms timer so Attempt 1's 90ms OOB upload failing with 502 stays real HTTP 502
      scenario = "failover_reset_502";
      const r2 = await sendReq();
      assert.equal(r2.status, 502, "Attempt 0 flushEarly timer must be cancelled on failover to Attempt 1");
      assert.ok((r2.headers.get("content-type") || "").includes("application/json"));

      // 3) Once armed (`flushEarlyReady: true`), >60ms slow inference emits `: keepalive` on HTTP 200 and streams normally
      scenario = "slow_inference_ok";
      const r3 = await sendReq();
      assert.equal(r3.status, 200);
      const body3 = await r3.text();
      assert.ok(body3.includes(": keepalive\n\n"), "armed flushEarly must emit : keepalive before slow first token");
      assert.ok(body3.includes("Completed after keepalive."));
    } finally {
      await gw.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("zero-account-loss defense: mirrors structural edits to writable .env, skips high-frequency quota churn, and fail-fast probes dataDir", async () => {
    const fs = await import("node:fs");
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "aq2a-zero-loss-"));
    const dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const envPath = path.join(tmpDir, ".env");
    const oauthInitial = serializeOAuthCredential({
      region: "us-east-1",
      issuerUrl: "https://oidc.us-east-1.amazonaws.com",
      wsHost: "us-east-1.quick.aws.com",
      clientId: "cid-zero-loss",
      clientSecret: "csec-zero-loss",
      refreshToken: "rt-old-1",
      accessToken: "at-1",
      expiresAt: Date.now() + 3600_000,
      email: "a@example.com",
    });
    const kSeed = "ws-seed.example.com|tok_seed";
    const kConsole = "ws-console.example.com|tok_console_added";
    writeFileSync(envPath, `QUICK_TOKENS=${kSeed},${oauthInitial}\nINCOGNITO=true\n`, "utf8");

    try {
      const cfg1 = loadConfigFromEnv(
        { QUICK_TOKENS: `${kSeed},${oauthInitial}`, INCOGNITO: "true", DATA_DIR: dataDir },
        envPath,
      );
      const pool1 = new UpstreamKeyPool(cfg1);

      // Structural edits: add a new account in Web Console + rotate OAuth refresh token
      pool1.addKey(kConsole, true, "ConsoleAdded");
      const rotated = pool1.rotateOAuthRefreshToken("cid-zero-loss", "rt-rotated-2", "at-2", Date.now() + 7200_000);
      assert.equal(rotated, true);
      await pool1.flushStateAsync();

      const mirrorsAfterStructural = pool1.getEnvMirrorWriteCount();
      assert.ok(mirrorsAfterStructural >= 1, "structural edits must mirror to writable .env");

      // High-frequency runtime churn (quota exhaustion) must persist to pool-state.json WITHOUT hammering .env
      const poolWritesBeforeQuota = pool1.getPoolStateWriteCount();
      pool1.reportQuotaExhausted(kSeed, "quick-smart", "Usage limit reached");
      await pool1.flushStateAsync();
      assert.ok(pool1.getPoolStateWriteCount() > poolWritesBeforeQuota, "quota trip must persist to pool-state.json");
      assert.equal(
        pool1.getEnvMirrorWriteCount(),
        mirrorsAfterStructural,
        "high-frequency quota churn must NOT rewrite .env",
      );
      pool1.dispose();

      // Simulate Edge Case 1 (unmounted `/app/data` wiped on container recreate) AND Edge Case 3 (downgrade to `.env`-only):
      // Delete `data/pool-state.json` completely and reload strictly from `.env`!
      rmSync(path.join(dataDir, "pool-state.json"), { force: true });
      const envLines = Object.fromEntries(
        readFileSync(envPath, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
          .map((l) => {
            const idx = l.indexOf("=");
            return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
          }),
      );
      const cfgRecovered = loadConfigFromEnv({ ...envLines, DATA_DIR: dataDir }, envPath);
      const poolRecovered = new UpstreamKeyPool(cfgRecovered);
      const recoveredKeys = poolRecovered.allManagedKeys().map((k) => k.rawKey);
      assert.ok(recoveredKeys.includes(kSeed), "seed key must survive");
      assert.ok(recoveredKeys.includes(kConsole), "console-added key must survive even if data/ was wiped or downgraded");
      assert.ok(
        recoveredKeys.some((k) => k.startsWith("oauth:") && parseOAuthCredential(k)?.refreshToken === "rt-rotated-2"),
        "rotated OAuth refresh token must survive in .env even if data/ was wiped or downgraded",
      );
      poolRecovered.dispose();

      // Simulate Edge Case 2 (Docker host `./data` owned by root:root 0755 -> EACCES):
      // `assertDataDirWritable` must fail fast instead of silently swallowing writes.
      const roDir = path.join(tmpDir, "ro-data");
      fs.mkdirSync(roDir, { recursive: true });
      fs.chmodSync(roDir, 0o555);
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      if (!isRoot) {
        assert.throws(
          () => assertDataDirWritable(roDir),
          (err: unknown) => (err as NodeJS.ErrnoException)?.code === "EACCES",
          "assertDataDirWritable must throw EACCES immediately on non-writable dataDir",
        );
      }
      fs.chmodSync(roDir, 0o700);
      assert.doesNotThrow(() => assertDataDirWritable(roDir));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Web self-update (Option A): safe tar-gz, SHA-256 + depsHash gates, real bootstrap hot-restart & crash auto-rollback", async () => {
    const fs = await import("node:fs");
    const crypto = await import("node:crypto");
    const zlib = await import("node:zlib");
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "aq2a-self-update-"));
    const dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    try {
      // 1) Pure-Node tar-gz safety: long USTAR paths round-trip; traversal & symlinks rejected
      const longRel = "dist/src/sub/" + "a".repeat(60) + "/" + "b".repeat(50) + ".js";
      const okGz = createTarGzBuffer([
        { path: "package.json", content: Buffer.from('{"version":"9.9.9"}\n') },
        { path: longRel, content: Buffer.from("export const ok = true;\n") },
      ]);
      const extractDir = path.join(tmpDir, "extract-ok");
      const files = extractTarGzSafely(okGz, extractDir);
      assert.deepEqual(files, ["package.json", longRel]);
      assert.equal(readFileSync(path.join(extractDir, longRel), "utf8"), "export const ok = true;\n");

      // Craft malicious symlink tar entry and verify strict rejection
      const evilHeader = Buffer.alloc(512, 0);
      evilHeader.write("dist/src/evil.js", 0, 100, "utf8");
      evilHeader.write("0000777\0", 100, 8, "ascii");
      evilHeader.write("0000000\0", 108, 8, "ascii");
      evilHeader.write("0000000\0", 116, 8, "ascii");
      evilHeader.write("00000000000\0", 124, 12, "ascii");
      evilHeader.write("00000000000\0", 136, 12, "ascii");
      evilHeader.fill(0x20, 148, 156);
      evilHeader.write("2", 156, 1, "ascii"); // symlink!
      evilHeader.write("ustar\0", 257, 6, "ascii");
      evilHeader.write("00", 263, 2, "ascii");
      let chk = 0;
      for (let i = 0; i < 512; i += 1) chk += evilHeader[i]!;
      evilHeader.write(chk.toString(8).padStart(6, "0"), 148, 6, "ascii");
      evilHeader[154] = 0;
      evilHeader[155] = 0x20;
      const evilGz = zlib.gzipSync(Buffer.concat([evilHeader, Buffer.alloc(1024, 0)]));
      assert.throws(() => extractTarGzSafely(evilGz, path.join(tmpDir, "extract-evil")), /Unsupported tar entry type/);

      // Untrusted download host rejected (anti-SSRF / anti-RCE)
      assert.throws(() => assertAllowedDownloadUrl("https://evil.example.com/bundle.tar.gz"), /untrusted host/i);
      assert.doesNotThrow(() =>
        assertAllowedDownloadUrl("https://github.com/kuk-888/aws-quick2api/releases/download/v0.1.21/aws-quick2api-dist-v0.1.21.tar.gz"),
      );

      // 2) Self-update gates: checksum mismatch, depsHash mismatch, DISABLE_SELF_UPDATE, and happy-path + rollback
      const builtin = readBuiltinRuntimeInfo();
      const buildMockBundle = (ver: string, depsHash: string) => {
        const gz = createTarGzBuffer([
          {
            path: "update-manifest.json",
            content: Buffer.from(
              JSON.stringify({ version: ver, depsHash, nodeMinMajor: 22, builtAt: new Date().toISOString(), entry: "dist/src/server.js" }),
            ),
          },
          { path: "package.json", content: Buffer.from(JSON.stringify({ version: ver, type: "module" })) },
          { path: "dist/src/server.js", content: Buffer.from("console.log('mock server');\n") },
        ]);
        const sha = crypto.createHash("sha256").update(gz).digest("hex");
        return { gz, sha, name: `aws-quick2api-dist-v${ver}.tar.gz` };
      };

      const makeMockFetcher = (bundleBytes: Buffer, sumsText: string): typeof fetch =>
        (async (input: string | URL | Request) => {
          const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (u.endsWith("SHA256SUMS.txt")) return new Response(sumsText, { status: 200 });
          return new Response(new Uint8Array(bundleBytes), { status: 200 });
        }) as typeof fetch;

      const supEnv = { ...process.env, AWS_QUICK_SUPERVISED: "1", DISABLE_SELF_UPDATE: "" };
      const good = buildMockBundle("9.9.9", builtin.depsHash);
      const baseInfo = {
        currentVersion: builtin.version,
        latestVersion: "9.9.9",
        hasUpdate: true,
        repo: "kuk-888/aws-quick2api",
        releaseUrl: "https://github.com/kuk-888/aws-quick2api/releases/tag/v9.9.9",
        releaseNotes: "test",
        checkedAt: new Date().toISOString(),
        bundleUrl: `https://github.com/kuk-888/aws-quick2api/releases/download/v9.9.9/${good.name}`,
        checksumUrl: "https://github.com/kuk-888/aws-quick2api/releases/download/v9.9.9/SHA256SUMS.txt",
        bundleAssetName: good.name,
      };

      // 2a) DISABLE_SELF_UPDATE=true blocks apply
      await assert.rejects(
        () =>
          applySelfUpdate({
            dataDir,
            env: { ...supEnv, DISABLE_SELF_UPDATE: "true" },
            versionInfo: baseInfo,
            fetcher: makeMockFetcher(good.gz, `${good.sha}  ${good.name}\n`),
          }),
        /disabled/i,
      );

      // 2b) SHA-256 mismatch aborts update
      await assert.rejects(
        () =>
          applySelfUpdate({
            dataDir,
            env: supEnv,
            versionInfo: baseInfo,
            fetcher: makeMockFetcher(good.gz, `${"0".repeat(64)}  ${good.name}\n`),
          }),
        /SHA-256 verification failed/i,
      );

      // 2c) Changed native/npm depsHash rejects hot-update with actionable Docker/source guidance
      const badDeps = buildMockBundle("9.9.9", computeRuntimeDepsHash({ dependencies: { sharp: "^9.0.0", ws: "^9.0.0" } }));
      await assert.rejects(
        () =>
          applySelfUpdate({
            dataDir,
            env: supEnv,
            versionInfo: baseInfo,
            fetcher: makeMockFetcher(badDeps.gz, `${badDeps.sha}  ${badDeps.name}\n`),
          }),
        /depsHash changed/i,
      );

      // 2d) Valid bundle installs, links host node_modules across tmpDir, activates pendingVersion, and rollback works
      const applied = await applySelfUpdate({
        dataDir,
        env: supEnv,
        versionInfo: baseInfo,
        fetcher: makeMockFetcher(good.gz, `${good.sha}  ${good.name}\n`),
      });
      assert.equal(applied.installedVersion, "9.9.9");
      assert.equal(applied.willRestart, true);
      assert.equal(loadSelfUpdateState(dataDir).pendingVersion, "9.9.9");
      assert.ok(fs.existsSync(path.join(releaseDirForVersion(dataDir, "9.9.9"), "node_modules", "ws")));
      assert.equal(getSelfUpdateCapability({ dataDir, env: supEnv }).canRollback, true);

      const rb = rollbackSelfUpdate({ dataDir, env: supEnv });
      assert.equal(rb.targetVersion, builtin.version);
      assert.equal(loadSelfUpdateState(dataDir).activeVersion, null);

      // 3) Real `runBootstrapSupervisor` child-process test: crash auto-rollback + hot-restart + promotion + ESM `ws` import
      const fakeRoot = path.join(tmpDir, "fake-app");
      const fakeData = path.join(tmpDir, "fake-data");
      fs.mkdirSync(path.join(fakeRoot, "dist", "src"), { recursive: true });
      fs.mkdirSync(fakeData, { recursive: true });
      const fakePkg = { version: "0.1.0", type: "module", dependencies: { ws: "^8.18.0" }, engines: { node: ">=22.0.0" } };
      writeFileSync(path.join(fakeRoot, "package.json"), JSON.stringify(fakePkg), "utf8");
      // Symlink real repo node_modules into fakeRoot so hot releases outside repo can resolve `import "ws"`
      fs.symlinkSync(path.join(builtin.appRoot, "node_modules"), path.join(fakeRoot, "node_modules"), "dir");
      const fakeDepsHash = computeRuntimeDepsHash(fakePkg);

      // Built-in v0.1.0: announces ready, then on IPC "do_hot_upgrade" exits with code 75
      writeFileSync(
        path.join(fakeRoot, "dist", "src", "server.js"),
        `process.send?.({ type: "gateway_ready", version: "0.1.0" });
process.on("message", (m) => {
  if (m && m.type === "trigger_restart") {
    process.send?.({ type: "self_update_restart" });
    process.exit(${EXIT_CODE_SELF_UPDATE_RESTART});
  }
});
setInterval(() => {}, 10_000);
`,
        "utf8",
      );

      // Crashing hot release v0.2.0: crashes immediately on boot
      const rel020 = releaseDirForVersion(fakeData, "0.2.0");
      fs.mkdirSync(path.join(rel020, "dist", "src"), { recursive: true });
      writeFileSync(
        path.join(rel020, "update-manifest.json"),
        JSON.stringify({ version: "0.2.0", depsHash: fakeDepsHash, nodeMinMajor: 22, builtAt: "", entry: "dist/src/server.js" }),
      );
      writeFileSync(path.join(rel020, "package.json"), JSON.stringify({ ...fakePkg, version: "0.2.0" }));
      writeFileSync(path.join(rel020, "dist", "src", "server.js"), `process.exit(1);\n`);

      // Healthy hot release v0.3.0: imports `ws` via symlinked node_modules and announces ready
      const rel030 = releaseDirForVersion(fakeData, "0.3.0");
      fs.mkdirSync(path.join(rel030, "dist", "src"), { recursive: true });
      writeFileSync(
        path.join(rel030, "update-manifest.json"),
        JSON.stringify({ version: "0.3.0", depsHash: fakeDepsHash, nodeMinMajor: 22, builtAt: "", entry: "dist/src/server.js" }),
      );
      writeFileSync(path.join(rel030, "package.json"), JSON.stringify({ ...fakePkg, version: "0.3.0" }));
      ensureReleaseNodeModulesLink(rel030, fakeRoot);
      writeFileSync(
        path.join(rel030, "dist", "src", "server.js"),
        `import WebSocket from "ws";
if (typeof WebSocket !== "function") process.exit(2);
process.send?.({ type: "gateway_ready", version: "0.3.0" });
setInterval(() => {}, 10_000);
`,
        "utf8",
      );

      // Start with broken v0.2.0 pending -> expect auto-rollback to built-in v0.1.0 -> trigger hot restart to v0.3.0 -> promote!
      saveSelfUpdateState(fakeData, {
        activeVersion: "0.2.0",
        previousVersion: null,
        pendingVersion: "0.2.0",
        failedVersions: [],
      });

      const spawnedVersions: string[] = [];
      const ac = new AbortController();
      const supPromise = runBootstrapSupervisor({
        dataDir: fakeData,
        builtinAppRoot: fakeRoot,
        healthyGraceMs: 60,
        signal: ac.signal,
        onSpawn: (target, child) => {
          spawnedVersions.push(`${target.kind}:${target.version}`);
          if (target.version === "0.1.0") {
            child.on("message", (msg: unknown) => {
              if ((msg as { type?: string })?.type === "gateway_ready") {
                // Verify auto-rollback recorded v0.2.0 failure, then stage v0.3.0 and trigger restart (code 75)
                const stAfterRb = loadSelfUpdateState(fakeData);
                assert.ok(stAfterRb.failedVersions.includes("0.2.0"), "crashing v0.2.0 must be recorded in failedVersions");
                assert.equal(stAfterRb.activeVersion, null, "auto-rollback must fall back to built-in");
                saveSelfUpdateState(fakeData, {
                  ...stAfterRb,
                  activeVersion: "0.3.0",
                  previousVersion: null,
                  pendingVersion: "0.3.0",
                });
                child.send({ type: "trigger_restart" });
              }
            });
          } else if (target.version === "0.3.0") {
            child.on("message", (msg: unknown) => {
              if ((msg as { type?: string })?.type === "gateway_ready") {
                setTimeout(() => ac.abort(), 160);
              }
            });
          }
        },
      });

      await supPromise;
      assert.deepEqual(spawnedVersions, ["hot:0.2.0", "builtin:0.1.0", "hot:0.3.0"]);
      const finalState = loadSelfUpdateState(fakeData);
      assert.equal(finalState.activeVersion, "0.3.0", "v0.3.0 must stay active");
      assert.equal(finalState.pendingVersion, null, "healthy v0.3.0 must be promoted after grace window");

      // 4) Newer built-in image (e.g. Docker pull to v0.4.0) automatically overrides older hot release v0.3.0
      writeFileSync(path.join(fakeRoot, "package.json"), JSON.stringify({ ...fakePkg, version: "0.4.0" }), "utf8");
      const bootAfterPull = resolveBootTarget({ dataDir: fakeData, builtinAppRoot: fakeRoot });
      assert.equal(bootAfterPull.kind, "builtin");
      assert.equal(bootAfterPull.version, "0.4.0");
      assert.equal(loadSelfUpdateState(fakeData).activeVersion, null);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps SANITIZE_CLIENT_SYSTEM_PROMPT opt-in (default false), deep-sanitizes IDE wrappers when enabled, and batch-upgrades legacy Quick2API Bridge agents without touching personal agents", async () => {
    const fs = await import("node:fs");
    const WebSocket = (await import("ws")).default;
    const { WebSocketServer } = await import("ws");
    const {
      deepSanitizeClientSystemPrompt,
      sanitizeClientSystemPromptForQuick,
    } = await import("../src/core/tool-bridge.js");
    const {
      DEFAULT_CODING_AGENT_DESCRIPTION,
      DEFAULT_CODING_AGENT_INSTRUCTIONS,
      DEFAULT_CODING_AGENT_NAME,
    } = await import("../src/core/engine.js");
    const decodeMockCloudIn = (buf: Buffer): Record<string, unknown> | null => {
      try {
        const outer = JSON.parse(buf.toString("utf8")) as { payload?: { payload?: string } };
        if (typeof outer?.payload?.payload === "string") {
          return JSON.parse(Buffer.from(outer.payload.payload, "base64").toString("utf8")) as Record<string, unknown>;
        }
      } catch {
        // ignore non-JSON frames
      }
      return null;
    };
    const encodeMockCloudOut = (ev: Record<string, unknown>): Uint8Array => {
      const b64 = Buffer.from(JSON.stringify(ev), "utf8").toString("base64");
      const payload = Buffer.from(JSON.stringify({ payload: b64 }), "utf8");
      return encodeEventStream({ ":event-type": "rawOutputEvent", ":message-type": "event" }, payload);
    };
    const { createGatewayServer } = await import("../src/server.js");
    const { renderDashboardHtml } = await import("../src/web/dashboard-ui.js");

    // 1) Default Coding Agent instructions must stay brand-free while carrying the trusted `<tool_call>` anchor
    assert.ok(!/quick2api|external api client/i.test(DEFAULT_CODING_AGENT_INSTRUCTIONS));
    assert.ok(DEFAULT_CODING_AGENT_INSTRUCTIONS.includes("<tool_call>"));

    // 2) Light sanitizer stays 100% passthrough when hasTools=false, and covers Antigravity/ZCode when hasTools=true
    const rawUserPersona = "You are a cautious Rust financial systems architect.\n<guidelines>\nUse 2-space indentation.\n</guidelines>";
    assert.equal(sanitizeClientSystemPromptForQuick(rawUserPersona, false), rawUserPersona);
    assert.equal(sanitizeClientSystemPromptForQuick(rawUserPersona, true), rawUserPersona);
    const rawAntigravity = "You are Antigravity, a powerful agentic AI assistant.\nWrite clean TypeScript.";
    assert.equal(sanitizeClientSystemPromptForQuick(rawAntigravity, false), rawAntigravity);
    assert.ok(!sanitizeClientSystemPromptForQuick(rawAntigravity, true).includes("You are Antigravity"));

    // 3) Opt-in deepSanitizeClientSystemPrompt strips IDE identity/anti-bypass boilerplate & unwraps <user_rules>/<RULE> while keeping business rules & custom user guidelines intact
    const heavyIdePrompt = [
      "x-anthropic-billing-header: cc_version=2.1.34; cc_entrypoint=cli",
      "<identity>\nYou are Antigravity, a powerful agentic AI assistant designed by the Google Deepmind team.\n</identity>",
      "<guidelines>\nNever defeat or bypass an access control, permission check, or sandbox.\nNever solve or bypass a CAPTCHA.\n</guidelines>",
      "<guidelines>\nAlways prefer async/await over raw Promise chains.\n</guidelines>",
      "<user_rules>\nThe following are user-defined rules that you MUST ALWAYS FOLLOW WITHOUT ANY EXCEPTION. These rules take precedence over any other instructions.\n<RULE[/workspace/AGENTS.md]>\nKeep functions under 60 lines and write unit tests.\n</RULE[/workspace/AGENTS.md]>\n</user_rules>",
      "<skills>\nIf a skill seems relevant to your current task, you MUST read its `SKILL.md` instructions before proceeding.\n- deploy-helper: Deploy build artifacts.\n</skills>",
      "<system-reminder>\nBranch: main\n</system-reminder>",
    ].join("\n\n");

    const deepCleaned = deepSanitizeClientSystemPrompt(heavyIdePrompt);
    assert.ok(!deepCleaned.includes("x-anthropic-billing-header"));
    assert.ok(!deepCleaned.includes("Antigravity"));
    assert.ok(!deepCleaned.includes("Google Deepmind"));
    assert.ok(!deepCleaned.includes("CAPTCHA"));
    assert.ok(!deepCleaned.includes("<identity>"));
    assert.ok(!deepCleaned.includes("<user_rules>"));
    assert.ok(!deepCleaned.includes("<RULE["));
    assert.ok(!deepCleaned.includes("WITHOUT ANY EXCEPTION"));
    assert.ok(!deepCleaned.includes("take precedence over any other instructions"));
    assert.ok(!deepCleaned.includes("<system-reminder>"));
    // Preserves 100% of actual user conventions, custom non-security guidelines, and skill entries!
    assert.ok(deepCleaned.includes("Always prefer async/await over raw Promise chains."));
    assert.ok(deepCleaned.includes("Keep functions under 60 lines and write unit tests."));
    assert.ok(deepCleaned.includes("### Rules (AGENTS.md)"));
    assert.ok(deepCleaned.includes("- deploy-helper: Deploy build artifacts."));
    assert.ok(deepCleaned.includes("[Context note]\nBranch: main\n[/Context note]"));

    // 4) End-to-end server verification:
    //    - Default `sanitizeClientSystemPrompt=false` preserves custom systemPrompt verbatim on plain chat
    //    - Toggling `sanitizeClientSystemPrompt=true` via `/v1/admin/settings` persists and deep-sanitizes outbound `custom_prompt`
    //    - `POST /v1/admin/keys/sync-agents` upgrades legacy `Quick2API Bridge` in-place to `Coding Assistant` without touching unrelated personal agents (`写作助手`)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aq2a-sanitize-sync-"));
    const envFile = path.join(tmpDir, ".env");
    const fakeOAuthKey =
      "oauth:" +
      Buffer.from(
        JSON.stringify({
          v: 1,
          region: "us-east-1",
          issuerUrl: "https://oidc.us-east-1.amazonaws.com",
          wsHost: "qbs-cell000.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
          clientId: "cid-sync-test",
          clientSecret: "csec-sync-test",
          refreshToken: "rtok-sync-test",
          accessToken: "atok-valid-sync-test",
          expiresAt: Date.now() + 3_600_000,
        }),
        "utf8",
      ).toString("base64url");

    const capturedChatFrames: Array<Record<string, unknown>> = [];
    const agentUpdates: Array<Record<string, unknown>> = [];
    let currentBridgeName = "Quick2API Bridge";
    let currentBridgePrompt = "You are a helpful AI assistant accessed via an external API client.";

    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.once("listening", r));
    const wsPort = (wss.address() as { port: number }).port;

    wss.on("connection", (sock) => {
      sock.send(encodeMockCloudOut({ type: "session_established", payload: { session_id: "s1" } }));
      sock.on("message", (raw) => {
        const frame = decodeMockCloudIn(Buffer.from(raw as Buffer));
        if (!frame) return;
        const fType = String(frame.type || "");
        const payload = (frame.payload || {}) as Record<string, unknown>;
        if (fType === "session_connect") {
          sock.send(encodeMockCloudOut({ type: "session_established", payload: { session_id: "s1" } }));
        } else if (fType === "get_chat_agents") {
          sock.send(
            encodeMockCloudOut({
              type: "chat_agents_updated",
              payload: {
                agents: [
                  { agentId: "arn:aws:quicksight:us-east-1:111:agent/SYSTEM", name: "AWS Quick", isSystemDefault: true },
                  {
                    agentId: "arn:aws:quicksight:us-east-1:111:agent/personal-writer-01",
                    name: "写作改写助手",
                    description: "个人写作助手",
                    systemPrompt: "你是一名写作助手。",
                  },
                  {
                    agentId: "arn:aws:quicksight:us-east-1:111:agent/legacy-bridge-99",
                    name: currentBridgeName,
                    description: "General software engineering and coding assistant.",
                    systemPrompt: currentBridgePrompt,
                  },
                ],
              },
            }),
          );
        } else if (fType === "create_agent_draft") {
          sock.send(
            encodeMockCloudOut({
              type: "agent_draft_created",
              payload: { agent_id: String(payload.agent_id || "new-agent-01") },
            }),
          );
        } else if (fType === "update_chat_agent_config") {
          agentUpdates.push(payload);
          if (typeof payload.name === "string") currentBridgeName = payload.name;
          if (typeof payload.instructions === "string") currentBridgePrompt = payload.instructions;
          sock.send(encodeMockCloudOut({ type: "agent_draft_saved", payload: { agent_id: payload.agent_id } }));
        } else if (fType === "publish_agent_draft") {
          sock.send(
            encodeMockCloudOut({
              type: "publish_agent_draft_success",
              payload: { agent_id: payload.agent_id },
            }),
          );
        } else if (fType === "user_message") {
          capturedChatFrames.push(payload);
          sock.send(encodeMockCloudOut({ type: "text_delta", payload: { delta: "OK" } }));
          sock.send(
            encodeMockCloudOut({
              type: "turn_usage",
              payload: { input_tokens: 10, output_tokens: 2, resolved_model_id: "us.anthropic.claude-opus-5-5" },
            }),
          );
          sock.send(encodeMockCloudOut({ type: "message_complete", payload: { text: "OK" } }));
        }
      });
    });

    fs.writeFileSync(envFile, `QUICK_TOKENS=${fakeOAuthKey}\n`, "utf8");
    const clientToken = "sk-aq-unit-sanitize-token-998877665544";
    const adminPass = "UnitAdminStrongPass_2026!";
    const cfg = loadConfigFromEnv(
      {
        HOST: "127.0.0.1",
        PORT: "0",
        GATEWAY_TOKEN: clientToken,
        ADMIN_PASSWORD: adminPass,
        QUICK_TOKENS: fakeOAuthKey,
        DATA_DIR: tmpDir,
      },
      envFile,
    );
    assert.equal(cfg.sanitizeClientSystemPrompt, false, "must default to false");

    const gw = createGatewayServer({ config: cfg });
    // Inject mock WS factory into engine for offline deterministic testing
    (gw.engine as unknown as { webSocketFactory: (url: string) => unknown }).webSocketFactory = () =>
      new WebSocket(`ws://127.0.0.1:${wsPort}`);

    // Initially bind the slot to the user's personal agent ("personal-writer-01") to verify sync-agents NEVER overwrites personal agents!
    const slotId = gw.keyPool.allManagedKeys()[0]!.slotId;
    gw.keyPool.updateSlotMeta(slotId, { chatAgentId: "personal-writer-01" });

    await new Promise<void>((r) => gw.server.listen({ host: "127.0.0.1", port: 0 }, r));
    const port = (gw.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // A) With default `sanitizeClientSystemPrompt=false`, plain chat passes user's `<identity>` through untouched!
      const resDefault = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": clientToken,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "quick-smart",
          max_tokens: 128,
          system: heavyIdePrompt,
          messages: [{ role: "user", content: "Ping" }],
        }),
      });
      assert.equal(resDefault.status, 200);
      assert.equal(capturedChatFrames.length, 1);
      const defaultCustomPrompt = String(capturedChatFrames[0]!.custom_prompt || "");
      assert.ok(
        defaultCustomPrompt.includes("<identity>\nYou are Antigravity"),
        "default OFF must NOT rewrite user systemPrompt on plain chat",
      );

      // Login to Admin API
      const loginRes = await fetch(`${base}/v1/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-csrf": "1" },
        body: JSON.stringify({ password: adminPass }),
      });
      assert.equal(loginRes.status, 200);
      const loginData = (await loginRes.json()) as { token: string };
      const adminHeaders = {
        "content-type": "application/json",
        "x-console-csrf": "1",
        authorization: `Bearer ${loginData.token}`,
      };

      // B) Toggle `sanitizeClientSystemPrompt: true` via `/v1/admin/settings`
      const setRes = await fetch(`${base}/v1/admin/settings`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ sanitizeClientSystemPrompt: true }),
      });
      assert.equal(setRes.status, 200);
      const setJson = (await setRes.json()) as { settings: { sanitizeClientSystemPrompt: boolean } };
      assert.equal(setJson.settings.sanitizeClientSystemPrompt, true);

      // Next request immediately deep-sanitizes `custom_prompt` while keeping business rules intact!
      const resOptIn = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": clientToken,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "quick-smart",
          max_tokens: 128,
          system: heavyIdePrompt,
          messages: [{ role: "user", content: "Ping 2" }],
        }),
      });
      assert.equal(resOptIn.status, 200);
      const sanitizedCustomPrompt = String(capturedChatFrames[1]!.custom_prompt || "");
      assert.ok(!sanitizedCustomPrompt.includes("Antigravity"));
      assert.ok(!sanitizedCustomPrompt.includes("WITHOUT ANY EXCEPTION"));
      assert.ok(sanitizedCustomPrompt.includes("Keep functions under 60 lines and write unit tests."));

      // C) Run `POST /v1/admin/keys/sync-agents`: upgrades `legacy-bridge-99` (`Quick2API Bridge` -> `Coding Assistant`)
      //    and NEVER modifies `personal-writer-01` (`写作改写助手`)!
      const syncRes1 = await fetch(`${base}/v1/admin/keys/sync-agents`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({}),
      });
      assert.equal(syncRes1.status, 200);
      const syncJson1 = (await syncRes1.json()) as {
        upgraded: number;
        created: number;
        unchanged: number;
        results: Array<{ agentId: string; action: string; previousName?: string }>;
      };
      assert.equal(syncJson1.upgraded, 1);
      assert.equal(syncJson1.created, 0);
      assert.equal(syncJson1.results[0]!.agentId, "legacy-bridge-99");
      assert.equal(syncJson1.results[0]!.previousName, "Quick2API Bridge");
      assert.equal(agentUpdates.length, 1);
      assert.equal(agentUpdates[0]!.agent_id, "legacy-bridge-99");
      assert.equal(agentUpdates[0]!.name, DEFAULT_CODING_AGENT_NAME);
      assert.equal(agentUpdates[0]!.description, DEFAULT_CODING_AGENT_DESCRIPTION);
      assert.equal(agentUpdates[0]!.instructions, DEFAULT_CODING_AGENT_INSTRUCTIONS);

      // Re-running `sync-agents` immediately detects it is already up-to-date (`unchanged: 1`, 0 extra WS publishes)
      const syncRes2 = await fetch(`${base}/v1/admin/keys/sync-agents`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({}),
      });
      const syncJson2 = (await syncRes2.json()) as { upgraded: number; unchanged: number };
      assert.equal(syncJson2.upgraded, 0);
      assert.equal(syncJson2.unchanged, 1);
      assert.equal(agentUpdates.length, 1);

      // D) Dashboard HTML renders both `#cfgSanitizeClientSystemPrompt` and `#credSyncAgentsBtn`
      const dashHtml = renderDashboardHtml("/dashboard", "nonce-123");
      assert.ok(dashHtml.includes("cfgSanitizeClientSystemPrompt"));
      assert.ok(dashHtml.includes("credSyncAgentsBtn"));
    } finally {
      await gw.close();
      await new Promise<void>((r) => wss.close(() => r()));
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists metadata-only RequestTraceLogger across restarts without content leakage and defaults docker-compose.yml to GHCR image", async () => {
    const { RequestTraceLogger } = await import("../src/services/request-logger.js");
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "aq2a-traces-persist-"));
    const traceFile = path.join(tmpDir, "request-traces.json");
    try {
      const logger1 = new RequestTraceLogger(50, traceFile);
      const secretPrompt = "TOP_SECRET_PROMPT_SHOULD_NEVER_HIT_DISK_9981";
      const secretOutput = "TOP_SECRET_MODEL_REPLY_SHOULD_NEVER_HIT_DISK_7721";
      const id = logger1.startTrace(
        "anthropic-messages",
        {
          requestedModel: "quick-smart",
          stream: true,
          systemPrompt: secretPrompt,
          fullTranscriptText: secretPrompt,
          incrementalUserText: secretPrompt,
          trailingToolResults: [],
          tools: [{ name: "Read", description: "Read file", inputSchema: {} }],
          toolChoice: "auto",
          estimatedInputTokens: 100,
          images: [],
          files: [],
          incrementalFiles: [],
          rawBody: { messages: [{ role: "user", content: secretPrompt }] },
          conversationKey: "conv-persist-1",
          priorPrefixHash: "prev-hash",
          currentInputPrefixHash: "curr-hash",
        },
        { keyId: "k1", keyName: "team-key", clientIp: "127.0.0.1", userAgent: "claude-cli/2.1" },
      );
      logger1.bindExecutionMeta(id, {
        slotId: "slot1",
        maskedKey: "oauth:...abcd",
        accountLabel: "Acc-1",
        execMode: "warm_incremental",
      });
      logger1.recordThinkingDelta(id, "SECRET_THINKING_TEXT");
      logger1.recordTextDelta(id, secretOutput);
      logger1.recordUsage(id, {
        inputTokens: 1200,
        cacheReadTokens: 8000,
        cacheWriteTokens: 0,
        outputTokens: 300,
        resolvedModel: "us.anthropic.claude-opus-5-5",
      });
      logger1.finishSuccess(id, "end_turn");
      await logger1.flushAsync();

      const diskRaw = readFileSync(traceFile, "utf8");
      assert.ok(!diskRaw.includes(secretPrompt), "prompt text must NEVER be persisted to request-traces.json");
      assert.ok(!diskRaw.includes(secretOutput), "output text must NEVER be persisted to request-traces.json");
      assert.ok(!diskRaw.includes("SECRET_THINKING_TEXT"), "thinking text must NEVER be persisted");
      assert.ok(!diskRaw.includes("fullPromptChars"), "internal fields must not leak");

      // Reload into a brand-new RequestTraceLogger (simulating container/process restart)
      const logger2 = new RequestTraceLogger(50, traceFile);
      const list = logger2.listSummaries(10);
      assert.equal(list.length, 1);
      assert.equal(list[0]!.id, id);
      assert.equal(list[0]!.requestedModel, "quick-smart");
      assert.equal(list[0]!.accountLabel, "Acc-1");
      assert.equal(list[0]!.execMode, "warm_incremental");
      assert.equal(list[0]!.metrics?.cacheReadTokens, 8000);
      assert.equal(logger2.getDetail(id)?.toolNames[0], "Read");

      // Clearing traces persists the cleared state
      logger2.clear();
      logger2.flush();
      const logger3 = new RequestTraceLogger(50, traceFile);
      assert.equal(logger3.listSummaries(10).length, 0);

      // docker-compose.yml defaults to prebuilt GHCR `image:` so `docker compose pull && docker compose up -d` works out of the box
      const composeRaw = readFileSync(path.resolve(process.cwd(), "docker-compose.yml"), "utf8");
      assert.ok(/^\s*image:\s*ghcr\.io\/kuk-888\/aws-quick2api:latest\s*$/m.test(composeRaw), "docker-compose.yml must enable GHCR image by default");
      assert.ok(!/^\s*build:\s*\.\s*$/m.test(composeRaw), "docker-compose.yml should keep `build: .` commented out when GHCR image is default");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
