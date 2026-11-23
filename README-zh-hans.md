# pi-provider-antigravity2

[English](README.md) | **简体中文**

[![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Erasable-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-10B981?style=flat)](#)

面向 [Pi](https://github.com/earendil-works/pi) 的 **Antigravity（Google Cloud Code Assist `v1internal`）** Provider 扩展，让你可以在 Pi 中直接使用 Antigravity 订阅配额调用 Gemini / Claude 等模型。

> [!CAUTION]
> **免责声明**：本项目为**非官方**社区维护的 Provider 扩展，仅用于个人学习与技术研究。使用非官方客户端访问 Google Cloud Code Assist / Antigravity 可能违反 Google 服务条款，并存在配额回收或 Google 账号受限风险，请自行承担使用风险。本仓库**不内置** Google OAuth 客户端凭证；执行 `/login antigravity` 或自动刷新 Refresh Token 前，请先按下方 [OAuth 客户端凭证](#-oauth-客户端凭证登录依赖-agy-客户端) 步骤完成配置。

---

## 🧠 原生 Pi Core，登录时可选用 `agy`

本扩展**纯粹是一个 Pi Provider / Auth / 协议适配层**：

- **⚙️ 完全使用 Pi Core 的 Agent Loop 与内置工具**：所有对话循环、上下文管理、思考过程，以及 `read`、`bash`、`edit`、`write` 等原生工具调用，**100% 由 `pi` 自身执行**。
- **`agy` 仅用于可选登录配置**：日常对话和令牌刷新由 Pi 完成，没有第三方运行时 npm 依赖。Linux 上仅在 `/login antigravity`、`/antigravity sync-client` 或 `/antigravity import-agy` 时尝试运行 `agy`，识别 OAuth 客户端配置。
- **🌐 直连 Cloud Code Assist HTTP/SSE**：直接通过原生 `fetch` 对接 `https://daily-cloudcode-pa.googleapis.com/v1internal`，原生支持流式输出、`xhigh` 思考等级（如 `thinkingLevel: 100`）、多轮 `thoughtSignature` 签名保留与跨模型族工具历史兼容。

---

## 🔐 登录与凭据管理

扩展内置完整的 Google OAuth PKCE 登录与凭据维护链路（位于 [auth.ts](pi-provider-antigravity2/auth.ts)）：

### 🔑 OAuth 客户端凭证（登录依赖 `agy` 客户端）

本扩展**不内置** Google OAuth 客户端凭证。交互式 `/login antigravity` 登录以及 Refresh Token 自动续期**依赖本机官方 `agy`（`antigravity-cli`）客户端提供的 OAuth 客户端凭证**（由于 Antigravity 使用 `aicode`、`cclog`、`experimentsandconfigs` 等 Google 受限内部 Scope 与官方回调 `https://antigravity.google/oauth-callback`，个人在 Google Cloud Console 新建的普通 OAuth 应用无法通过授权校验）。

**通过 `/login antigravity` 自动提取与保存（推荐）：**

每次运行 `/login antigravity`：
1. 在临时目录运行 `agy acp --login`，关闭标准输入，从官方 Google 登录网址提取 `client_id`，不打开浏览器、不完成 `agy` 登录。
2. 扩展读取本机 `agy` 二进制，查找匹配的 Client Secret 并生成 HTTP User-Agent。无法验证新凭据时，沿用已有的一对；仍缺值才提示手动输入。显式设置的 OAuth 环境变量仍优先。
3. 用户在浏览器授权 Pi 并粘贴授权码。换取令牌成功后，扩展才把有变化的值写入 `~/.pi/agent/pi-provider-antigravity.json`；换取失败或取消，不覆盖原值。

**手动提取与配置（可选）：**

1. **获取 `ANTIGRAVITY_CLIENT_ID`**：执行一次 `agy` 登录，从浏览器打开的 Google OAuth 授权地址中复制 `client_id=...` 参数（`strings "$(which agy)"` 会列出多个内置 Google 客户端 ID，以实际登录 URL 中的为准）：
   ```bash
   strings "$(which agy)" | grep -oE '[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com' | sort -u
   ```
2. **获取 `ANTIGRAVITY_CLIENT_SECRET`**：由于 `agy` 是 Go 编译的二进制文件，`.rodata` 段字符串紧密拼接没有 `\0` 结尾，直接用 `GOCSPX-[A-Za-z0-9_-]+` 会把紧邻下一条字符串的字母吞进去导致长度不对；需按 **35 位精确长度**（`GOCSPX-` + 28 位）匹配，并用虚拟 `code` 向 `oauth2.googleapis.com/token` 探测配对（返回 `invalid_grant` 即匹配成功，`invalid_client` 为其他客户端的 Secret）：
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
   ' "$(which agy)" "你的CLIENT_ID.apps.googleusercontent.com"
   ```

**配置方式（二选一）：**

- **方式 1 — 写入持久化配置文件**（推荐，一次配置长期生效；路径为 `$PI_CODING_AGENT_DIR/pi-provider-antigravity.json`，默认 `~/.pi/agent/pi-provider-antigravity.json`）：
  ```json
  {
    "oauthClientId": "你的CLIENT_ID.apps.googleusercontent.com",
    "oauthClientSecret": "GOCSPX-你的CLIENT_SECRET"
  }
  ```
- **方式 2 — 通过环境变量传入**（优先级高于配置文件）：
  ```bash
  export ANTIGRAVITY_CLIENT_ID="你的CLIENT_ID.apps.googleusercontent.com"
  export ANTIGRAVITY_CLIENT_SECRET="GOCSPX-你的CLIENT_SECRET"
  ```

> [!NOTE]
> 如果你仅向 `auth.json` 写入现成的有效 `access` token（`ya29...`，且不依赖 `refresh`），在 Token 过期前（约 1 小时）无需配置上述 OAuth 客户端凭证即可正常请求，但过期后无法自动续期。

1. **交互式登录**：在 Pi 中执行 `/login antigravity`，扩展会生成 PKCE（`S256`）授权链接，粘贴回调授权码后换取 OAuth Token。
2. **Project ID 自动解析**：自动请求 `v1internal:loadCodeAssist` 获取账户绑定的 `cloudaicompanionProject`；若查询失败或未分配则安全回落至 `"aicode-consumers"`。
3. **Refresh Token 容错规范化**：自动清理 Refresh Token 中误带的前导连字符（如 `-1//...` 规范化为 `1//...`）及多余空白。
4. **无感刷新与 401 恢复**：
   - 将 `{ token, projectId }` 打包保存在凭据的 `access` 中，并在每次请求/刷新时自动继承已知的 `projectId`。
   - 流式对话遇到 `401` 时可自动刷新一次 Token 并重试。

---

## 覆盖 HTTP User-Agent

`/login antigravity` 会尝试从本机 `agy` 二进制读取版本和构建号（`cl`）；此步骤不启动 `agy`。两项都识别成功后，扩展会将 HTTP `userAgent` 写入 `$PI_CODING_AGENT_DIR/pi-provider-antigravity.json`（默认 `~/.pi/agent/pi-provider-antigravity.json`）的顶层。OAuth 客户端凭据已配置时也会检查；升级 `agy` 后再次登录即可更新。

如果没装 `agy` 或无法识别构建信息，登录会保留已有的 `userAgent`。也可以手动填写单行 ASCII 字符串；不设置时，扩展按当前系统和架构生成内置默认值。

---

## 🚨 为什么直接用 Pi 原版提示词会触发 429？

通过抓包对比、字段消融测试与字符级二分实验确认，**Antigravity 服务端明确存在针对 Pi 系统提示词的特征检测拦截**：

- 当请求顶层带有 `"requestType": "agent"`，且 `request.systemInstruction` 中包含 Pi 默认系统提示词特征短语时：
  - `prefix[:43]`（`"You are a coding assistant running inside p"`）→ **HTTP 200**
  - `prefix[:44]`（`"You are a coding assistant running inside pi"`）→ **立即返回 HTTP 429**
  - `"running inside pi, a coding agent harness"` → **立即返回 HTTP 429**
- 这类拦截会立即返回合成的 `429 RESOURCE_EXHAUSTED`（且响应头**没有** `Retry-After`，错误体**没有** `quotaResetDelay` / `retryDelay`），并非账号真实配额耗尽。

---

## ✂️ 本扩展如何修改系统提示词（仅切换为 `antigravity` 时生效）

为了在绕过 429 检测的同时**尽可能保留 Pi 的编程能力与上下文**，本扩展采用了**仅在出站请求阶段局部适配**的设计：

### 1. 🔒 严格隔离的作用范围

- **当且仅当 Pi 切换到 `antigravity` Provider 时**，请求才会经过 `pi.registerProvider("antigravity", { streamSimple })` → `streamAntigravity` → `buildAntigravityRequestBody`（[builder.ts](pi-provider-antigravity2/builder.ts)），在构造发往 Antigravity 的 JSON 载荷时对 `request.systemInstruction` 做适配。
- `session_start` 与 `before_agent_start` 钩子**只做读取与配置文件校验**，不修改 Pi 内存中的系统提示词。
- **切换到 OpenAI、Anthropic 等其他任何 Provider 时，Pi 的系统提示词一字不动。**

### 2. 🧩 最小化改写与上下文说明

- **改写开场导语并剥离拦截特征**：通过 `preamble` 与 `systemInstructionRewrites` 正则规则替换 `"running inside pi..."` 等特征短语，并移除会触发 Antigravity WAF 的 Pi 内置 `<docs>` 段落。
- **其余实时上下文完整保留**：`<tools>`、`<rules>`、`<skills>`、`<cwd>`、项目 `AGENTS.md` 以及 `APPEND_SYSTEM.md` 均完整保留，不会因缓存静态提示词而陈旧。
- **不包含 Pi Docs（`<docs>`）**：发往 `antigravity` 的系统提示词已移除 Pi 自带文档索引（`<docs>`），因此使用 `antigravity` 时模型看不到 Pi 文档；**如果要询问一些关于 Pi 本身的问题，请切换到其他 Provider**。
- **合成 429 兜底恢复**：若遇到未命中配置规则的未知变体并触发合成 429（无退避延迟），[stream.ts](pi-provider-antigravity2/stream.ts) 会结合 [waf-recovery.ts](pi-provider-antigravity2/waf-recovery.ts) 自动剥离 `requestType`、执行紧急清洗，并在必要时二分定位被拦截的 `systemInstruction` 行（仅缓存在当前进程内存并重发，不改写对话历史）。

> [!IMPORTANT]
> 💡 **建议自定义 `~/.pi/agent/pi-provider-antigravity-prompts.json` 中的 `userModified`**
>
> 扩展会在首次运行会话时于 `$PI_CODING_AGENT_DIR/pi-provider-antigravity-prompts.json`（默认 `~/.pi/agent/pi-provider-antigravity-prompts.json`）生成一份**精简、可读**的提示词配置文件。
>
> - **每个条目都按大类平铺**，内含三个参考/生效字段：
>   - `piOriginal`：Pi 原版内容（**仅用于查看**，仅当文件不存在或 `piVersion` 升级变化时才会检测更新）。
>   - `extensionBuiltIn`：本扩展内置默认值（**仅用于查看**，同步自 [default-prompts.json](pi-provider-antigravity2/default-prompts.json)）。
>   - `userModified`：**运行时唯一实际生效的部分**（初始与 `extensionBuiltIn` 一致，作为占位供你修改）。
> - **你可以自由微调以下 `userModified` 项**：
>   - `prompts.preamble.userModified`：自定义发给 Antigravity 模型的开场导语（例如改为更贴合你习惯的终端助手身份声明，注意避免写回 `"running inside pi"`）；后面的 `<tools>` / `<rules>` / `<cwd>` 等仍会实时拼接。
>   - `prompts.systemInstructionRewrites.rules[*].userModified`：修改兜底正则的替换文本（`pattern` 在外层只写一份；将 `userModified` 设为 `null` 可禁用该条规则）。
>   - `prompts.searchSystemInstruction.userModified`：自定义 `antigravity_websearch` 后台 Gemini 模型的系统提示词。模型取自 Antigravity 缓存目录中的 `webSearchModelIds`；没有可用的搜索模型 ID 时才使用 `gemini-3.5-flash-lite`。
>   - `prompts.webSearchToolDescription` / `webSearchToolSnippet` / `webSearchToolGuidelines` 的 `userModified`：自定义注册给主模型的 `antigravity_websearch` 工具描述与使用指引（修改工具元信息后重启或 `/reload` Pi 生效；其余项在下一轮对话立即生效）。
> - **安全性与重置**：`piVersion` 未变化时跳过提取 Pi 提示词，但每次启动仍会校验文件结构完整性并保留你的所有 `userModified` 修改；若删除 `userModified` 下某个字段或删掉整份文件，下次启动会自动按 `extensionBuiltIn` 重建。

---

## 🛠️ 安装与使用

### 📦 安装 / 加载

> [!NOTE]
> 如果你之前安装过已废弃的 `pi-provider-antigravity`，请先执行 `pi remove npm:pi-provider-antigravity` 卸载旧包再安装本扩展，因为两者共享 `antigravity` Provider ID、`/antigravity` 命令及 `~/.pi/agent/pi-provider-antigravity*.json` 配置文件路径。

```bash
# 方式 A：通过 npm 安装（推荐）
pi install npm:pi-provider-antigravity2

# 方式 B：免安装临时试用
pi -e npm:pi-provider-antigravity2

# 方式 C：从本地克隆加载或软链接
pi -e /path/to/repo
# 或：ln -s /path/to/repo/pi-provider-antigravity2 ~/.pi/agent/extensions/pi-provider-antigravity2
```

登录后，先拉取模型列表，再选择 `antigravity` 模型：

```text
/login antigravity
/antigravity refresh
/model
```

只有 `/antigravity models` 和 `/antigravity refresh` 会联网拉取 Antigravity 模型目录。启动、`/model` 和 `/scoped-models` 都使用已保存的目录。首次无头部署时，先在交互会话中刷新一次，或将已有的 `pi-provider-antigravity-models.json` 复制到 Pi 的 agent 目录。旧版 Pi `models-store.json` 里的缓存仍可作为回退。

#### 导入已有的 `agy` 登录（Linux）

如果已在本机 `agy` 登录个人 Google 账号，在 Pi 中执行 `/antigravity import-agy`。命令通过 `busctl` 检查当前用户的 Secret Service，用 `secret-tool`（libsecret）读取已解锁的条目；没有钥匙串条目时，检查私有后备文件 `~/.gemini/antigravity-cli/antigravity-oauth-token`。续期验证通过才保存。已有 Pi 登录时，覆盖前需确认。

命令不会改动 `agy` 登录或 Provider 配置。导入的登录和匹配的 OAuth 客户端凭据保存在仅当前用户可读写的 Pi `auth.json` 中；显式设置的 OAuth 环境变量仍优先。此功能依赖 `agy` 的凭据格式，升级后可能失效。导入成功后不需要执行 `sync-client`。如果没有缓存的 Antigravity 模型，先执行 `/antigravity refresh`，再用 `/model` 选择；已有可用模型就直接用 `/model`。

#### 🪪 使用 Refresh Token（RT）免浏览器登录（`auth.json`)

如果你已经有现成的 Google OAuth Refresh Token（例如无头服务器、容器环境或从已有凭证迁移），无需走浏览器交互登录，直接写入 `$PI_CODING_AGENT_DIR/auth.json`（默认 `~/.pi/agent/auth.json`）即可：

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

- `type`：固定为 `"oauth"`。
- `refresh`：填入你的 Refresh Token（`1//...`；即使不小心多粘了前导连字符 `-1//...`，扩展也会自动清理）。
- `access` 与 `expires`：保持 `""` 和 `0` 即可。请求需要凭据时，Pi 会用 `refresh` 换取 `access_token`，扩展会自动解析 `projectId`。
- 建议将权限收紧为仅当前用户可读：`chmod 600 ~/.pi/agent/auth.json`。

### 空闲断连

推荐安装独立扩展 `pi-provider-afk`，以减少 Pi 空闲时不必要的后台请求。目前尚不清楚这类请求是否是导致账号封禁的因素之一，安装该扩展也不代表可以避免封禁。

默认空闲 90 秒后断连。打开 `/provider-afk` → **Providers**，选中 `antigravity` 并按 Enter 可切换为保持连接。不安装则没有空闲计时器。

### 💬 内置命令与工具

- **`/antigravity usage`**：查看当前 5 小时与每周配额池进度条及重置时间
- **`/antigravity models`**：刷新并显示推荐/可用模型、上下文窗口与剩余配额
- **`/antigravity refresh`**：刷新同一份模型目录，不打印列表
- **`/antigravity sync-client`**：从本机 `agy` 同步 OAuth Client ID、Secret 和 User-Agent，已登录且 Client ID 变化时，只更新 User-Agent，保留原 OAuth 凭据；执行 `/login antigravity` 切换。
- **`/antigravity import-agy`**：Linux 上免浏览器导入本机 `agy` 的个人 Google OAuth 登录。
- **`/antigravity settings`**：交互式配置界面（写入 `~/.pi/agent/pi-provider-antigravity.json`）：
  - `Quota footer`（`"off"` / `"smart"` / `"all"`）：底部状态栏配额显示模式
  - `Unsigned tool calls`（`"fail"` / `"skip"`）：处理跨 Provider 丢失 `thoughtSignature` 的策略
- **`/antigravity websearch <query>`** & **`antigravity_websearch` 工具**：通过原生 HTTP 调用 Google Search Grounding，并添加内联来源引用。没有网页来源的回复会报告为搜索失败。

---

## 🧪 开发与离线测试

本项目所有源码均采用原生可擦除 TypeScript（显式 `.ts` 导入，零第三方运行时依赖），可直接在 Node v22.19+ 上运行单元测试：

```bash
npm test
# 等价于：node --experimental-strip-types --test tests/*.test.ts
```

### 📁 目录结构

- [pi-provider-antigravity2/index.ts](pi-provider-antigravity2/index.ts) — Pi 扩展入口、Provider 与命令/工具注册
- [pi-provider-antigravity2/auth.ts](pi-provider-antigravity2/auth.ts) — OAuth PKCE 登录、Token 刷新、`loadCodeAssist` 项目解析
- [pi-provider-antigravity2/protocol.ts](pi-provider-antigravity2/protocol.ts) — Cloud Code HTTP/SSE 客户端与结构化异常
- [pi-provider-antigravity2/model-identity.ts](pi-provider-antigravity2/model-identity.ts) & [model-catalog.ts](pi-provider-antigravity2/model-catalog.ts) — 模型族识别、目录刷新、`xhigh` 思考配置与冷启动预引导
- [pi-provider-antigravity2/default-prompts.json](pi-provider-antigravity2/default-prompts.json) & [prompts.ts](pi-provider-antigravity2/prompts.ts) — 外置默认提示词与 `pi-provider-antigravity-prompts.json` 生命周期管理
- [pi-provider-antigravity2/builder.ts](pi-provider-antigravity2/builder.ts) — 出站系统提示词局部适配、Tool Schema 清洗、多轮历史与签名转换
- [pi-provider-antigravity2/sse.ts](pi-provider-antigravity2/sse.ts) & [stream.ts](pi-provider-antigravity2/stream.ts) — SSE 增量解析、合成 429 自动退避剥离与 401 恢复
- [pi-provider-antigravity2/config.ts](pi-provider-antigravity2/config.ts)、[settings.ts](pi-provider-antigravity2/settings.ts)、[quota-status.ts](pi-provider-antigravity2/quota-status.ts)、[search.ts](pi-provider-antigravity2/search.ts)、[commands.ts](pi-provider-antigravity2/commands.ts) — 配置持久化、配额状态栏、搜索工具与 `/antigravity` 命令路由
