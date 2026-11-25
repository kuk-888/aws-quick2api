# aws-quick2api

English | **[简体中文](./README.md)**

[![Release](https://img.shields.io/github/v/release/kuk-888/aws-quick2api?display_name=tag&sort=semver&style=flat-square)](https://github.com/kuk-888/aws-quick2api/releases)
[![GHCR](https://img.shields.io/badge/GHCR-aws--quick2api-2496ED?logo=docker&logoColor=white&style=flat-square)](https://github.com/kuk-888/aws-quick2api/pkgs/container/aws-quick2api)
[![Community: LINUX DO](https://img.shields.io/badge/Community-LINUX%20DO-1f2937?style=flat-square)](https://linux.do)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

Single-process **OpenAI & Anthropic API gateway** for **AWS Quick**. Runs on Linux, Docker, macOS, and Windows without installing the official desktop app, and ships with a built-in Web Console (`aws-quick-admin`).

> **Disclaimer**: Independent third-party open-source project, not affiliated with or endorsed by Amazon Web Services (AWS). Contains no proprietary AWS binaries or assets. Authenticate with your own legitimate account. For personal development and protocol interoperability only—do not resell or run as a commercial relay.

---

## What It Does

- **Dual-Protocol API**: Exposes OpenAI (`/v1/chat/completions`, `/v1/responses`, `/v1/models`) and Anthropic (`/v1/messages`, `/v1/messages/count_tokens`) endpoints with SSE streaming, tool/function calling, thinking blocks, and multimodal image inputs (base64 & SSRF-checked remote URLs up to 10 MB).
- **Headless Auth (No Desktop App Required)**:
  - **2-step OAuth PKCE wizard** in the Web Console (universal multi-cell tenant discovery, 90-day auto-refresh, automatic email & display name extraction).
  - **Web Cookie import** (`Copy as cURL` from `quick.aws.com`), batch JSON backup/restore, and optional macOS `local-outpost` reuse.
- **Large Context & Streaming Resilience**:
  - Oversized contexts (`>46 KB`) on OAuth accounts automatically use AWS Quick's **native out-of-band `.txt` attachment upload** (single-frame delivery + 60s DLP poll verification + Turn-2 warm incremental reuse); non-OAuth or fallback paths use `≤46.5 KB` JSON-escaped UTF-8 chunking (with a 45s `turn_usage` watchdog and a 12-chunk safety cap). Streaming requests above 16 KB or with tools flush `HTTP 200` + `: keepalive` heartbeats once an upstream slot is leased (preserving genuine pre-lease HTTP `429` responses while preventing Cloudflare `524` timeouts).
  - Optional gateway safety-net compaction above `850K` tokens (`AUTO_COMPACT_OVERFLOW_TOKENS`, zero-touch below threshold so client Prompt Cache stays intact).
  - Streaming sanitizer converts AWS Quick's proprietary `<decision>` / `<decisions>` / `<artifact>` UI XML into plain Markdown while leaving fenced code blocks untouched.
- **Auto-Managed Custom Agent & Clean Tool Bridge**:
  - Enabled by default (`AUTO_ENSURE_CODING_AGENT=true`): on the first call to an unbound account, the gateway uses AWS Quick's native WebSocket protocol to discover an existing custom agent or automatically create & publish `Coding Assistant` from your template, persisting its `chat_agent_id` to `.env` for zero-overhead reuse.
  - When a custom agent is active, tool bridging switches to ultra-clean minimal JSON schemas (no verbose anti-refusal boilerplate; zero `user_message` suffix injection on Opus/Sonnet), reliably powering local files, `.env`, shell, MCP, Skills, and Codex `apply_patch`.
  - Under **Routing & Strategy**, hot-update `AUTO_ENSURE_CODING_AGENT` and the global default instructions template `CUSTOM_AGENT_PROMPT`; under **Credentials**, click **Agent** on any account to inspect live custom agents, switch or restore default in one click, auto-create/bind, or **edit & hot-publish an existing agent's prompt directly to AWS Quick**.
- **Multi-Account Pool & Per-Credential Proxies**:
  - `quota-aware`, `least-busy`, and `round-robin` scheduling, sticky session affinity (high Bedrock Prompt Cache hit rate), automatic circuit-breaking on quota exhaustion, and failover on 401/429/502/503.
  - Zero-dependency per-account outbound proxy supporting `http://`, `https://`, `socks5://`, `socks5h://` (remote DNS), and common provider shorthands (`host:port`, `user:pass@host:port`, `host:port:user:pass`), with automatic transient retry for residential proxies.
- **Native Incognito Privacy & Dedicated WS Warm Reuse**:
  - Combines **native `incognito: true` (zero AWS cloud history)** with **per-conversation dedicated WebSocket keepalive & warm incremental reuse** across all protocols (including multi-turn tool calls in Claude Code, Codex CLI, and Witan) for **1.4–3.2s** follow-up latency; 5-tuple session isolation prevents cross-talk, idle disconnects seamlessly fall back to lossless `46.5 KB` chunked replay with zero amnesia, and cloud mode (`INCOGNITO=false`) additionally supports cross-disconnect `thread_id` resume.
- **Built-in Web Console (`aws-quick-admin`)**:
  - Served at `/dashboard` (EN/ZH, Light/Dark). Includes overview charts, routed-model breakdown, live quota & free-trial countdown, selective quota sync, batch cloud session cleanup, scoped `sk-aq-...` sub-keys (model allowlist, concurrency, quota, expiry), and live request traces.

---

## Architecture

```mermaid
flowchart LR
  C["OpenAI / Anthropic Clients<br/>Claude Code / Cursor / Cherry Studio / Cline"] -->|"HTTP / SSE"| G
  subgraph G["aws-quick2api (Node.js + TypeScript)"]
    A["Auth & Sub-Keys"] --> P["Protocol Layer<br/>OpenAI & Anthropic"]
    P --> E["Execution Engine"]
    W["Web Console (/dashboard)"] -.-> A
  end
  E -->|"Local Session (optional)"| O["Amazon Quick (macOS)"]
  E -->|"HTTPS / WSS (+ Optional Proxy)"| Q["AWS Quick Cloud"]
```

---

## Screenshots

### Overview Dashboard

![Overview](./docs/screenshots/overview.png)

### Credentials & Quota Pool

![Credentials & Quota Pool](./docs/screenshots/credentials.png)

<details>
<summary>More Console Views (Client Sub-Keys / Model Access / Routing & Incognito)</summary>

#### Client Sub-Keys & Quick Connect
![Sub-Keys](./docs/screenshots/subkeys.png)

#### Model Access Control
![Models](./docs/screenshots/models.png)

#### Routing, Affinity & Incognito
![Routing](./docs/screenshots/routing.png)

</details>

---

## Adding Credentials

Open the Web Console (`http://127.0.0.1:3456/dashboard`) and click **+ Add Credential**:

1. **OAuth PKCE Wizard (Recommended · 90-day auto-refresh)**: Follow the built-in 2-step wizard (Step 1 discovers your account's tenant/cell; Step 2 authorizes access and stores a 90-day refresh token).

![OAuth 2-Step Wizard](./docs/screenshots/oauth-wizard.png)

2. **Web Cookie Import (`Copy as cURL`)**: In a browser signed in to `quick.aws.com`, open DevTools (`F12`) → **Network** → right-click any `quick.aws.com` request → **Copy as cURL**, then paste it into the **Cookie Import** tab.

| Step 1: Copy as cURL | Step 2: Paste & Import |
| :---: | :---: |
| ![Copy as cURL](./docs/screenshots/cookie-step1-curl.png) | ![Cookie Import](./docs/screenshots/cookie-step2-import.png) |

---

## Model Mapping & Observed Routing

| Model ID | Mode | Default Reasoning | Observed Routed Model | Best For |
| :--- | :--- | :--- | :--- | :--- |
| `quick-fast` | `fast` | `off` | `us.anthropic.claude-haiku-5-5` | Fast everyday Q&A and high concurrency |
| `quick-balanced` | `balanced` | `off` | `us.anthropic.claude-sonnet-5-5` | General coding and balanced daily use (default) |
| `quick-balanced-think` | `balanced` | `medium` | `us.anthropic.claude-sonnet-5-5` | Balanced tasks with thinking enabled |
| `quick-smart` | `smart` | `off` | `us.anthropic.claude-opus-5-5` | Complex reasoning and architecture tasks |
| `quick-smart-think` | `smart` | `high` | `us.anthropic.claude-opus-5-5` | Deep reasoning with high thinking effort |
| `quick-advanced` | `advanced` | `high` | Account-dependent | Requires Advanced plan (disable on Free tier) |

> **Dynamic Routing**: Underlying models are assigned server-side and may change with AWS upstream routing policies. The actual routed model is surfaced in the thinking block, OpenAI `system_fingerprint`, and console request logs.
>
> **Aliases & Overrides**: Parenthetical hints (e.g. `quick-balanced(Sonnet)`, `quick-smart(max)`) are accepted automatically. Reasoning effort (`off` / `low` / `medium` / `high` / `max`) can be overridden and passed through natively via `reasoning_effort`, `reasoning.effort`, `thinking.enabled`, `enable_thinking`, `-max` suffixes, or bracket syntax (`quick-smart[effort=max]`).

---

## Quick Start

### Requirements
- Node.js `>= 22.13.0` (or Docker)

### Run Locally

```bash
git clone https://github.com/kuk-888/aws-quick2api.git
cd aws-quick2api
npm install
npm test

cp .env.example .env
# Optional: set a strong random ADMIN_PASSWORD in .env (required on remote servers). Leave GATEWAY_TOKEN unset:
# a random sk-aq-... key is generated on first start (copy it from Console -> Sub-Keys). Placeholder values are rejected at startup.
npm start
```

### Run with Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
```

When using published multi-arch (`linux/amd64`, `linux/arm64`) GHCR images (`ghcr.io/kuk-888/aws-quick2api:latest`):

```bash
docker compose pull && docker compose up -d
```

> **Upgrading Docker from `<= v0.1.15`**: Starting in `v0.1.16`, the container runs as non-root (`node`, UID/GID `1000:1000`) with `cap_drop: [ALL]`. If your existing `./data` directory or `.env` file is owned by `root`, run `chown -R 1000:1000 data .env` once before upgrading.

- **Web Console**: `http://127.0.0.1:3456/dashboard`
- **OpenAI Base URL**: `http://127.0.0.1:3456/v1`
- **Anthropic Base URL**: `http://127.0.0.1:3456`

---

## Environment Variables

See [.env.example](./.env.example) for the full template:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` / `PORT` | `127.0.0.1` / `3456` | Bind host and port (`0.0.0.0` inside Docker) |
| `GATEWAY_TOKEN` | - | Optional bootstrap bearer token(s), comma-separated. Seeded once into the console and tagged `.env`; afterwards the console is authoritative: deleting it there revokes it permanently (not re-created on restart), while removing/changing it in `.env` removes/replaces that key on next restart. Unset = a random key is auto-generated. Placeholder values (e.g. `sk-aq-change-me`) are rejected at startup |
| `ENABLE_DASHBOARD` | `true` | Enable Web Console (`false` disables all console routes) |
| `ADMIN_PASSWORD` | - | Console login password (required on remote servers; if unset, first-time setup is restricted to localhost `127.0.0.1`/`::1`) |
| `QUICK_TOKENS` | `local-outpost` | Upstream credentials (can also be added via OAuth/Cookie in Console) |
| `DISABLED_MODELS` | - | Comma-separated model IDs to hide (e.g. `quick-advanced` on Free tier) |
| `INCOGNITO` | `true` | Native incognito mode (zero AWS cloud history; hot-toggleable in Console) |
| `AUTO_DELETE_SESSION` | `false` | Send extra `session_delete` RPC after each incognito turn (off by default) |
| `WEB_SEARCH_ENABLED` | `true` | Enable AWS Quick native web search |
| `SHOW_ROUTED_MODEL_IN_THINKING` | `true` | Show the routed model in the thinking block |
| `SUPPRESS_LATE_ROUTED_THINKING_IN_STREAM` | `false` | Set `true` only if a legacy OpenAI SSE client cannot handle a trailing `reasoning_content` chunk |
| `SANITIZE_AWS_UI_TAGS` | `true` | Convert AWS Quick `<decision>`/`<artifact>` XML into Markdown (preserves fenced code blocks) |
| `AWS_QUICK_LOCALE` | `en-US` | Locale sent to upstream |
| `AWS_QUICK_APP_VERSION` | `1.2.4660` | Desktop client version header override |
| `HTTPS_PROXY` / `HTTP_PROXY` | - | Global default proxy (per-account `http://`, `https://`, `socks5://` and shorthand proxies can be set in Console) |
| `AUTO_COMPACT_OVERFLOW_TOKENS` | `850000` | Safety-net compaction threshold for oversized prompts (`0` to disable) |
| `AUTO_COMPACT_SUMMARY` | `true` | Summarize middle history when overflow compaction triggers |
| `WARM_SESSION_TTL_MS` / `MAX_WARM_SESSIONS` | `1800000` / `256` | Warm incremental cache TTL (30 min) and max entries when `INCOGNITO=false` |
| `UPDATE_CHECK_REPO` | `kuk-888/aws-quick2api` | GitHub `owner/repo` for non-blocking release check in Console (set `off` to disable) |

---

## Known Limitations

- **Sampling parameters (`temperature`, `top_p`, `max_tokens`, `stop`, `seed`)**: Not enforced upstream; accepted for client compatibility and reported via response headers.
- **`response_format` (`json_object` / `json_schema`) & `n > 1`**: Not supported; returns an explicit `400` error.
- **Attachments**: Image inputs (PNG/JPG/WebP/GIF) are supported. Because AWS Quick currently enforces a 50 KB single-frame WebSocket limit for inline images, oversized images are automatically downscaled and JPEG-compressed (`sharp`) within the shared frame budget; 1–2 cropped screenshots remain sharp and reliable, while sending 4+ dense small-font screenshots in a single turn degrades OCR accuracy due to tighter per-image budget (**out-of-band native attachment upload for images is planned for `v0.1.18`**). PDF, document, and audio attachments are not supported yet.
- **Non-chat endpoints**: Embeddings, image generation, TTS, and Whisper are not supported.

---

## Community

For bug reports and feature requests, please open an issue on [GitHub Issues](https://github.com/kuk-888/aws-quick2api/issues).

Thanks to the [LINUX DO](https://linux.do) community for providing an open and friendly technical exchange platform.

---

## License

[MIT](./LICENSE)
