import type { Theme } from "@earendil-works/pi-coding-agent";
import { resolveCredentials } from "./auth.ts";
import type { ProviderFileConfig, SettingsFieldDef } from "./config.ts";
import type { QuotaStatus } from "./quota-status.ts";

export type QuotaFooterMode = "off" | "smart" | "all";
export type UnsignedToolCallsMode = "fail" | "skip";

export const QUOTA_FOOTER_OPTIONS: readonly QuotaFooterMode[] = Object.freeze([
  "off",
  "smart",
  "all",
]);

export const QUOTA_FOOTER_NOTES: Readonly<Record<string, string>> = Object.freeze({
  smart:
    "Picks whichever window runs out first (5h or weekly), weighting the weekly pool by a ratio learned from your usage",
  all: "Lists every window of the pool backing the current model (5h or weekly)",
});

export const UNSIGNED_TOOL_CALLS_OPTIONS: readonly UnsignedToolCallsMode[] = Object.freeze([
  "fail",
  "skip",
]);

export const UNSIGNED_TOOL_CALLS_NOTES: Readonly<Record<string, string>> = Object.freeze({
  fail: "The request fails with 400, so the lost signature stays visible.",
  skip: "Sends skip_thought_signature_validator; reasoning may degrade for the rest of the turn.",
});

const QUOTA_PREVIEW_LOADING = "loading…";
const QUOTA_PREVIEW_LOGGED_OUT = "log in to preview (/login antigravity)";

/**
 * Normalizes a raw quotaFooter config value or returns undefined if invalid.
 */
export function normalizeQuotaFooter(value: unknown): QuotaFooterMode | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return QUOTA_FOOTER_OPTIONS.includes(v as QuotaFooterMode)
    ? (v as QuotaFooterMode)
    : undefined;
}

/**
 * Resolves the quotaFooter display mode from a parsed config object (defaults to `"off"`).
 */
export function resolveQuotaFooter(config?: ProviderFileConfig): QuotaFooterMode {
  return normalizeQuotaFooter(config?.settings?.quotaFooter) ?? "off";
}

/**
 * Creates the SettingsFieldDef for the quota footer display setting.
 */
export function createQuotaFooterField(quotaStatus?: QuotaStatus): SettingsFieldDef {
  let pending: string | undefined;
  return {
    key: "quotaFooter",
    label: "Quota footer",
    description: "Show remaining quota in Pi's status footer",
    options: QUOTA_FOOTER_OPTIONS,
    defaultValue: "off",
    optionNotes: QUOTA_FOOTER_NOTES,
    renderPreview: quotaStatus
      ? (mode, ctx, theme) => {
          if (mode === "off") return "hidden";
          const activeTheme = theme || (ctx.ui as { theme?: Theme })?.theme;
          return quotaStatus.previewFooter(ctx.model?.id, mode, activeTheme) ?? pending;
        }
      : undefined,
    prepare: quotaStatus
      ? async (ctx) => {
          let loggedIn = true;
          pending = QUOTA_PREVIEW_LOADING;
          try {
            loggedIn = (await resolveCredentials(ctx)) !== null;
            if (loggedIn) await quotaStatus.ensurePreview(ctx);
          } finally {
            pending = loggedIn ? undefined : QUOTA_PREVIEW_LOGGED_OUT;
          }
        }
      : undefined,
    onChange: quotaStatus
      ? async (ctx) => {
          if (quotaStatus.mode() !== "off") {
            await quotaStatus.refresh(ctx, { ignoreMode: true });
          }
          quotaStatus.paint(ctx);
        }
      : undefined,
  };
}

/**
 * Resolves the unsignedToolCalls mode from a parsed config object (defaults to `"fail"`).
 */
export function resolveUnsignedToolCalls(config?: ProviderFileConfig): UnsignedToolCallsMode {
  return config?.settings?.unsignedToolCalls === "skip" ? "skip" : "fail";
}

/**
 * Creates the SettingsFieldDef for unsigned Gemini tool call behavior.
 */
export function createUnsignedToolCallsField(): SettingsFieldDef {
  return {
    key: "unsignedToolCalls",
    label: "Unsigned tool calls",
    description: "What to do when a Gemini tool call has lost its thoughtSignature.",
    options: UNSIGNED_TOOL_CALLS_OPTIONS,
    defaultValue: "fail",
    optionNotes: UNSIGNED_TOOL_CALLS_NOTES,
  };
}
