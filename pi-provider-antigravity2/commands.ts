import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AntigravityAuthError,
  NOT_LOGGED_IN,
  resolveCredentials,
  syncAntigravityClient,
} from "./auth.ts";
import { notifyCommandOutput, openSettings, type SettingsUiDeps } from "./config.ts";
import { PROVIDER_ID } from "./constants.ts";
import type { importAgyLogin } from "./import-agy.ts";
import type { ModelCatalog } from "./model-catalog.ts";
import type { AntigravityClient } from "./protocol.ts";
import { createQuotaStatus, type QuotaStatus } from "./quota-status.ts";
import { executeWebSearchCommand } from "./search.ts";
import { createQuotaFooterField, createUnsignedToolCallsField } from "./settings.ts";

export interface SubcommandCompletion {
  value: string;
  label: string;
  description: string;
}

export interface AntigravityCommandsDeps {
  quotaStatus?: QuotaStatus;
  catalog: ModelCatalog;
  refreshModels(ctx: ExtensionCommandContext): Promise<void>;
  client?: AntigravityClient;
  syncClient?: typeof syncAntigravityClient;
  importAgy?: (signal: AbortSignal | undefined, confirmReplace: () => Promise<boolean>) => ReturnType<typeof importAgyLogin>;
  uiDeps?: SettingsUiDeps;
}

export interface AntigravityCommands {
  handle(args: string, ctx: ExtensionCommandContext): Promise<void>;
  complete(prefix: string): SubcommandCompletion[] | null;
}

interface SubcommandContext extends AntigravityCommandsDeps {
  ctx: ExtensionCommandContext;
  subArgs?: string;
}

interface SubcommandDef {
  name: string;
  description: string;
  aliases?: readonly string[];
  run: (deps: SubcommandContext) => Promise<void> | void;
}

async function runCatalogSubcommand(
  { ctx, catalog, refreshModels }: SubcommandContext,
  showList: boolean,
): Promise<void> {
  try {
    if (ctx.hasUI) ctx.ui.notify("Refreshing models…", "info");
    await refreshModels(ctx);
    notifyCommandOutput(ctx, showList ? catalog.formatList() : "Antigravity models refreshed successfully.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (showList && catalog.generation().items) {
      notifyCommandOutput(ctx, `Failed to refresh models: ${message} Showing last known list.`, "warning");
      notifyCommandOutput(ctx, catalog.formatList());
    } else if (error instanceof AntigravityAuthError) {
      notifyCommandOutput(ctx, message, "warning");
    } else {
      notifyCommandOutput(ctx, `Failed to refresh models: ${message}`, "error");
    }
  }
}

async function runUsageSubcommand(
  ctx: ExtensionCommandContext,
  quotaStatus?: QuotaStatus,
): Promise<void> {
  if ((await resolveCredentials(ctx)) === null) {
    notifyCommandOutput(ctx, NOT_LOGGED_IN, "warning");
    return;
  }
  if (!quotaStatus) {
    notifyCommandOutput(ctx, "Quota status is unavailable.", "error");
    return;
  }
  try {
    if (ctx.hasUI) ctx.ui.notify("Fetching quota summary…", "info");
    const text = await quotaStatus.formatUsage(ctx);
    notifyCommandOutput(ctx, text);
  } catch (err: any) {
    notifyCommandOutput(ctx, `Failed to fetch usage: ${err?.message ?? String(err)}`, "error");
  }
}

async function runSyncClientSubcommand(
  ctx: ExtensionCommandContext,
  syncClient = syncAntigravityClient,
): Promise<void> {
  if (ctx.hasUI) ctx.ui.notify("Syncing client settings from local agy…", "info");
  try {
    const { oauth, userAgent } = await syncClient(ctx.signal);
    const oauthMessage = {
      updated: "OAuth client credentials updated.",
      unchanged: "OAuth client credentials already current.",
      "login-required": "Client ID has changed. Existing OAuth credentials kept; run /login antigravity.",
      overridden: "OAuth client credentials kept because environment overrides are set.",
      unavailable: "Could not verify OAuth client credentials from local agy. Existing values kept.",
    }[oauth];
    const userAgentMessage = {
      updated: "User-Agent updated.",
      unchanged: "User-Agent already current.",
      unavailable: "Could not read agy build metadata. User-Agent kept.",
    }[userAgent];
    const warning = (oauth !== "updated" && oauth !== "unchanged") || userAgent === "unavailable";
    notifyCommandOutput(ctx, `${oauthMessage} ${userAgentMessage}`, warning ? "warning" : "info");
  } catch (error) {
    if (ctx.signal?.aborted) return;
    const reason = error instanceof AntigravityAuthError ? ` ${error.message}` : "";
    notifyCommandOutput(ctx, `Failed to sync Antigravity client settings.${reason}`, "error");
  }
}

