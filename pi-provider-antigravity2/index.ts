import {
  calculateCost,
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import {
  type ExtensionAPI,
  getSettingsListTheme,
  VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { bindProviderAfk } from "./afk.ts";
import { getApiKey, loginAntigravity, refreshAntigravityToken, syncAntigravityClient } from "./auth.ts";
import { createAntigravityCommands } from "./commands.ts";
import { getAgentDir } from "./config.ts";
import { PROVIDER_API } from "./constants.ts";
import { initializePromptSync } from "./prompts.ts";
import { createModelCatalog } from "./model-catalog.ts";
import {
  DEFAULT_ENDPOINT,
  createAntigravityClient,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./protocol.ts";
import { createQuotaStatus } from "./quota-status.ts";
import { registerWebSearchTool } from "./search.ts";
import { type AntigravityStreamOptions, streamAntigravity } from "./stream.ts";

const STARTUP_BOOTSTRAP_TIMEOUT_MS = 10_000;

function isOfflineStartup(): boolean {
  if (process.argv.includes("--offline")) return true;
  const raw = process.env.PI_OFFLINE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Pi extension entrypoint registering the Antigravity provider, OAuth flow,
 * `/antigravity` management command, quota footer status, and `antigravity_websearch` tool.
 */
export default async function antigravityProviderExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const promptsFile = initializePromptSync(pi, { agentDir, piVersion: PI_VERSION });

  const afk = bindProviderAfk(pi);
  const client = createAntigravityClient({ fetch: afk.fetch });
  const catalog = createModelCatalog({ client, fetchImpl: afk.fetch });
  const quotaStatus = createQuotaStatus({ client });
  const commands = createAntigravityCommands({
    quotaStatus,
    catalog,
    client,
    syncClient: (signal) => syncAntigravityClient(afk.signal(signal), afk.fetch),
    uiDeps: {
      getSettingsListTheme,
      createSettingsList: (items, maxVisible, theme, onChange, onCancel) =>
        new SettingsList(items, maxVisible, theme, onChange, onCancel),
    },
  });

  const offline = isOfflineStartup();
  const bootstrapController = new AbortController();
  const bootstrapTimer = setTimeout(() => {
    bootstrapController.abort(new Error("Antigravity startup catalog bootstrap timed out"));
  }, STARTUP_BOOTSTRAP_TIMEOUT_MS);
  if (typeof bootstrapTimer.unref === "function") {
    bootstrapTimer.unref();
  }

  let bootstrappedModels: Array<any> = [];
  try {
    const bootstrapped = await catalog.bootstrapFromDiskOrAuth({
      agentDir,
      client,
      offline,
      signal: bootstrapController.signal,
    });
    bootstrappedModels = bootstrapped.models;
  } catch {
    bootstrappedModels = [];
  } finally {
    clearTimeout(bootstrapTimer);
  }

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: PROVIDER_API,
    models: bootstrappedModels,
    oauth: {
      name: PROVIDER_NAME,
      isSubscription: true,
      login: (callbacks) => {
        afk.activity();
        return loginAntigravity({
          ...callbacks,
          onPrompt: async (prompt) => {
            const answer = await callbacks.onPrompt(prompt);
            afk.activity(); // The browser login can take longer than 90 seconds.
            return answer;
          },
        }, afk.fetch);
      },
      refreshToken: (credentials, signal) =>
        refreshAntigravityToken(credentials, afk.signal(signal), afk.fetch),
      getApiKey,
    },
    streamSimple: (model, context, options) =>
      streamAntigravity(
        model,
        context,
        { ...(options as AntigravityStreamOptions | undefined), signal: afk.signal(options?.signal) },
        catalog,
        client,
        {
          createStream: createAssistantMessageEventStream,
          calculateCost,
          contextHelpers: {
            collapseSystemMessages,
            getCurrentSystemPrompt,
            getCurrentTools,
          },
        },
        { promptsFile, fetchImpl: afk.fetch },
      ),
    refreshModels: (context) => catalog.refresh({
      ...context,
      allowNetwork: context.allowNetwork && !afk.signal().aborted,
      signal: afk.signal(context.signal),
    }),
  });

  quotaStatus.bind(pi, () => !afk.signal().aborted);
  registerWebSearchTool(pi, { client, catalog, typeBuilder: Type, promptsFile });

  pi.registerCommand(PROVIDER_ID, {
    description: "Manage Antigravity usage, models, client settings, and login",
    getArgumentCompletions: (prefix) => commands.complete(prefix),
    handler: async (args, ctx) => {
      afk.activity(); // Slash commands bypass Pi's input event.
      await commands.handle(args, ctx);
    },
  });
}
