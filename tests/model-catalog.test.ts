import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildDynamicPublicModels,
  createModelCatalog,
  extractBaseModelId,
  MODEL_CACHE_FILE,
  parseAvailableModels,
  PRIVATE_SNAPSHOT_KEY,
  resolveModelPlan,
  resolveThinkingConfig,
} from "../pi-provider-antigravity2/model-catalog.ts";
import { createAntigravityClient } from "../pi-provider-antigravity2/protocol.ts";

/**
 * Representative snapshot matching live v1internal:fetchAvailableModels fields observed in catalog_live.json.
 */
const LIVE_CATALOG_FIXTURE = {
  webSearchModelIds: ["gemini-search-primary", "gemini-search-secondary"],
  models: {
    "gemini-4-hydrogen-low": {
      displayName: "Gemini 4 Hydrogen (Low)",
      supportsImages: true,
      supportsThinking: true,
      minThinkingBudget: 32,
      maxTokens: 1048576,
      maxOutputTokens: 262144,
      quotaInfo: { remainingFraction: 0.63763136 },
      model: "MODEL_PLACEHOLDER_M523",
      thinkingLevel: 1,
    },
    "gemini-4-hydrogen-medium": {
      displayName: "Gemini 4 Hydrogen (Medium)",
      supportsImages: true,
      supportsThinking: true,
      minThinkingBudget: 32,
      maxTokens: 1048576,
      maxOutputTokens: 262144,
      quotaInfo: { remainingFraction: 0.63763136 },
      model: "MODEL_PLACEHOLDER_M524",
      thinkingLevel: 2,
    },
    "gemini-4-hydrogen-high": {
      displayName: "Gemini 4 Hydrogen (High)",
      supportsImages: true,
      supportsThinking: true,
      minThinkingBudget: 32,
      maxTokens: 1048576,
      maxOutputTokens: 262144,
      quotaInfo: { remainingFraction: 0.63763136 },
      model: "MODEL_PLACEHOLDER_M525",
      thinkingLevel: 3,
    },
    "gemini-4-hydrogen-xhigh": {
      displayName: "Gemini 4 Hydrogen (XHigh)",
      supportsImages: true,
      supportsThinking: true,
      minThinkingBudget: 32,
      maxTokens: 1048576,
      maxOutputTokens: 262144,
      quotaInfo: { remainingFraction: 0.63763136 },
      model: "MODEL_PLACEHOLDER_M528",
      thinkingLevel: 100,
    },
    "claude-sonnet-5-5-low": {
      displayName: "Claude Sonnet 5.5 (Low)",
      supportsImages: true,
      supportsThinking: true,
      maxTokens: 1000000,
      maxOutputTokens: 128000,
      quotaInfo: { remainingFraction: 0.9925392 },
      model: "MODEL_PLACEHOLDER_M410",
      thinkingLevel: 1,
      supportsAdaptiveThinking: true,
    },
    "claude-sonnet-5-5-high": {
      displayName: "Claude Sonnet 5.5 (High)",
      supportsImages: true,
      supportsThinking: true,
      maxTokens: 1000000,
      maxOutputTokens: 128000,
      quotaInfo: { remainingFraction: 0.9925392 },
      model: "MODEL_PLACEHOLDER_M412",
      thinkingLevel: 3,
      supportsAdaptiveThinking: true,
    },
    "claude-opus-5-5-medium": {
      displayName: "Claude Opus 5.5 (Medium)",
      supportsImages: true,
      supportsThinking: true,
      maxTokens: 1000000,
      maxOutputTokens: 128000,
      quotaInfo: { remainingFraction: 0.9925392 },
      model: "MODEL_PLACEHOLDER_M401",
      thinkingLevel: 2,
      supportsAdaptiveThinking: true,
    },
    "claude-sonnet-4-5-thinking": {
      displayName: "Claude Sonnet 4.5 (Thinking)",
      supportsImages: true,
      supportsThinking: true,
      thinkingBudget: 32000,
      maxTokens: 200000,
      maxOutputTokens: 16384,
      model: "MODEL_PLACEHOLDER_M301",
    },
    "gemini-3.5-flash-lite": {
      displayName: "Gemini 3.5 Flash Lite",
      supportsImages: true,
      supportsThinking: true,
      thinkingBudget: -1,
      thinkingLevel: 1,
      maxTokens: 1048576,
      maxOutputTokens: 65535,
      model: "MODEL_PLACEHOLDER_M198",
    },
    "gpt-oss-120b-medium": {
      displayName: "GPT-OSS 120B (Medium)",
      supportsThinking: true,
      thinkingBudget: 8192,
      maxTokens: 131072,
      maxOutputTokens: 32768,
      model: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
    },
    "gemini-2.5-pro": {
      displayName: "Gemini 2.5 Pro",
      supportsImages: true,
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      model: "MODEL_GOOGLE_GEMINI_2_5_PRO",
    },
    "gemini-future-level5-high": {
      displayName: "Gemini Future Rank 5",
      supportsThinking: true,
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      model: "MODEL_PLACEHOLDER_M999",
      thinkingLevel: 5,
    },
    chat_20706: {
      maxTokens: 16384,
      model: "MODEL_CHAT_20706",
      isInternal: true,
    },
    tab_999: {
      maxTokens: 4096,
      model: "MODEL_TAB_999",
    },
    "gemini-4-carbon-disabled": {
      displayName: "Gemini 4 Carbon",
      disabled: true,
      model: "MODEL_DISABLED",
    },
  },
  agentModelSorts: [
    {
      groups: [
        {
          modelIds: [
            "gemini-4-hydrogen-high",
            "gemini-4-hydrogen-xhigh",
            "gemini-4-hydrogen-medium",
            "gemini-4-hydrogen-low",
            "claude-opus-5-5-medium",
            "claude-sonnet-5-5-low",
            "claude-sonnet-5-5-high",
            "gpt-oss-120b-medium",
            "gemini-4-carbon-disabled",
          ],
        },
      ],
    },
  ],
};

