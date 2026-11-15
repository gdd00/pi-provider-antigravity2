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
import { getApiKey, loginAntigravity, refreshAntigravityToken } from "./auth.ts";
import { createAntigravityCommands } from "./commands.ts";
import { getAgentDir } from "./config.ts";
import { PROVIDER_API } from "./constants.ts";
import { initializePromptSync } from "./prompts.ts";
import { createModelCatalog } from "./model-catalog.ts";
import {
  DEFAULT_ENDPOINT,
  defaultAntigravityClient,
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

  const client = defaultAntigravityClient;
  const catalog = createModelCatalog({ client });
  const quotaStatus = createQuotaStatus({ client });
  const commands = createAntigravityCommands({
    quotaStatus,
    catalog,
    client,
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
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey,
    },
    streamSimple: (model, context, options) =>
      streamAntigravity(
        model,
        context,
        options as AntigravityStreamOptions | undefined,
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
        { promptsFile },
      ),
    refreshModels: async (context) => catalog.refresh(context),
  });

  quotaStatus.bind(pi);
  registerWebSearchTool(pi, { client, typeBuilder: Type, promptsFile });

  pi.registerCommand(PROVIDER_ID, {
    description: "Inspect Antigravity usage, models, and settings",
    getArgumentCompletions: (prefix) => commands.complete(prefix),
    handler: async (args, ctx) => commands.handle(args, ctx),
  });
}