async function runImportAgySubcommand({ ctx, importAgy, subArgs }: SubcommandContext): Promise<void> {
  if (subArgs) {
    notifyCommandOutput(ctx, "Usage: /antigravity import-agy", "warning");
    return;
  }
  if (!importAgy) {
    notifyCommandOutput(ctx, "agy login import is unavailable.", "error");
    return;
  }
  try {
    await ctx.waitForIdle();
    const result = await importAgy(ctx.signal, async () =>
      ctx.hasUI && await ctx.ui.confirm("Replace Pi's Antigravity login?",
        "Use the account currently signed in to local agy. This does not change the agy login."));
    if (result === "cancelled") {
      notifyCommandOutput(ctx, "Import cancelled. Existing Pi login kept.", "info");
      return;
    }
  } catch (error) {
    if (ctx.signal?.aborted) return;
    const reason = error instanceof AntigravityAuthError ? ` ${error.message}` : "";
    notifyCommandOutput(ctx, `Failed to import agy login.${reason}`, "error");
    return;
  }

  try {
    const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], allowNetwork: false, signal: ctx.signal });
    if (result?.aborted || result?.errors.get(PROVIDER_ID)) throw new Error();
    const hasModels = ctx.modelRegistry.getAvailable().some((model) => model.provider === PROVIDER_ID);
    notifyCommandOutput(ctx, hasModels
      ? "agy login imported. Use /model to select an Antigravity model. No sync-client needed."
      : "agy login imported. Run /antigravity refresh to load models, then select one with /model. No sync-client needed.");
  } catch {
    notifyCommandOutput(ctx, "agy login saved. Restart Pi, then use /model. If no Antigravity models are listed, run /antigravity refresh. No sync-client needed.", "warning");
  }
}

function runLoginSubcommand(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) {
    ctx.ui.setEditorText("/login antigravity");
    ctx.ui.notify("Press Enter to log in to Antigravity.", "info");
  } else {
    notifyCommandOutput(ctx, "Please run /login antigravity to authenticate.");
  }
}

const SUBCOMMANDS: readonly SubcommandDef[] = Object.freeze([
  {
    name: "usage",
    description: "Show remaining 5h and weekly quota",
    run: ({ ctx, quotaStatus }) => runUsageSubcommand(ctx, quotaStatus),
  },
  {
    name: "models",
    description: "Refresh and list recommended models with context window and remaining quota",
    run: (deps) => runCatalogSubcommand(deps, true),
  },
  {
    name: "refresh",
    description: "Fetch the latest model list",
    run: (deps) => runCatalogSubcommand(deps, false),
  },
  {
    name: "sync-client",
    description: "Sync OAuth client credentials and User-Agent from local agy",
    run: ({ ctx, syncClient }) => runSyncClientSubcommand(ctx, syncClient),
  },
  {
    name: "import-agy",
    description: "Import the local agy Google OAuth login (Linux)",
    run: runImportAgySubcommand,
  },
  {
    name: "settings",
    description: "Configure provider settings",
    aliases: Object.freeze(["setting"]),
    run: async ({ ctx, quotaStatus, uiDeps }) => {
      const qs = quotaStatus ?? createQuotaStatus();
      await openSettings(ctx, [createQuotaFooterField(qs), createUnsignedToolCallsField()], {
        uiDeps,
      });
    },
  },
  {
    name: "websearch",
    description: "Search the web using Google Search Grounding",
    run: ({ ctx, subArgs, client, catalog }) =>
      executeWebSearchCommand(ctx, subArgs, client, catalog),
  },
  {
    name: "login",
    description: "Run /login antigravity",
    run: ({ ctx }) => runLoginSubcommand(ctx),
  },
]);

function buildUsageText(commands: readonly SubcommandDef[] = SUBCOMMANDS): string {
  const maxNameLen = Math.max(...commands.map((c) => c.name.length));
  const lines = commands.map((c) => {
    const aliasPart = c.aliases?.length ? ` (alias: ${c.aliases.join(", ")})` : "";
    return `  ${c.name.padEnd(maxNameLen)} ${c.description}${aliasPart}`;
  });
  return `Usage: /antigravity <command>\n\nCommands:\n${lines.join("\n")}`;
}

const USAGE_TEXT = buildUsageText();

function parseAntigravitySubcommand(args: string): string {
  const sub = (args || "").trim().toLowerCase();
  for (const cmd of SUBCOMMANDS) {
    if (cmd.name === sub || cmd.aliases?.includes(sub)) return cmd.name;
  }
  return sub;
}

/**
 * Creates the `/antigravity` command dispatcher with argument completion and subcommand routing.
 */
export function createAntigravityCommands(deps: AntigravityCommandsDeps): AntigravityCommands {
  return {
    async handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const raw = (args || "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const sub = parseAntigravitySubcommand(parts[0] || "");
      const subArgs = raw.slice(parts[0]?.length || 0).trim();
      const cmd = SUBCOMMANDS.find((c) => c.name === sub);
      if (cmd) {
        await cmd.run({
          ...deps,
          ctx,
          subArgs,
        });
        return;
      }
      notifyCommandOutput(ctx, USAGE_TEXT);
    },

    complete(prefix: string): SubcommandCompletion[] | null {
      const trimmed = prefix.trim();
      if (trimmed === "") {
        return SUBCOMMANDS.map((s) => ({
          value: s.name,
          label: s.name,
          description: s.description,
        }));
      }
      if (/\s/.test(trimmed)) return null;
      const lower = trimmed.toLowerCase();
      return SUBCOMMANDS.filter((s) => s.name.startsWith(lower)).map((s) => ({
        value: s.name,
        label: s.name,
        description: s.description,
      }));
    },
  };
}
