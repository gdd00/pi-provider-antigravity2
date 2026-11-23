import {
  calculateCost,
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
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
import { AntigravityAuthError, getApiKey, loginAntigravity, refreshAntigravityToken, syncAntigravityClient } from "./auth.ts";
import { createAntigravityCommands } from "./commands.ts";
import { getAgentDir } from "./config.ts";
import { PROVIDER_API } from "./constants.ts";
import { importAgyLogin } from "./import-agy.ts";
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

function isOfflineMode(): boolean {
  if (process.argv.includes("--offline")) return true;
  const raw = process.env.PI_OFFLINE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Pi extension entrypoint registering the Antigravity provider, OAuth flow,
 * `/antigravity` management command, quota footer status, and `antigravity_websearch` tool.
 */
export default function antigravityProviderExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const promptsFile = initializePromptSync(pi, { agentDir, piVersion: PI_VERSION });

  const afk = bindProviderAfk(pi);
  const client = createAntigravityClient({ fetch: afk.fetch });
  const catalog = createModelCatalog({ client, agentDir });
  const quotaStatus = createQuotaStatus({ client });
  // No refreshModels hook: Pi's model selectors must not start catalog or OAuth I/O.
  const registerModels = (models: Array<Model<any>>) => {
    pi.registerProvider(PROVIDER_ID, {
      name: PROVIDER_NAME,
      baseUrl: DEFAULT_ENDPOINT,
      api: PROVIDER_API,
      models,
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
    });
  };
  registerModels(catalog.loadCachedModels());

  const commands = createAntigravityCommands({
    quotaStatus,
    catalog,
    client,
    async refreshModels(ctx) {
      if (isOfflineMode()) throw new Error("Cannot refresh models in offline mode.");
      const models = await catalog.refresh(ctx, afk.signal(ctx.signal));
      registerModels(models);
    },
    syncClient: (signal) => syncAntigravityClient(afk.signal(signal), afk.fetch),
    importAgy: (signal, confirmReplace) => {
      if (isOfflineMode()) throw new AntigravityAuthError("Cannot import agy login in offline mode.");
      return importAgyLogin(afk.signal(signal), afk.fetch, { confirmReplace });
    },
    uiDeps: {
      getSettingsListTheme,
      createSettingsList: (items, maxVisible, theme, onChange, onCancel) =>
        new SettingsList(items, maxVisible, theme, onChange, onCancel),
    },
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
