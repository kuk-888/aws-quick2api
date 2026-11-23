import assert from "node:assert/strict";
import type http from "node:http";
import net from "node:net";
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
  parseOAuthCredential,
  parseOAuthDiscoveryCallback,
  serializeOAuthCredential,
} from "../src/aws-quick/oauth-client.js";
import { parseQuickCredential } from "../src/aws-quick/outpost-singleton.js";
import { parseWebCurlOrCredential, serializeWebCredential } from "../src/aws-quick/web-client.js";
import { buildQuickImageAttachments, compactOversizedPrompt, estimatePromptTokens, splitPromptIntoSafeChunks } from "../src/core/engine.js";
import { UpstreamKeyPool } from "../src/core/key-pool.js";
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
    // 1. Multi-client identity-clash sanitization (only active when tools are attached)
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
});