test("parseAvailableModels filters internal/disabled models and builds public tiers with xhigh", () => {
  assert.equal(extractBaseModelId("gemini-4-hydrogen-xhigh"), "gemini-4-hydrogen");
  const parsed = parseAvailableModels(LIVE_CATALOG_FIXTURE);
  const ids = parsed.models.map((m) => m.id);
  assert.equal(ids.includes("chat_20706"), false);
  assert.equal(ids.includes("tab_999"), false);
  assert.equal(ids.includes("gemini-4-carbon-disabled"), false);
  assert.equal(ids.includes("gemini-4-hydrogen-xhigh"), true);

  const dynamic = buildDynamicPublicModels(parsed);
  const hydrogen = dynamic.find((m) => m.id === "gemini-4-hydrogen");
  assert.ok(hydrogen);
  assert.equal(hydrogen.contextWindow, 1048576);
  assert.equal(hydrogen.maxTokens, 262144);
  assert.deepEqual(hydrogen.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: null,
  });

  const sonnet55 = dynamic.find((m) => m.id === "claude-sonnet-5-5");
  assert.ok(sonnet55);
  assert.equal(sonnet55.thinkingLevelMap?.xhigh, null);
  assert.equal(sonnet55.thinkingLevelMap?.high, "high");
});

test("resolveThinkingConfig maps 1/2/3 to LOW/MEDIUM/HIGH and preserves numeric levels > 3", () => {
  const catalog = createModelCatalog();
  catalog.record(LIVE_CATALOG_FIXTURE);
  const snapshot = catalog.generation().snapshot;

  assert.deepEqual(resolveThinkingConfig("gemini-4-hydrogen-low", snapshot), {
    includeThoughts: true,
    thinkingLevel: "LOW",
  });
  assert.deepEqual(resolveThinkingConfig("gemini-4-hydrogen-medium", snapshot), {
    includeThoughts: true,
    thinkingLevel: "MEDIUM",
  });
  assert.deepEqual(resolveThinkingConfig("gemini-4-hydrogen-high", snapshot), {
    includeThoughts: true,
    thinkingLevel: "HIGH",
  });
  assert.deepEqual(resolveThinkingConfig("gemini-4-hydrogen-xhigh", snapshot), {
    includeThoughts: true,
    thinkingLevel: 100,
  });
  assert.deepEqual(resolveThinkingConfig("gemini-future-level5-high", snapshot), {
    includeThoughts: true,
    thinkingLevel: 5,
  });
  assert.deepEqual(resolveThinkingConfig("gemini-3.5-flash-lite", snapshot), {
    includeThoughts: true,
    thinkingLevel: "LOW",
  });
  assert.deepEqual(resolveThinkingConfig("gpt-oss-120b-medium", snapshot), {
    includeThoughts: true,
    thinkingBudget: 8192,
  });
  assert.deepEqual(resolveThinkingConfig("claude-sonnet-4-5-thinking", snapshot), {
    includeThoughts: true,
    thinkingBudget: 32000,
  });
  assert.deepEqual(resolveThinkingConfig("gemini-2.5-pro", snapshot), {
    includeThoughts: false,
    thinkingBudget: 0,
  });

  const xhighPlan = catalog.resolvePlan("gemini-4-hydrogen", "xhigh");
  assert.equal(xhighPlan.runtimeModelId, "gemini-4-hydrogen-xhigh");
  assert.equal(xhighPlan.modelEnum, "MODEL_PLACEHOLDER_M528");
  assert.deepEqual(xhighPlan.thinkingConfig, { includeThoughts: true, thinkingLevel: 100 });
});

