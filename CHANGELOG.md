# Changelog

## [0.2.1] - 2026-11-22

- Fetch the Antigravity model catalog only via `/antigravity models` or `/antigravity refresh`. Startup and Pi's model selectors use the local cache; selecting a model does not fetch quota.

## [0.2.0] - 2026-11-22

- Disconnect Antigravity after 90 seconds idle. Stop background requests, show AFK status above the Pi editor, and resume on the next prompt or provider command.
- On interactive login, rediscover the OAuth Client ID and matching Secret from local `agy` on Linux. Save changes after token exchange succeeds.
- Add `/antigravity sync-client` to sync local `agy` client settings without replacing existing login tokens.
- Store the Cloud Code Assist `userAgent` in `pi-provider-antigravity.json` and refresh it from local `agy` build metadata during login.
- Use model catalog search IDs for web grounding and correct source citation offsets.

## [0.1.1] - 2026-11-15

### Added

- Automatic runtime WAF 429 recovery (`waf-recovery.ts`, `stream.ts`): strips `requestType`, runs emergency Pi boilerplate sanitization, bisects unknown offending `systemInstruction` lines, and caches discovered snippets per process without mutating conversation history.

### Changed

- Stripped Pi `<docs>` boilerplate, `Updated/Removed system prompt section "docs"` notices, and `docs/codemode.md` references in `default-prompts.json`, and updated `prompts.ts` to merge newly added built-in rewrite rules into existing `pi-provider-antigravity-prompts.json` files.
- Updated `README.md` and `README-zh-hans.md` prompt-adaptation sections to document `<docs>` omission on `antigravity` and recommend switching providers for Pi-specific questions.

## [0.1.0] - 2026-11-15

### Added

- Antigravity (Google Cloud Code Assist `v1internal`) provider extension for Pi with native OAuth PKCE login, automatic `projectId` resolution, and cold-start model catalog bootstrap.
- Outbound-only system prompt preamble adaptation with `pi-provider-antigravity-prompts.json` (`piOriginal` / `extensionBuiltIn` / `userModified`) and synthetic 429 fallback retry.
- `/antigravity` management commands (`usage`, `models`, `refresh`, `settings`, `websearch`), status footer quota modes (`off`, `smart`, `all`), and `antigravity_websearch` tool.
