import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildAntigravityRequestBody } from "../pi-provider-antigravity2/builder.ts";
import type { ModelPlan } from "../pi-provider-antigravity2/model-catalog.ts";
import {
  buildInitialPromptsConfig,
  defaultPromptsFile,
  extractPromptPreamble,
  initializePromptSync,
  loadDefaultPromptsBundle,
  loadPromptsFile,
  PROVIDER_PROMPTS_FILE,
  resolveOutboundSystemPrompt,
  resolveSearchSystemInstruction,
  resolveWebSearchToolPrompts,
  syncPromptsFile,
} from "../pi-provider-antigravity2/prompts.ts";
import type { AntigravityClient } from "../pi-provider-antigravity2/protocol.ts";
import { performWebSearch, registerWebSearchTool } from "../pi-provider-antigravity2/search.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ag2-prompts-test-"));
}

const TEST_PLAN: ModelPlan = {
  runtimeModelId: "gemini-4-hydrogen-high",
  modelEnum: "MODEL_PLACEHOLDER_M525",
  thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
  isNonGemini: false,
  isClaude: false,
};

test("extractPromptPreamble isolates only the opening preamble without duplicating sections", () => {
  const full = [
    "You are a coding assistant running inside pi, a coding agent harness. Help users.",
    "<tools>\n- read\n</tools>",
    "<cwd>\n/repo\n</cwd>",
  ].join("\n\n");
  const { preamble, rest } = extractPromptPreamble(full);
  assert.equal(
    preamble,
    "You are a coding assistant running inside pi, a coding agent harness. Help users.",
  );
  assert.equal(preamble + rest, full);
  assert.equal(rest.includes("<tools>"), true);
});