test("only explicit catalog refresh requests models; cache restores thinking and search IDs", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-models-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    antigravity: { type: "oauth", access: "", refresh: "unused", expires: 0 },
  }));
  const hits: string[] = [];
  const client = createAntigravityClient({
    fetch: async (input, init) => {
      hits.push(String(input));
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
      return Response.json(LIVE_CATALOG_FIXTURE);
    },
  });
  const catalog = createModelCatalog({ agentDir, client });

  assert.deepEqual(catalog.loadCachedModels(), []);
  assert.deepEqual(hits, []); // Even an authenticated cold start does not resolve credentials or fetch.
  const models = await catalog.refresh({
    modelRegistry: { getApiKeyForProvider: async () => "test-token" },
  });
  assert.match(hits[0], /\/v1internal:fetchAvailableModels$/);
  assert.equal(hits.length, 1);
  assert.ok(models.some((m) => m.id === "gemini-4-hydrogen"));
  assert.ok(!models.some((m) => m.id === "gemini-search-primary"));

  const restored = createModelCatalog({ agentDir, client });
  assert.deepEqual(restored.loadCachedModels(), models);
  assert.equal(hits.length, 1);
  assert.equal(restored.getWebSearchModelId(), "gemini-search-primary");
  restored.generation().snapshot.webSearchModelIds?.reverse();
  assert.equal(restored.getWebSearchModelId(), "gemini-search-primary");
  assert.deepEqual(restored.resolvePlan("gemini-4-hydrogen", "xhigh").thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: 100,
  });
});

test("catalog ignores invalid search IDs and accepts snapshots from before search discovery", () => {
  const catalog = createModelCatalog();
  catalog.restore({ modelEnums: {}, runtimeIds: ["chat-model"], thinking: {} });
  assert.equal(catalog.getWebSearchModelId(), undefined);
  catalog.record({
    webSearchModelIds: [null, "", "  gemini-search-primary  ", "gemini-search-secondary", "gemini-search-primary"],
  });
  assert.deepEqual(catalog.toPersisted()?.webSearchModelIds, LIVE_CATALOG_FIXTURE.webSearchModelIds);
  catalog.record({ webSearchModelIds: "invalid-server-data" });
  assert.equal(catalog.getWebSearchModelId(), undefined);
});

test("loads Pi's legacy cache until the first manual refresh", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-legacy-models-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const client = createAntigravityClient({ fetch: async () => Response.json(LIVE_CATALOG_FIXTURE) });
  const legacyFile = path.join(agentDir, "models-store.json");
  const legacy = {
    antigravity: {
      models: buildDynamicPublicModels(parseAvailableModels(LIVE_CATALOG_FIXTURE)).slice(0, 1),
      [PRIVATE_SNAPSHOT_KEY]: {
        runtimeIds: ["legacy"],
        modelEnums: {},
        thinking: {},
        webSearchModelIds: ["legacy-search"],
      },
    },
    unrelated: { models: [] },
  };
  const legacyJSON = JSON.stringify(legacy);
  fs.writeFileSync(legacyFile, legacyJSON);
  const catalog = createModelCatalog({ agentDir, client });
  assert.deepEqual(catalog.loadCachedModels(), legacy.antigravity.models);
  assert.equal(catalog.getWebSearchModelId(), "legacy-search");

  const fresh = await catalog.refresh("test-token");
  const restarted = createModelCatalog({ agentDir, client });
  assert.deepEqual(restarted.loadCachedModels(), fresh);
  assert.equal(restarted.getWebSearchModelId(), "gemini-search-primary");
  assert.equal(fs.readFileSync(legacyFile, "utf-8"), legacyJSON);
});

test("failed or cancelled manual refresh leaves last successful catalog and disk cache intact", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-refresh-models-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const controller = new AbortController();
  let fetchResult = () => Response.json(LIVE_CATALOG_FIXTURE);
  const client = createAntigravityClient({ fetch: async () => fetchResult() });
  const catalog = createModelCatalog({ agentDir, client });
  await catalog.refresh("test-token");
  const cacheFile = path.join(agentDir, MODEL_CACHE_FILE);
  const before = fs.readFileSync(cacheFile, "utf-8");
  const versionBefore = catalog.generation().version;

  fetchResult = () => Response.json({});
  await assert.rejects(catalog.refresh("test-token"), /No models were returned/);
  fetchResult = () => {
    controller.abort(new Error("cancelled"));
    return Response.json(LIVE_CATALOG_FIXTURE);
  };
  await assert.rejects(catalog.refresh("test-token", controller.signal), /cancelled/);
  assert.equal(fs.readFileSync(cacheFile, "utf-8"), before);
  assert.equal(catalog.generation().version, versionBefore);
});
