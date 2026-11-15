# Changelog

## [0.1.0] - 2026-11-15

### Added

- Antigravity (Google Cloud Code Assist `v1internal`) provider extension for Pi with native OAuth PKCE login, automatic `projectId` resolution, and cold-start model catalog bootstrap.
- Outbound-only system prompt preamble adaptation with `pi-provider-antigravity-prompts.json` (`piOriginal` / `extensionBuiltIn` / `userModified`) and synthetic 429 fallback retry.
- `/antigravity` management commands (`usage`, `models`, `refresh`, `settings`, `websearch`), status footer quota modes (`off`, `smart`, `all`), and `antigravity_websearch` tool.