test("syncPromptsFile puts pattern outside and keeps flat piOriginal/extensionBuiltIn/userModified entries", () => {
  const dir = makeTempDir();
  try {
    const file = defaultPromptsFile({ PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv);
    assert.equal(file, path.join(dir, PROVIDER_PROMPTS_FILE));

    const piPrompt1 =
      "You are a coding assistant running inside pi, a coding agent harness. Help users.\n\n<tools>\n- read\n</tools>\n\n<cwd>\n/proj/a\n</cwd>";
    const res1 = syncPromptsFile({ file, sessionSystemPrompt: piPrompt1, piVersion: "1.5.2" });
    assert.equal(res1.written, true);
    assert.equal(res1.reason, "created");
    assert.equal(res1.parseError, false);

    const disk1 = loadPromptsFile(file)!;
    assert.ok(disk1);
    assert.equal(disk1.piVersion, "1.5.2");
    assert.equal(
      disk1.prompts.preamble.piOriginal,
      "You are a coding assistant running inside pi, a coding agent harness. Help users.",
    );
    assert.equal(disk1.prompts.preamble.extensionBuiltIn, "You are a coding assistant. Help users.");
    assert.equal(disk1.prompts.preamble.userModified, disk1.prompts.preamble.extensionBuiltIn);
    assert.equal(disk1.prompts.preamble.piOriginal.includes("<tools>"), false);

    // systemInstructionRewrites has pattern once per rule with piOriginal/extensionBuiltIn/userModified inside.
    const builtInBundle = loadDefaultPromptsBundle();
    assert.equal(disk1.prompts.systemInstructionRewrites.defaultFlags, "gi");
    assert.equal(
      disk1.prompts.systemInstructionRewrites.rules.length,
      builtInBundle.systemInstructionRewrites.length,
    );
    assert.equal(disk1.prompts.systemInstructionRewrites.rules[0].piOriginal, null);
    assert.equal(
      disk1.prompts.systemInstructionRewrites.rules[0].extensionBuiltIn,
      "You are a coding assistant",
    );
    assert.equal(
      disk1.prompts.systemInstructionRewrites.rules[0].userModified,
      "You are a coding assistant",
    );

    // webSearchTool entries are completely flat.
    assert.equal(disk1.prompts.searchSystemInstruction.piOriginal, null);
    assert.equal(disk1.prompts.webSearchToolDescription.piOriginal, null);
    assert.equal(disk1.prompts.webSearchToolSnippet.piOriginal, null);
    assert.equal(disk1.prompts.webSearchToolGuidelines.piOriginal, null);
    assert.equal(
      disk1.prompts.webSearchToolSnippet.userModified,
      disk1.prompts.webSearchToolSnippet.extensionBuiltIn,
    );

    // Same piVersion ("1.5.2"): skips extracting Pi's prompt (getter not called),
    // yet still runs file check and repairs missing/broken structure while keeping piOriginal untouched.
    let extractCalls = 0;
    const resUnchanged = syncPromptsFile({
      file,
      sessionSystemPrompt: () => {
        extractCalls += 1;
        return "Should not be called";
      },
      piVersion: "1.5.2",
    });
    assert.equal(extractCalls, 0);
    assert.equal(resUnchanged.written, false);
    assert.equal(resUnchanged.reason, "version-unchanged");

    // Delete searchSystemInstruction.userModified while keeping piVersion "1.5.2" and modifying piOriginal:
    // file check runs and repairs the missing field without extracting Pi's prompt.
    const damaged: any = JSON.parse(fs.readFileSync(file, "utf-8"));
    damaged.prompts.preamble.piOriginal = "Accidental user edit in piOriginal";
    delete damaged.prompts.searchSystemInstruction.userModified;
    fs.writeFileSync(file, JSON.stringify(damaged, null, 2), "utf-8");

    const resRepaired = syncPromptsFile({
      file,
      sessionSystemPrompt: () => {
        extractCalls += 1;
        return "Should still not be called";
      },
      piVersion: "1.5.2",
    });
    assert.equal(extractCalls, 0);
    assert.equal(resRepaired.written, true);
    assert.equal(resRepaired.reason, "file-repaired");
    const afterRepair = loadPromptsFile(file)!;
    assert.equal(afterRepair.prompts.preamble.piOriginal, "Accidental user edit in piOriginal");
    assert.equal(
      afterRepair.prompts.searchSystemInstruction.userModified,
      loadDefaultPromptsBundle().searchSystemInstruction,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("syncPromptsFile checks and updates piOriginal when piVersion changes while preserving userModified", () => {
  const dir = makeTempDir();
  try {
    const file = defaultPromptsFile({ PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv);
    syncPromptsFile({
      file,
      sessionSystemPrompt:
        "You are a coding assistant running inside pi. Help users.\n\n<tools>\n- read\n</tools>",
      piVersion: "1.5.2",
    });

    // User customizes userModified AND accidentally modifies piOriginal.
    const cfg = loadPromptsFile(file)!;
    cfg.prompts.preamble.piOriginal = "Accidentally edited piOriginal";
    cfg.prompts.preamble.userModified = "You are my custom Antigravity assistant.";
    cfg.prompts.searchSystemInstruction.userModified = "Custom search bot instruction.";
    cfg.prompts.webSearchToolGuidelines.userModified = ["Custom guideline bullet."];
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");

    // Pi upgrades to 1.5.3 -> piVersion changed -> detects mismatch and updates piOriginal + extensionBuiltIn,
    // while keeping userModified edits intact.
    const updatedRes = syncPromptsFile({
      file,
      sessionSystemPrompt:
        "You are a coding assistant running inside pi, a coding agent harness. New tools.\n\n<tools>\n- bash\n</tools>",
      piVersion: "1.5.3",
    });
    assert.equal(updatedRes.written, true);
    assert.equal(updatedRes.reason, "pi-original-updated");

    const after = loadPromptsFile(file)!;
    assert.equal(after.piVersion, "1.5.3");
    assert.equal(
      after.prompts.preamble.piOriginal,
      "You are a coding assistant running inside pi, a coding agent harness. New tools.",
    );
    assert.equal(after.prompts.preamble.extensionBuiltIn, "You are a coding assistant. New tools.");
    assert.equal(after.prompts.preamble.userModified, "You are my custom Antigravity assistant.");
    assert.equal(after.prompts.searchSystemInstruction.userModified, "Custom search bot instruction.");
    assert.deepEqual(after.prompts.webSearchToolGuidelines.userModified, [
      "Custom guideline bullet.",
    ]);
    assert.equal(
      after.prompts.webSearchToolSnippet.userModified,
      after.prompts.webSearchToolSnippet.extensionBuiltIn,
    );

    // Pi upgrades to 1.5.4 with the exact same piOriginal prompt -> records piVersion without touching prompts.
    const verOnlyRes = syncPromptsFile({
      file,
      sessionSystemPrompt:
        "You are a coding assistant running inside pi, a coding agent harness. New tools.\n\n<tools>\n- bash\n</tools>",
      piVersion: "1.5.4",
    });
    assert.equal(verOnlyRes.written, true);
    assert.equal(verOnlyRes.reason, "version-recorded");
    assert.equal(loadPromptsFile(file)!.piVersion, "1.5.4");
    assert.equal(
      loadPromptsFile(file)!.prompts.preamble.userModified,
      "You are my custom Antigravity assistant.",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("userModified takes effect in builder, search, and tool registration while keeping live sections intact", async () => {
  const dir = makeTempDir();
  try {
    const file = defaultPromptsFile({ PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv);
    const livePrompt =
      "You are a coding assistant running inside pi. Main session.\n\n<tools>\n- read\n</tools>\n\n<cwd>\n/live/dir\n</cwd>";
    syncPromptsFile({ file, sessionSystemPrompt: livePrompt, piVersion: "1.5.2" });

    // 1. User edits rewrite rule replacement -> applies to live prompts cleanly.
    const cfg1 = loadPromptsFile(file)!;
    assert.equal(cfg1.prompts.systemInstructionRewrites.defaultFlags, "gi");
    cfg1.prompts.systemInstructionRewrites.rules = [
      {
        pattern: "\\bYou are a coding assistant running inside pi\\b",
        piOriginal: null,
        extensionBuiltIn: "You are a coding assistant",
        userModified: "You are a custom rewrite assistant",
      },
    ];
    fs.writeFileSync(file, JSON.stringify(cfg1, null, 2), "utf-8");
    assert.equal(
      resolveOutboundSystemPrompt(livePrompt, file),
      "You are a custom rewrite assistant. Main session.\n\n<tools>\n- read\n</tools>\n\n<cwd>\n/live/dir\n</cwd>",
    );

    // 2. User edits preamble.userModified directly -> replaces preamble while preserving live <tools>/<cwd>,
    //    and does NOT clobber unrelated subagent/compaction prompts.
    const cfg2 = loadPromptsFile(file)!;
    cfg2.prompts.preamble.userModified = "Custom preamble text.";
    cfg2.prompts.searchSystemInstruction.userModified = "User search prompt.";
    cfg2.prompts.webSearchToolDescription.userModified = "User tool description";
    cfg2.prompts.webSearchToolSnippet.userModified = "User tool snippet";
    cfg2.prompts.webSearchToolGuidelines.userModified = ["User guideline 1"];
    fs.writeFileSync(file, JSON.stringify(cfg2, null, 2), "utf-8");

    const mainBody = buildAntigravityRequestBody({
      projectId: "proj-1",
      plan: TEST_PLAN,
      promptsFile: file,
      context: {
        messages: [
          { role: "system", content: livePrompt, timestamp: 1 },
          { role: "user", content: "hi", timestamp: 2 },
        ],
      },
    });
    assert.equal(
      mainBody.request.systemInstruction.parts[0].text,
      "Custom preamble text.\n\n<tools>\n- read\n</tools>\n\n<cwd>\n/live/dir\n</cwd>",
    );

    const subagentBody = buildAntigravityRequestBody({
      projectId: "proj-1",
      plan: TEST_PLAN,
      promptsFile: file,
      context: {
        messages: [
          {
            role: "system",
            content: "You are a coding assistant running inside pi for compaction.",
            timestamp: 1,
          },
          { role: "user", content: "summarize", timestamp: 2 },
        ],
      },
    });
    assert.equal(
      subagentBody.request.systemInstruction.parts[0].text,
      "You are a custom rewrite assistant for compaction.",
    );

    // 3. Search systemInstruction and tool prompt registration read from userModified.
    assert.equal(resolveSearchSystemInstruction(file), "User search prompt.");
    assert.deepEqual(resolveWebSearchToolPrompts(file), {
      description: "User tool description",
      promptSnippet: "User tool snippet",
      promptGuidelines: ["User guideline 1"],
    });

    let capturedSearchSys = "";
    const mockClient: AntigravityClient = {
      async fetchAvailableModels() {
        return {};
      },
      async retrieveQuotaSummary() {
        return {};
      },
      async streamGenerateContent() {
        throw new Error("not used");
      },
      async postJson(_source, _path, body: any) {
        capturedSearchSys = body.request.systemInstruction.parts[0].text;
        return { response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } };
      },
    };
    await performWebSearch(
      { apiKey: JSON.stringify({ token: "ya29.ok", projectId: "p1" }) },
      { query: "test", promptsFile: file },
      mockClient,
    );
    assert.equal(capturedSearchSys, "User search prompt.");

    let registeredTool: any;
    registerWebSearchTool(
      {
        registerTool(def: any) {
          registeredTool = def;
        },
      } as any,
      { client: mockClient, promptsFile: file },
    );
    assert.equal(registeredTool.description, "User tool description");
    assert.equal(registeredTool.promptSnippet, "User tool snippet");
    assert.deepEqual(registeredTool.promptGuidelines, ["User guideline 1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("syncPromptsFile never overwrites invalid JSON and handles invalid user regex safely", () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, PROVIDER_PROMPTS_FILE);
    const brokenContent = "{ invalid json,,,";
    fs.writeFileSync(file, brokenContent, "utf-8");

    const res = syncPromptsFile({ file, sessionSystemPrompt: "Pi prompt", piVersion: "1.5.2" });
    assert.equal(res.parseError, true);
    assert.equal(res.written, false);
    assert.equal(fs.readFileSync(file, "utf-8"), brokenContent);

    const cfg = buildInitialPromptsConfig("You are a coding assistant running inside pi.");
    cfg.prompts.systemInstructionRewrites.rules = [
      {
        pattern: "[unclosed-regex",
        piOriginal: null,
        extensionBuiltIn: null,
        userModified: "ignored",
      },
      {
        pattern: "running inside pi",
        piOriginal: null,
        extensionBuiltIn: null,
        userModified: "adapted",
      },
    ];
    assert.equal(
      resolveOutboundSystemPrompt("You are a coding assistant running inside pi.", cfg),
      "You are a coding assistant adapted.",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("initializePromptSync extracts from Pi only when missing, skips extraction on same piVersion, and checks file", () => {
  const dir = makeTempDir();
  try {
    const handlers = new Map<string, Function>();
    let registeredTool: any;
    const mockPi: any = {
      registerTool(def: any) {
        registeredTool = def;
      },
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    };

    const promptsFile = initializePromptSync(mockPi, { agentDir: dir, piVersion: "1.5.2" });
    registerWebSearchTool(mockPi, { promptsFile });

    const file = path.join(dir, PROVIDER_PROMPTS_FILE);
    assert.equal(promptsFile, file);
    assert.equal(fs.existsSync(file), false);
    assert.equal(registeredTool.name, "antigravity_websearch");
    assert.equal(
      registeredTool.promptSnippet,
      loadDefaultPromptsBundle().webSearchTool.promptSnippet,
    );

    const onSessionStart = handlers.get("session_start");
    const onBeforeAgentStart = handlers.get("before_agent_start");
    assert.ok(onSessionStart);
    assert.ok(onBeforeAgentStart);

    // First session_start -> file missing -> extracts from Pi and creates file.
    onSessionStart(
      { reason: "startup" },
      { getSystemPrompt: () => "You are a coding assistant running inside pi.\n\n<cwd>/a</cwd>" },
    );
    assert.equal(fs.existsSync(file), true);
    const afterStart = loadPromptsFile(file)!;
    assert.equal(afterStart.piVersion, "1.5.2");
    assert.equal(
      afterStart.prompts.preamble.piOriginal,
      "You are a coding assistant running inside pi.",
    );
    assert.equal(afterStart.prompts.preamble.userModified, "You are a coding assistant.");

    // Same piVersion on before_agent_start -> skips extracting Pi's prompt.
    let getPromptCalled = false;
    onBeforeAgentStart(
      {},
      {
        getSystemPrompt: () => {
          getPromptCalled = true;
          return "You are a coding assistant running inside pi. Updated.\n\n<cwd>/b</cwd>";
        },
      },
    );
    assert.equal(getPromptCalled, false);
    assert.equal(
      loadPromptsFile(file)!.prompts.preamble.piOriginal,
      "You are a coding assistant running inside pi.",
    );

    // Startup file check runs when file exists and repairs missing userModified fields.
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    delete raw.prompts.webSearchToolGuidelines.userModified;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf-8");
    initializePromptSync({ on() {} }, { agentDir: dir, piVersion: "1.5.2" });
    assert.deepEqual(
      loadPromptsFile(file)!.prompts.webSearchToolGuidelines.userModified,
      loadDefaultPromptsBundle().webSearchTool.promptGuidelines,
    );

    // New Pi version -> re-checks piOriginal and updates it when Pi prompt changed.
    const handlersV2 = new Map<string, Function>();
    initializePromptSync(
      { on: (ev, fn) => handlersV2.set(ev, fn) },
      { agentDir: dir, piVersion: "1.5.3" },
    );
    handlersV2.get("session_start")!(
      { reason: "startup" },
      { getSystemPrompt: () => "You are a coding assistant running inside pi. v1.5.3.\n\n<cwd>/c</cwd>" },
    );
    const afterUpgrade = loadPromptsFile(file)!;
    assert.equal(afterUpgrade.piVersion, "1.5.3");
    assert.equal(
      afterUpgrade.prompts.preamble.piOriginal,
      "You are a coding assistant running inside pi. v1.5.3.",
    );
    assert.equal(afterUpgrade.prompts.preamble.userModified, "You are a coding assistant. v1.5.3.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("built-in rewrites strip Pi <docs>, neutralize historical preambles, and merge new built-in rules into existing files", () => {
  const dir = makeTempDir();
  const file = path.join(dir, PROVIDER_PROMPTS_FILE);
  try {
    const legacyPiDocs = [
      "<docs>",
      "Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /opt/pi-coding-agent/README.md",
      "- When asked about: extensions (docs/extensions.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)",
      "</docs>",
    ].join("\n");

    const fullPrompt = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. Help users.",
      "<tools>\n- codemode\n</tools>",
      legacyPiDocs,
      "<cwd>/tmp/proj</cwd>",
    ].join("\n\n");

    const builtInConfig = buildInitialPromptsConfig();
    const outbound = resolveOutboundSystemPrompt(fullPrompt, builtInConfig);
    assert.equal(
      outbound,
      "You are an expert coding assistant. Help users.\n\n<tools>\n- codemode\n</tools>\n\n<cwd>/tmp/proj</cwd>",
    );
    assert.equal(outbound.includes("<docs>"), false);
    assert.equal(outbound.toLowerCase().includes("codemode scripts and non-llm"), false);

    // Works cleanly when <docs> is at the very start or very end of the prompt too.
    assert.equal(
      resolveOutboundSystemPrompt(`${legacyPiDocs}\n\n<cwd>/a</cwd>`, builtInConfig),
      "<cwd>/a</cwd>",
    );
    assert.equal(
      resolveOutboundSystemPrompt(`<rules>\n- be concise\n</rules>\n\n${legacyPiDocs}`, builtInConfig),
      "<rules>\n- be concise\n</rules>",
    );

    // Custom non-Pi <docs> section stays untouched.
    const customDocs = "<docs>\nProject API documentation stays here.\n</docs>";
    assert.equal(resolveOutboundSystemPrompt(customDocs, builtInConfig), customDocs);

    // Mid-conversation section updates for Pi's docs are stripped while sibling updates remain.
    const sectionUpdate = [
      'Updated system prompt section "tools":\n\n- codemode',
      'Updated system prompt section "docs":\n\nPi documentation (read only when the user asks about the harness itself)\n- docs/codemode.md',
      'Removed system prompt section "docs".',
      'Updated system prompt section "cwd":\n\n/tmp/next',
    ].join("\n\n");
    assert.equal(
      resolveOutboundSystemPrompt(sectionUpdate, builtInConfig),
      'Updated system prompt section "tools":\n\n- codemode\n\nUpdated system prompt section "cwd":\n\n/tmp/next',
    );

    // Existing prompts.json on same piVersion ("1.5.2") with only the old 2 built-in rules + custom rule
    // merges in new built-in rules without overwriting user customizations or null opt-outs.
    const initial = buildInitialPromptsConfig("You are a coding assistant running inside pi.", "2026-01-01T00:00:00.000Z", "1.5.2");
    const firstBuiltInRule = initial.prompts.systemInstructionRewrites.rules[0];
    const thirdBuiltInRule = initial.prompts.systemInstructionRewrites.rules[2];
    initial.prompts.preamble.userModified = "Custom assistant persona.";
    initial.prompts.systemInstructionRewrites.rules = [
      { ...firstBuiltInRule, userModified: null },
      thirdBuiltInRule,
      {
        pattern: "custom-secret",
        piOriginal: null,
        extensionBuiltIn: null,
        userModified: "custom-redacted",
      },
    ];
    fs.writeFileSync(file, JSON.stringify(initial, null, 2), "utf-8");

    const repaired = syncPromptsFile({ file, piVersion: "1.5.2" });
    assert.equal(repaired.written, true);
    assert.equal(repaired.reason, "file-repaired");

    const reloaded = loadPromptsFile(file)!;
    assert.equal(reloaded.prompts.preamble.userModified, "Custom assistant persona.");
    assert.equal(
      reloaded.prompts.systemInstructionRewrites.rules.find(
        (r) => r.pattern === firstBuiltInRule.pattern,
      )?.userModified,
      null,
    );
    assert.equal(
      reloaded.prompts.systemInstructionRewrites.rules.find((r) => r.pattern === "custom-secret")
        ?.userModified,
      "custom-redacted",
    );
    assert.equal(
      reloaded.prompts.systemInstructionRewrites.rules.length,
      loadDefaultPromptsBundle().systemInstructionRewrites.length + 1,
    );
    // Applying the upgraded file drops Pi's <docs> block cleanly.
    const upgradedOutbound = resolveOutboundSystemPrompt(`${legacyPiDocs}\n\n<cwd>/tmp/p</cwd>`, file);
    assert.equal(upgradedOutbound, "<cwd>/tmp/p</cwd>");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
