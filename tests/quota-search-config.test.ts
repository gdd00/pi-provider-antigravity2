import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAntigravityCommands } from "../pi-provider-antigravity2/commands.ts";
import {
  applySettingValue,
  defaultConfigFile,
  loadProviderConfig,
  loadSubsystemState,
  notifyCommandOutput,
  PROVIDER_CONFIG_FILE,
  saveSubsystemState,
  updateProviderConfig,
  writeProviderConfigAtomically,
} from "../pi-provider-antigravity2/config.ts";
import { createModelCatalog } from "../pi-provider-antigravity2/model-catalog.ts";
import type { AntigravityClient } from "../pi-provider-antigravity2/protocol.ts";
import { createQuotaStatus, formatQuotaSummary, parseQuotaSummary } from "../pi-provider-antigravity2/quota-status.ts";
import { formatSearchResults, performWebSearch, registerWebSearchTool, SEARCH_MODEL, WEB_SEARCH_TOOL_NAME } from "../pi-provider-antigravity2/search.ts";
import {
  createQuotaFooterField,
  createUnsignedToolCallsField,
  resolveQuotaFooter,
  resolveUnsignedToolCalls,
} from "../pi-provider-antigravity2/settings.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ag2-test-"));
}

test("config and settings persist atomically while preserving unrelated keys", async () => {
  const dir = makeTempDir();
  try {
    const resolved = defaultConfigFile({ PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv);
    assert.equal(resolved, path.join(dir, PROVIDER_CONFIG_FILE));

    // Defaults when config is absent.
    assert.equal(resolveQuotaFooter(undefined), "off");
    assert.equal(resolveUnsignedToolCalls(undefined), "fail");

    assert.equal(
      writeProviderConfigAtomically(resolved, {
        settings: { unrelatedFlag: true },
        states: { other: { v: 1 } },
      }),
      true,
    );

    assert.equal(
      await applySettingValue(createQuotaFooterField(), "smart", resolved, {} as any),
      true,
    );
    assert.equal(
      await applySettingValue(createUnsignedToolCallsField(), "skip", resolved, {} as any),
      true,
    );
    assert.equal(saveSubsystemState("quota", { weeklyTo5hRatio: 4.5 }, resolved), true);
    assert.equal(
      updateProviderConfig(resolved, (cfg) => {
        cfg.settings = { ...(cfg.settings || {}), custom: "kept" };
      }),
      true,
    );

    const loaded = loadProviderConfig(resolved);
    assert.equal(resolveQuotaFooter(loaded), "smart");
    assert.equal(resolveUnsignedToolCalls(loaded), "skip");
    assert.equal(loaded?.settings?.unrelatedFlag, true);
    assert.equal(loaded?.settings?.custom, "kept");
    assert.deepEqual(loadSubsystemState("other", resolved), { v: 1 });
    assert.deepEqual(loadSubsystemState("quota", resolved), { weeklyTo5hRatio: 4.5 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("quota-status parses, formats, calibrates 5h/weekly ratio, and renders smart/all/off footers", () => {
  const nowMs = Date.parse("2026-11-15T12:00:00Z");
  const raw = {
    groups: [
      {
        displayName: "Gemini",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Gemini Weekly",
            window: "weekly",
            remainingFraction: 0.8,
            resetTime: "2026-11-17T12:00:00Z",
          },
          {
            bucketId: "gemini-5h",
            displayName: "Gemini 5h",
            window: "5h",
            remainingFraction: 0.25,
            resetTime: "2026-11-15T14:30:00Z",
          },
        ],
      },
      {
        displayName: "Argon",
        buckets: [
          {
            bucketId: "argon-5h",
            displayName: "Argon 5h",
            window: "5h",
            remainingFraction: 0.08,
            resetTime: "2026-11-15T12:20:00Z",
          },
          {
            bucketId: "argon-weekly",
            displayName: "Argon Weekly",
            window: "weekly",
            remainingFraction: 0.9,
          },
        ],
      },
    ],
  };

  const summary = parseQuotaSummary(raw);
  assert.equal(summary.groups.length, 2);
  const formatted = formatQuotaSummary(summary, () => nowMs);
  assert.match(formatted, /5h\s+\[###-------\]\s+25% left \(in 2h 30m\)/);
  assert.match(formatted, /Wk\s+\[########--\]\s+80% left \(in 2d 0h\)/);

  const dir = makeTempDir();
  try {
    const cfgFile = path.join(dir, PROVIDER_CONFIG_FILE);
    const qs = createQuotaStatus({ configFile: cfgFile, now: () => nowMs }) as any;
    assert.equal(qs.ratio, 6.0);

    qs.ingest(raw);
    const smartGemini = qs.renderFooter("gemini-4-hydrogen-high", "smart");
    assert.equal(smartGemini.plain, "5h 25% (2h 30m)");
    // 25% triggers warning yellow (\x1b[33m)
    assert.ok(smartGemini.colored?.includes("\x1b[33m"));

    const allArgon = qs.renderFooter("gemini-4-argon-high", "all");
    assert.equal(allArgon.plain, "5h 8% (20m) · Wk 90%");
    // 8% triggers alert red (\x1b[31m)
    assert.ok(allArgon.colored?.includes("\x1b[31m"));
    assert.deepEqual(qs.renderFooter("gemini-4-hydrogen-high", "off"), {});
    // Absent 3p bucket falls back cleanly to gemini pool.
    assert.equal(
      qs.renderFooter("claude-sonnet-5-5-high", "smart").plain,
      "5h 25% (2h 30m)",
    );

    // Next observation drops 5h by 0.15 and weekly by 0.03 => observed ratio = 5.0
    qs.ingest({
      groups: [
        {
          displayName: "Gemini",
          buckets: [
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.1 },
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.77 },
          ],
        },
      ],
    });
    assert.equal(qs.ratio, 5.0);
    assert.match(qs.previewFooter("gemini-4-hydrogen-high", "smart") || "", /5h 10%/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("search module formats grounding citations and queries v1internal:generateContent directly", async () => {
  const formatted = formatSearchResults(
    "Pi extensions use registerProvider. Tests use node.",
    {
      webSearchQueries: ["pi coding agent custom provider"],
      groundingChunks: [
        { web: { title: "Pi Docs", uri: "https://example.com/pi-docs" } },
        { web: { title: "Node Test Runner", uri: "https://example.com/node-test" } },
      ],
      groundingSupports: [
        { segment: { endIndex: 35 }, groundingChunkIndices: [0] },
        { segment: { endIndex: 51 }, groundingChunkIndices: [1] },
      ],
    },
    "pi custom provider",
    "2026-11-15T12:00:00Z",
    "2026-11-15T12:00:01Z",
  );

  assert.match(
    formatted.formattedOutput,
    /Pi extensions use registerProvider\.\[1\] Tests use node\.\[2\]/,
  );
  assert.match(formatted.formattedOutput, /\[1\] \[Pi Docs\]\(https:\/\/example\.com\/pi-docs\)/);
  assert.deepEqual(formatted.queries, ["pi coding agent custom provider"]);

  let capturedPath = "";
  let capturedBody: any;
  const mockClient: AntigravityClient = {
    async fetchAvailableModels() {
      return {};
    },
    async postJson(_source, apiPath, body) {
      capturedPath = apiPath;
      capturedBody = body;
      return {
        response: {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Result body" }] },
              groundingMetadata: {
                webSearchQueries: ["node strip types"],
                groundingChunks: [{ web: { title: "Node Docs", uri: "https://nodejs.org" } }],
                groundingSupports: [{ segment: { endIndex: 11 }, groundingChunkIndices: [0] }],
              },
            },
          ],
        },
      };
    },
    async streamGenerateContent() {
      throw new Error("not used");
    },
    async retrieveQuotaSummary() {
      return {};
    },
  };

  const res = await performWebSearch(
    { apiKey: JSON.stringify({ token: "ya29.ok", projectId: "proj-search" }) },
    { query: "strip types", domain: "nodejs.org" },
    mockClient,
  );
  assert.equal(capturedPath, "v1internal:generateContent");
  assert.equal(capturedBody.model, SEARCH_MODEL);
  assert.equal(capturedBody.requestType, "web_search");
  assert.match(capturedBody.request.contents[0].parts[0].text, /site:nodejs\.org/);
  assert.match(res.formattedOutput, /Result body\[1\]/);

  // Tool registration executes cleanly and maps missing auth to a friendly error message.
  let registeredTool: any;
  registerWebSearchTool(
    {
      registerTool(def: any) {
        registeredTool = def;
      },
    } as any,
    { client: mockClient },
  );
  assert.equal(registeredTool.name, WEB_SEARCH_TOOL_NAME);
  const authErrResult = await registeredTool.execute("tc-1", { query: "abc" }, undefined, undefined, {});
  assert.equal(authErrResult.details.error, "not_logged_in");
});

test("commands module completes subcommands and routes usage, models, refresh, login, and help", async () => {
  const catalog = createModelCatalog();
  catalog.record({
    models: {
      "gemini-4-hydrogen-high": {
        displayName: "Gemini 4 Hydrogen (high)",
        model: "MODEL_PLACEHOLDER_M528",
        thinkingLevel: 3,
        maxTokens: 1_048_576,
        maxOutputTokens: 262_144,
        recommended: true,
      },
    },
  });

  const quotaStatus = createQuotaStatus({
    store: {
      loadMode: () => "off",
      loadQuotaState: () => undefined,
      saveQuotaState: () => true,
    },
  });
  (quotaStatus as any).formatUsage = async () => "Usage report ok";

  const cmds = createAntigravityCommands({ quotaStatus, catalog });
  const allNames = cmds.complete("").map((c) => c.value);
  assert.deepEqual(allNames, ["usage", "models", "refresh", "settings", "websearch", "login"]);
  assert.deepEqual(
    cmds.complete("mo").map((c) => c.value),
    ["models"],
  );

  const notifications: Array<{ text: string; level?: string }> = [];
  let editorText = "";
  const ctx: any = {
    hasUI: true,
    ui: {
      notify: (text: string, level?: string) => notifications.push({ text, level }),
      setEditorText: (text: string) => {
        editorText = text;
      },
    },
    modelRegistry: {
      getApiKeyForProvider: async () => JSON.stringify({ token: "ya29.ok", projectId: "proj-1" }),
      refresh: async () => true,
    },
  };

  await cmds.handle("usage", ctx);
  await cmds.handle("model", ctx);
  await cmds.handle("login", ctx);
  await cmds.handle("unknown-cmd", ctx);

  const texts = notifications.map((n) => n.text);
  assert.ok(texts.includes("Usage report ok"));
  assert.ok(texts.some((t) => /Gemini 4 Hydrogen/.test(t)));
  assert.equal(editorText, "/login antigravity");
  assert.ok(texts.some((t) => /Usage: \/antigravity <command>/.test(t)));

  // Unauthenticated context notifies user cleanly without throwing.
  const loggedOutMsgs: string[] = [];
  await cmds.handle("usage", {
    hasUI: true,
    ui: { notify: (text: string) => loggedOutMsgs.push(text) },
  } as any);
  assert.equal(loggedOutMsgs[0], "Not logged in. Run /login antigravity first.");
});

test("notifyCommandOutput routes UI notifications and headless stdio consistently", () => {
  const uiCalls: Array<{ text: string; type: string }> = [];
  notifyCommandOutput(
    {
      hasUI: true,
      ui: {
        notify: (text: string, type = "info") => uiCalls.push({ text, type }),
      },
    } as any,
    "hello ui",
    "warning",
  );
  assert.deepEqual(uiCalls, [{ text: "hello ui", type: "warning" }]);

  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (msg: string) => logs.push(msg);
  console.error = (msg: string) => errs.push(msg);
  try {
    notifyCommandOutput({ hasUI: false } as any, "info line");
    notifyCommandOutput({ hasUI: false } as any, "warn line", "warning");
    notifyCommandOutput({ hasUI: false } as any, "err line", "error");
  } finally {
    console.log = origLog;
    console.error = origError;
  }

  assert.deepEqual(logs, ["info line"]);
  assert.deepEqual(errs, ["warn line", "err line"]);
});
