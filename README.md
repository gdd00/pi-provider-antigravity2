# pi-provider-antigravity2

**English** | [简体中文](README-zh-hans.md)

[![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Erasable-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-10B981?style=flat)](#)

An **Antigravity (Google Cloud Code Assist `v1internal`)** provider extension for [Pi](https://github.com/earendil-works/pi), enabling you to use your Antigravity subscription quota directly inside Pi for Gemini, Claude, and other supported models.

> [!CAUTION]
> **Disclaimer**: This is an **unofficial**, community-maintained provider extension intended for educational and personal research purposes. Using unofficial clients against Google Cloud Code Assist / Antigravity may violate Google's Terms of Service and can result in quota loss or account restrictions. Use at your own risk. OAuth client credentials are **not** bundled in this repository; see [OAuth Client Credentials](#-oauth-client-credentials-relies-on-agy-client) below before running `/login antigravity` or refreshing tokens.

---

## 🧠 Native Pi Core, Optional `agy` Setup

This extension is **strictly a Pi provider, auth, and protocol adapter**:

- **⚙️ Full Pi Core Agent Loop & Built-in Tools**: All conversation turns, context management, reasoning, and native tool execution (`read`, `bash`, `edit`, `write`, etc.) are **100% executed by `pi` itself**.
- **Optional `agy` Setup**: Pi runs conversations and refreshes tokens itself, with no third-party runtime npm dependencies. On Linux, the extension can run `agy` during `/login antigravity`, `/antigravity sync-client`, or `/antigravity import-agy` to identify its OAuth client configuration.
- **🌐 Direct Cloud Code Assist HTTP/SSE**: Speaks directly to `https://daily-cloudcode-pa.googleapis.com/v1internal` over native `fetch`, supporting streaming responses, `xhigh` thinking levels (e.g. `thinkingLevel: 100`), multi-turn `thoughtSignature` preservation, and cross-family tool history compatibility.

---

## 🔐 Authentication & Credential Management

The extension includes a complete Google OAuth PKCE login and credential lifecycle (in [auth.ts](pi-provider-antigravity2/auth.ts)):

### 🔑 OAuth Client Credentials (Relies on `agy` Client)

This package does **not** ship built-in Google OAuth client credentials. Interactive `/login antigravity` and Refresh Token renewal **rely on the OAuth client credentials provided by a locally installed official `agy` (`antigravity-cli`) client** (because Antigravity uses restricted Google internal scopes such as `aicode`, `cclog`, `experimentsandconfigs` and the `https://antigravity.google/oauth-callback` redirect URI, which a self-created GCP OAuth client cannot authorize).

**Automatic Setup via `/login antigravity` (Recommended):**

Every time you run `/login antigravity`:
1. The extension runs `agy acp --login` in a temporary profile with stdin closed and reads `client_id` from the official Google login URL. It does not open a browser or complete an `agy` login.
2. The extension reads the local binary to find the matching Client Secret and build the HTTP User-Agent. If it cannot verify a fresh pair, it reuses the saved pair, or prompts for missing values. Explicit OAuth environment overrides still take precedence.
3. Authorize Pi in your browser and paste the authorization code. After the token exchange succeeds, changed values are saved to `~/.pi/agent/pi-provider-antigravity.json`. A failed or cancelled exchange does not replace saved values.

**Manual Extraction / Configuration (Optional):**

1. **`ANTIGRAVITY_CLIENT_ID`**: Run `agy` login once and copy the `client_id=...` query parameter from the Google OAuth URL opened in your browser (note: `strings "$(which agy)"` lists multiple bundled Google client IDs; pick the one shown in `agy`'s login URL):
   ```bash
   strings "$(which agy)" | grep -oE '[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com' | sort -u
   ```
2. **`ANTIGRAVITY_CLIENT_SECRET`**: `agy` is a Go binary whose `.rodata` concatenates strings without `\0` terminators, so `GOCSPX-[A-Za-z0-9_-]+` can swallow characters from the adjacent string. Match the **exact 35-character** format (`GOCSPX-` + 28 chars) and probe `oauth2.googleapis.com/token` with a dummy code to find the matching secret (`invalid_grant` means the pair matches; `invalid_client` means it belongs to another bundled client):
   ```bash
   node -e '
   const fs = require("node:fs");
   const txt = fs.readFileSync(process.argv[1], "latin1");
   const secrets = [...new Set(txt.match(/GOCSPX-[A-Za-z0-9_-]{28}/g) || [])];
   (async () => {
     for (const s of secrets) {
       const r = await fetch("https://oauth2.googleapis.com/token", {
         method: "POST",
         headers: { "Content-Type": "application/x-www-form-urlencoded" },
         body: new URLSearchParams({
           client_id: process.argv[2],
           client_secret: s,
           code: "probe",
           grant_type: "authorization_code",
           redirect_uri: "https://antigravity.google/oauth-callback",
         }),
       });
       const j = await r.json();
       if (j.error === "invalid_grant") { console.log(s); break; }
     }
   })();
   ' "$(which agy)" "YOUR_CLIENT_ID.apps.googleusercontent.com"
   ```

**How to configure them (choose either option):**

- **Option 1 — Persistent config file** (recommended, write once in `$PI_CODING_AGENT_DIR/pi-provider-antigravity.json`, default `~/.pi/agent/pi-provider-antigravity.json`):
  ```json
  {
    "oauthClientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "oauthClientSecret": "GOCSPX-YOUR_CLIENT_SECRET"
  }
  ```
- **Option 2 — Environment variables** (takes precedence over the config file):
  ```bash
  export ANTIGRAVITY_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"
  export ANTIGRAVITY_CLIENT_SECRET="GOCSPX-YOUR_CLIENT_SECRET"
  ```

> [!NOTE]
> If you only place a pre-minted, still-valid `access` token (`ya29...`, without `refresh`) in `auth.json`, inference works without OAuth client credentials until that access token expires (~1 hour), after which it cannot auto-refresh.

1. **Interactive Login**: Run `/login antigravity` in Pi. The extension generates an `S256` PKCE authorization URL and exchanges the pasted authorization code for OAuth tokens.
2. **Automatic Project ID Resolution**: Queries `v1internal:loadCodeAssist` for the account's `cloudaicompanionProject`, falling back safely to `"aicode-consumers"` if unavailable.
3. **Refresh Token Normalization**: Automatically strips accidental leading hyphens (such as `-1//...` → `1//...`) and extra whitespace from refresh tokens.
4. **Seamless Refresh & 401 Recovery**:
   - Packs `{ token, projectId }` into the stored `access` field and preserves known non-fallback `projectId` values across refreshes.
   - During streaming, HTTP `401` can trigger a single token refresh and retry.

---

## HTTP User-Agent Override

`/login antigravity` reads the version and build changelist (`cl`) from the local `agy` binary on disk; this step doesn't run `agy`. If both are recognized, it saves the resulting HTTP `userAgent` under the top level of `$PI_CODING_AGENT_DIR/pi-provider-antigravity.json` (default `~/.pi/agent/pi-provider-antigravity.json`). This also runs when OAuth client credentials are already configured; rerun login after upgrading `agy` to refresh the value.

If `agy` is missing or its build metadata is unrecognized, login leaves the existing `userAgent` alone. You can set it manually to a single-line ASCII string. If unset, the extension uses the built-in default for your OS and architecture.

---

## 🚨 Why Does Pi's Unmodified System Prompt Trigger HTTP 429?

Wire captures, field-ablation tests, and character-level bisection confirmed that **the Antigravity backend explicitly detects and rejects Pi's default system prompt signature**:

- When a request carries top-level `"requestType": "agent"` and `request.systemInstruction` matches Pi's default harness phrasing:
  - `prefix[:43]` (`"You are a coding assistant running inside p"`) → **HTTP 200**
  - `prefix[:44]` (`"You are a coding assistant running inside pi"`) → **Instant HTTP 429**
  - `"running inside pi, a coding agent harness"` → **Instant HTTP 429**
- This triggers an instant synthetic `429 RESOURCE_EXHAUSTED` (with **no** `Retry-After` header and **no** `quotaResetDelay` / `retryDelay` in the error payload), rather than a real quota exhaustion.

---

## ✂️ How This Extension Adapts System Prompts (Only When Switched to `antigravity`)

To bypass the synthetic 429 check **while preserving Pi's coding capabilities and context as much as possible**, prompt adaptation is strictly scoped to outbound Antigravity requests:

### 1. 🔒 Strictly Isolated Scope

- **Only when Pi is switched to the `antigravity` provider** do requests flow through `pi.registerProvider("antigravity", { streamSimple })` → `streamAntigravity` → `buildAntigravityRequestBody` ([builder.ts](pi-provider-antigravity2/builder.ts)), adapting `request.systemInstruction` in the outbound JSON payload.
- The `session_start` and `before_agent_start` hooks are **read/validate only** — they never mutate Pi's in-memory system prompt.
- **When using OpenAI, Anthropic, or any other provider, Pi's system prompt is left completely untouched.**

### 2. 🧩 Minimal Adaptation & Context Caveats

- **Rewrites the opening `preamble` and strips WAF triggers**: Neutralizes phrases like `"running inside pi..."` and removes Pi's built-in `<docs>` boilerplate via `systemInstructionRewrites` so Antigravity's proxy WAF accepts the prompt.
- **All other live Pi context remains intact**: `<tools>`, `<rules>`, `<skills>`, `<cwd>`, project `AGENTS.md`, and `APPEND_SYSTEM.md` are still injected live on every turn — nothing goes stale from cached static prompts.
- **No Pi Docs (`<docs>`) on `antigravity`**: Because Pi's built-in `<docs>` section is stripped from outbound `antigravity` system instructions, `antigravity` models cannot see Pi's self-documentation. **If you need to ask questions about Pi itself (usage, configuration, extensions, etc.), switch to another provider.**
- **Synthetic 429 Auto-Recovery**: If an unmatched prompt variant still triggers a synthetic 429 (no backoff metadata), [stream.ts](pi-provider-antigravity2/stream.ts) and [waf-recovery.ts](pi-provider-antigravity2/waf-recovery.ts) strip top-level `requestType`, apply emergency sanitization, and if needed bisect the blocked `systemInstruction` line(s) (cached in-memory for the current process without altering conversation history).

> [!IMPORTANT]
> 💡 **Customize `userModified` in `~/.pi/agent/pi-provider-antigravity-prompts.json`**
>
> On your first session start, the extension generates a **concise, human-readable** prompt config file at `$PI_CODING_AGENT_DIR/pi-provider-antigravity-prompts.json` (default `~/.pi/agent/pi-provider-antigravity-prompts.json`).
>
> - **Each prompt item is flat and self-contained**, with three fields:
>   - `piOriginal`: Pi's original text (**read-only reference**; only checked/updated when the file is created or when `piVersion` changes).
>   - `extensionBuiltIn`: The extension's built-in default (**read-only reference**, synced from [default-prompts.json](pi-provider-antigravity2/default-prompts.json)).
>   - `userModified`: **The only section active at runtime** (initialized to match `extensionBuiltIn` as an editable placeholder).
> - **Fields you can customize under `userModified`**:
>   - `prompts.preamble.userModified`: Customize the opening system prompt sent to Antigravity models (for example, your preferred terminal assistant persona — avoid reintroducing `"running inside pi"`). Live `<tools>`, `<rules>`, and `<cwd>` sections are still appended dynamically.
>   - `prompts.systemInstructionRewrites.rules[*].userModified`: Edit fallback regex replacement text (`pattern` appears once at the rule level; set `userModified` to `null` to disable a rule).
>   - `prompts.searchSystemInstruction.userModified`: Customize the system instruction sent to the background Gemini model for `antigravity_websearch`. The model comes from the cached Antigravity catalog's `webSearchModelIds`, with `gemini-3.5-flash-lite` as a fallback when no search ID is available.
>   - `prompts.webSearchToolDescription` / `webSearchToolSnippet` / `webSearchToolGuidelines` `userModified`: Customize the `antigravity_websearch` tool description, `<tools>` snippet, and `<rules>` guidelines exposed to the main model (restart or `/reload` Pi for tool registration edits; all other edits take effect on the very next turn).
> - **Safety & Reset**: When `piVersion` is unchanged, extracting Pi's prompt is skipped, while file integrity is still checked on startup without overwriting your `userModified` customizations. Delete any key in `userModified` (or delete the whole file) and restart Pi to reset it to `extensionBuiltIn`.

---

## 🛠️ Installation & Usage

### 📦 Install / Load

> [!NOTE]
> If you previously installed the deprecated `pi-provider-antigravity` package, remove it first (`pi remove npm:pi-provider-antigravity`) to avoid conflicts — both share the `antigravity` provider ID, `/antigravity` command, and `~/.pi/agent/pi-provider-antigravity*.json` config paths.

```bash
# Option A: Install from npm (recommended)
pi install npm:pi-provider-antigravity2

# Option B: Try for a single session without installing
pi -e npm:pi-provider-antigravity2

# Option C: Load or symlink from a local clone
pi -e /path/to/repo
# or: ln -s /path/to/repo/pi-provider-antigravity2 ~/.pi/agent/extensions/pi-provider-antigravity2
```

Log in, fetch the model list, then select an `antigravity` model:

```text
/login antigravity
/antigravity refresh
/model
```

Only `/antigravity models` and `/antigravity refresh` fetch the Antigravity catalog. Startup, `/model`, and `/scoped-models` use the last saved list. For a new headless installation, seed the cache with one of those commands in an interactive session or copy `pi-provider-antigravity-models.json` into the agent directory. Existing entries in Pi's `models-store.json` still work as a fallback.

#### Import an existing `agy` login (Linux)

Run `/antigravity import-agy` in Pi if you are already signed into local `agy` with a personal Google account. The command checks the current user's Secret Service using `busctl`, reads the unlocked entry with `secret-tool` (libsecret), or checks the private fallback file at `~/.gemini/antigravity-cli/antigravity-oauth-token` when no keyring entry exists. It verifies token renewal before saving. Replacing an existing Pi login requires confirmation.

The command does not change the `agy` login or provider config. It saves the imported login and matching OAuth client pair in Pi's owner-only `auth.json`; explicit OAuth environment overrides still take precedence. This unofficial import may stop working if `agy` changes its credential format. No `sync-client` is needed after a successful import. If no Antigravity models are cached, run `/antigravity refresh` and then select one with `/model`. If models are already available, go straight to `/model`.

#### 🪪 Headless Login with a Refresh Token (`auth.json`)

If you already have a Google OAuth refresh token (for headless servers, containers, or migrated credentials), you can skip browser login by writing directly to `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`):

```json
{
  "antigravity": {
    "type": "oauth",
    "refresh": "1//03_your_refresh_token_here",
    "access": "",
    "expires": 0
  }
}
```

- `type`: Must be `"oauth"`.
- `refresh`: Your Google OAuth refresh token (`1//...`; accidental leading `-1//...` prefixes are automatically normalized).
- `access` & `expires`: Leave as `""` and `0`. When a request needs credentials, Pi exchanges `refresh` for an `access_token` and the extension resolves `projectId` automatically.
- Restrict file permissions to owner-only: `chmod 600 ~/.pi/agent/auth.json`.

### Idle disconnect

Idle disconnect is provided by the optional standalone `pi-provider-afk` extension. Install it alongside this provider for idle disconnect (default: 90 seconds); open `/provider-afk` → **Providers** and toggle `antigravity` to keep it connected. Without it, Antigravity has no idle timer.

### 💬 Built-in Commands & Tool

- **`/antigravity usage`**: Show remaining 5h & weekly quota bars and reset timers
- **`/antigravity models`**: Refresh and display recommended/available models with context window and remaining quota
- **`/antigravity refresh`**: Refresh the same catalog without displaying the list
- **`/antigravity sync-client`**: Sync OAuth Client ID, Secret, and User-Agent from local `agy`. If the Client ID changed and Pi is already logged in, the command can update the User-Agent but keeps the existing OAuth pair; run `/login antigravity` to switch.
- **`/antigravity import-agy`**: Import the current local `agy` personal OAuth login on Linux without opening a browser.
- **`/antigravity settings`**: Interactive settings dialog (persisted to `~/.pi/agent/pi-provider-antigravity.json`):
  - `Quota footer` (`"off"` / `"smart"` / `"all"`): Status footer quota display mode
  - `Unsigned tool calls` (`"fail"` / `"skip"`): Handling policy when cross-provider history loses a `thoughtSignature`
- **`/antigravity websearch <query>`** & **`antigravity_websearch` tool**: Native HTTP Google Search Grounding with inline source citations. Responses without web sources are reported as search failures.

---

## 🧪 Development & Offline Tests

All source modules use erasable TypeScript with explicit `.ts` imports and zero runtime external dependencies, running directly on Node v22.19+:

```bash
npm test
# Equivalent to: node --experimental-strip-types --test tests/*.test.ts
```

### 📁 Project Structure

- [pi-provider-antigravity2/index.ts](pi-provider-antigravity2/index.ts) — Pi extension entrypoint, provider, command, and tool registration
- [pi-provider-antigravity2/auth.ts](pi-provider-antigravity2/auth.ts) — OAuth PKCE flow, token refresh, and `loadCodeAssist` project resolution
- [pi-provider-antigravity2/protocol.ts](pi-provider-antigravity2/protocol.ts) — Cloud Code HTTP/SSE client and structured HTTP errors
- [pi-provider-antigravity2/model-identity.ts](pi-provider-antigravity2/model-identity.ts) & [model-catalog.ts](pi-provider-antigravity2/model-catalog.ts) — Model family detection, catalog refresh, `xhigh` thinking config, and cold-start bootstrap
- [pi-provider-antigravity2/default-prompts.json](pi-provider-antigravity2/default-prompts.json) & [prompts.ts](pi-provider-antigravity2/prompts.ts) — Externalized default prompts and `pi-provider-antigravity-prompts.json` lifecycle management
- [pi-provider-antigravity2/builder.ts](pi-provider-antigravity2/builder.ts) — Outbound system instruction adaptation, tool schema cleanup, multi-turn translation, and signature handling
- [pi-provider-antigravity2/sse.ts](pi-provider-antigravity2/sse.ts) & [stream.ts](pi-provider-antigravity2/stream.ts) — Incremental SSE parsing, synthetic 429 fallback, and 401 recovery
- [pi-provider-antigravity2/config.ts](pi-provider-antigravity2/config.ts), [settings.ts](pi-provider-antigravity2/settings.ts), [quota-status.ts](pi-provider-antigravity2/quota-status.ts), [search.ts](pi-provider-antigravity2/search.ts), [commands.ts](pi-provider-antigravity2/commands.ts) — Config persistence, quota footer, web search tool, and `/antigravity` command router
