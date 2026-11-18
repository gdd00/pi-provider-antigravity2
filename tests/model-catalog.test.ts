import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  bootstrapCatalogFromDiskOrAuth,
  buildDynamicPublicModels,
  createModelCatalog,
  extractBaseModelId,
  parseAvailableModels,
  PRIVATE_SNAPSHOT_KEY,
  resolveModelPlan,
  resolveThinkingConfig,
} from "../pi-provider-antigravity2/model-catalog.ts";

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

test("catalog persistence round-trips numeric xhigh thinkingLevel and handles offline restore", async () => {
  const persistedWrites: Array<any> = [];
  const catalog = createModelCatalog({
    client: {
      endpoint: "https://daily-cloudcode-pa.googleapis.com",
      userAgent: "antigravity/cli/1.5.7",
      async fetchAvailableModels() {
        return LIVE_CATALOG_FIXTURE;
      },
      async retrieveQuotaSummary() {
        return undefined;
      },
      async streamGenerateContent() {
        throw new Error("unused");
      },
      async postJson() {
        throw new Error("unused");
      },
    },
  });

  const models = await catalog.refresh({
    apiKey: "ya29.test",
    allowNetwork: true,
    async publish(pub) {
      persistedWrites.push(pub.persist);
      return true;
    },
  });
  assert.ok(models.some((m) => m.id === "gemini-4-hydrogen"));
  assert.equal(persistedWrites.length, 1);
  assert.equal(catalog.getWebSearchModelId(), "gemini-search-primary");
  assert.deepEqual(
    persistedWrites[0][PRIVATE_SNAPSHOT_KEY].webSearchModelIds,
    LIVE_CATALOG_FIXTURE.webSearchModelIds,
  );
  assert.ok(!models.some((m) => m.id === "gemini-search-primary"));

  const restoredCatalog = createModelCatalog();
  const offlineModels = await restoredCatalog.refresh({
    allowNetwork: false,
    stored: {
      models,
      checkedAt: Date.now(),
      [PRIVATE_SNAPSHOT_KEY]: persistedWrites[0][PRIVATE_SNAPSHOT_KEY],
    },
  });
  assert.equal(offlineModels.length, models.length);
  assert.equal(restoredCatalog.getWebSearchModelId(), "gemini-search-primary");
  restoredCatalog.generation().snapshot.webSearchModelIds?.reverse();
  assert.equal(restoredCatalog.getWebSearchModelId(), "gemini-search-primary");
  const plan = resolveModelPlan(
    "gemini-4-hydrogen",
    "xhigh",
    restoredCatalog.generation().snapshot,
  );
  assert.deepEqual(plan.thinkingConfig, { includeThoughts: true, thinkingLevel: 100 });
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

test("bootstrapCatalogFromDiskOrAuth boots cold from auth.json without mutating disk and skips network when models-store.json exists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-boot-"));
  try {
    // 1. Cold start: empty models-store.json, OAuth refresh-only auth.json (empty access, expires: 0)
    const authFile = path.join(dir, "auth.json");
    const initialAuthRaw = JSON.stringify({
      antigravity: {
        type: "oauth",
        refresh: "-1//03_cold_start_rt",
        access: "",
        expires: 0,
      },
    });
    fs.writeFileSync(authFile, initialAuthRaw, "utf-8");
    fs.writeFileSync(
      path.join(dir, "pi-provider-antigravity.json"),
      JSON.stringify({ oauthClientId: "test-client-id", oauthClientSecret: "test-client-secret" }),
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "models-store.json"), "{}", "utf-8");

    const fetchRequests: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      fetchRequests.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        const params = new URLSearchParams(String(init?.body ?? ""));
        assert.equal(params.get("refresh_token"), "1//03_cold_start_rt");
        return new Response(JSON.stringify({ access_token: "ya29.cold", expires_in: 3600 }), {
          status: 200,
        });
      }
      if (url.includes("v1internal:loadCodeAssist")) {
        return new Response(JSON.stringify({ cloudaicompanionProject: "cold-proj" }), {
          status: 200,
        });
      }
      if (url.includes("v1internal:fetchAvailableModels")) {
        const authHeader =
          init?.headers instanceof Headers
            ? init.headers.get("Authorization")
            : (init?.headers as Record<string, string>)?.Authorization;
        assert.equal(authHeader, "Bearer ya29.cold");
        return new Response(JSON.stringify(LIVE_CATALOG_FIXTURE), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const bootstrapped = await bootstrapCatalogFromDiskOrAuth({
      agentDir: dir,
      offline: false,
      fetchImpl: mockFetch,
    });
    assert.equal(bootstrapped.fromStore, false);
    assert.ok(bootstrapped.models.some((m) => m.id === "gemini-4-hydrogen"));
    assert.equal(fetchRequests.length, 3);
    // auth.json must remain unmodified on disk.
    assert.equal(fs.readFileSync(authFile, "utf-8"), initialAuthRaw);

    // Next, Pi immediately calls refresh({ allowNetwork: false, stored: undefined, publish }).
    const offlinePersisted: Array<any> = [];
    const coldOfflineRefresh = await bootstrapped.catalog.refresh({
      allowNetwork: false,
      stored: undefined,
      async publish(pub) {
        offlinePersisted.push(pub.persist);
        return true;
      },
    });
    assert.equal(coldOfflineRefresh.length, bootstrapped.models.length);
    assert.equal(offlinePersisted.length, 1);
    assert.ok(offlinePersisted[0][PRIVATE_SNAPSHOT_KEY]);

    // 2. Subsequent startup with populated models-store.json makes zero network calls.
    fs.writeFileSync(
      path.join(dir, "models-store.json"),
      JSON.stringify({ antigravity: offlinePersisted[0] }),
      "utf-8",
    );
    const warmStart = await bootstrapCatalogFromDiskOrAuth({
      agentDir: dir,
      offline: false,
      fetchImpl: async () => {
        throw new Error("should not perform network calls when models-store.json is populated");
      },
    });
    assert.equal(warmStart.fromStore, true);
    assert.equal(warmStart.models.length, bootstrapped.models.length);
    assert.equal(warmStart.catalog.getWebSearchModelId(), "gemini-search-primary");
    assert.deepEqual(
      warmStart.catalog.resolvePlan("gemini-4-hydrogen", "xhigh").thinkingConfig,
      { includeThoughts: true, thinkingLevel: 100 },
    );

    // 3. Empty store + offline: true makes zero network calls and returns empty list gracefully.
    fs.writeFileSync(path.join(dir, "models-store.json"), "{}", "utf-8");
    const offlineEmpty = await bootstrapCatalogFromDiskOrAuth({
      agentDir: dir,
      offline: true,
      fetchImpl: async () => {
        throw new Error("should not perform network calls in offline mode");
      },
    });
    assert.equal(offlineEmpty.fromStore, false);
    assert.deepEqual(offlineEmpty.models, []);

    // 4. Bootstrap catches network/auth errors gracefully without throwing.
    const failedBootstrap = await bootstrapCatalogFromDiskOrAuth({
      agentDir: dir,
      offline: false,
      fetchImpl: async () => new Response("Internal error", { status: 500 }),
    });
    assert.equal(failedBootstrap.fromStore, false);
    assert.deepEqual(failedBootstrap.models, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog.refresh with allowNetwork: true refreshes empty credential.access via credential.refresh", async () => {
  const prevId = process.env.ANTIGRAVITY_CLIENT_ID;
  const prevSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
  process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
  process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";
  try {
  const persisted: Array<any> = [];
  const catalog = createModelCatalog({
    fetchImpl: async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "ya29.refresh-ctx", expires_in: 3600 }), {
          status: 200,
        });
      }
      if (url.includes("v1internal:loadCodeAssist")) {
        return new Response(JSON.stringify({ cloudaicompanionProject: "ctx-proj" }), { status: 200 });
      }
      if (url.includes("v1internal:fetchAvailableModels")) {
        return new Response(JSON.stringify(LIVE_CATALOG_FIXTURE), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const refreshedModels = await catalog.refresh({
    allowNetwork: true,
    credential: {
      type: "oauth",
      refresh: "-1//03_ctx_rt",
      access: "",
      expires: 0,
    },
    async publish(pub) {
      persisted.push(pub.persist);
      return true;
    },
  });

  assert.ok(refreshedModels.some((m) => m.id === "gemini-4-hydrogen"));
  assert.equal(persisted.length, 1);
  } finally {
    if (prevId === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID; else process.env.ANTIGRAVITY_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET; else process.env.ANTIGRAVITY_CLIENT_SECRET = prevSecret;
  }
});
