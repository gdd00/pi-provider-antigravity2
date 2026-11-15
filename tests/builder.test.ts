import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptSystemInstructionForAntigravity,
  adaptSystemInstructionText,
  buildAntigravityRequestBody,
  convertTools,
  SKIP_THOUGHT_SIGNATURE_VALIDATOR,
} from "../pi-provider-antigravity2/builder.ts";
import type { ModelPlan } from "../pi-provider-antigravity2/model-catalog.ts";
import { buildInitialPromptsConfig } from "../pi-provider-antigravity2/prompts.ts";

test("adaptSystemInstructionText neutralizes Pi harness signatures while keeping content intact", () => {
  const fullPiPrompt = [
    "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
    "<tools>\n- read\n- bash\n- edit\n- write\n</tools>",
    "<rules>\nFollow AGENTS.md carefully.\n</rules>",
    "<docs>\nConsult docs cleanly.\n</docs>",
    "<skills>\n- run-workflow\n</skills>",
  ].join("\n\n");

  const adapted = adaptSystemInstructionText(fullPiPrompt);
  assert.equal(adapted.toLowerCase().includes("inside pi"), false);
  assert.equal(adapted.toLowerCase().includes("coding agent harness"), false);
  assert.match(adapted, /^You are a coding assistant\. Help users inspect files/);
  assert.ok(adapted.includes("<tools>\n- read\n- bash\n- edit\n- write\n</tools>"));
  assert.ok(adapted.includes("<rules>\nFollow AGENTS.md carefully.\n</rules>"));
  assert.ok(adapted.includes("<docs>\nConsult docs cleanly.\n</docs>"));
  assert.ok(adapted.includes("<skills>\n- run-workflow\n</skills>"));

  const shortVariant = adaptSystemInstructionText("You are a coding assistant running inside pi.");
  assert.equal(shortVariant, "You are a coding assistant.");

  const genericPhrase = adaptSystemInstructionText("Context: running inside pi with tools.");
  assert.equal(genericPhrase.toLowerCase().includes("inside pi"), false);
  assert.match(genericPhrase, /with tools\./);

  const structured = {
    role: "user",
    parts: [{ text: fullPiPrompt }, { inlineData: { mimeType: "text/plain", data: "abc" } }],
  };
  const adaptedObj = adaptSystemInstructionForAntigravity(structured);
  assert.notEqual(adaptedObj, structured);
  assert.ok(structured.parts[0].text.includes("running inside pi"));
  assert.equal(adaptedObj.parts[0].text.includes("inside pi"), false);
  assert.deepEqual(adaptedObj.parts[1], structured.parts[1]);
});

test("buildAntigravityRequestBody builds full Gemini xhigh payload without mutating input context", () => {
  const xhighPlan: ModelPlan = {
    runtimeModelId: "gemini-4-hydrogen-xhigh",
    modelEnum: "MODEL_PLACEHOLDER_M528",
    thinkingConfig: { includeThoughts: true, thinkingLevel: 100 },
    isNonGemini: false,
    isClaude: false,
  };

  const originalSystem =
    "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files.";
  const context = {
    messages: [
      {
        role: "system",
        content: originalSystem,
        toolsAdded: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              $defs: { Line: { type: "integer" } },
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: ["string", "null"], description: "File path" },
                mode: { const: "text" },
              },
              required: ["path"],
            },
          },
        ],
        timestamp: 1,
      },
      { role: "user", content: "Inspect README", timestamp: 2 },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "proj-x",
    plan: xhighPlan,
    promptsConfig: buildInitialPromptsConfig(),
    context,
    maxOutputTokens: 262144,
    toolChoice: "required",
  });

  // Never mutates caller's context.
  assert.equal((context.messages[0] as any).content, originalSystem);

  assert.equal(body.project, "proj-x");
  assert.equal(body.model, "gemini-4-hydrogen-xhigh");
  assert.equal(body.userAgent, "antigravity");
  assert.equal(body.requestType, "agent");
  assert.deepEqual(body.request.generationConfig, {
    maxOutputTokens: 262144,
    thinkingConfig: { includeThoughts: true, thinkingLevel: 100 },
  });
  assert.equal(
    body.request.systemInstruction.parts[0].text.toLowerCase().includes("inside pi"),
    false,
  );
  assert.deepEqual(body.request.toolConfig, {
    functionCallingConfig: { mode: "ANY" },
  });

  const decl = body.request.tools[0].functionDeclarations[0];
  assert.equal(decl.parameters.$schema, undefined);
  assert.equal(decl.parameters.$defs, undefined);
  assert.equal(decl.parameters.additionalProperties, undefined);
  assert.equal(decl.parameters.properties.path.type, "string");
  assert.deepEqual(decl.parameters.properties.mode, { enum: ["text"] });
});

test("buildAntigravityRequestBody supports stripRequestType and keeps Claude thinkingBudget < maxOutputTokens", () => {
  const claudePlan: ModelPlan = {
    runtimeModelId: "claude-sonnet-4-5-thinking",
    modelEnum: "MODEL_PLACEHOLDER_M301",
    thinkingConfig: { includeThoughts: true, thinkingBudget: 32000 },
    isNonGemini: true,
    isClaude: true,
  };

  const body = buildAntigravityRequestBody({
    projectId: "proj-c",
    plan: claudePlan,
    promptsConfig: buildInitialPromptsConfig(),
    context: {
      messages: [
        { role: "system", content: "You are a coding assistant.", timestamp: 1 },
        { role: "user", content: "Hello", timestamp: 2 },
      ],
    },
    maxOutputTokens: 16384,
    stripRequestType: true,
  });

  assert.equal("requestType" in body, false);
  assert.equal(body.userAgent, "antigravity");
  assert.equal(body.request.labels.used_claude, "true");
  assert.equal(body.request.labels.used_non_gemini_model, "true");
  assert.equal(body.request.generationConfig.maxOutputTokens, 16384);
  assert.ok(body.request.generationConfig.thinkingConfig.thinkingBudget < 16384);
  assert.equal(body.request.generationConfig.thinkingConfig.thinkingBudget, 16383);
});

test("buildAntigravityRequestBody preserves multi-turn thoughtSignatures, foreign sentinels, and role rules", () => {
  const geminiPlan: ModelPlan = {
    runtimeModelId: "gemini-4-hydrogen-high",
    modelEnum: "MODEL_PLACEHOLDER_M525",
    thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
    isNonGemini: false,
    isClaude: false,
  };

  const geminiTurn = buildAntigravityRequestBody({
    projectId: "proj-g",
    plan: geminiPlan,
    promptsConfig: buildInitialPromptsConfig(),
    context: {
      messages: [
        { role: "user", content: "Check files", timestamp: 1 },
        {
          role: "assistant",
          provider: "antigravity",
          model: "gemini-4-hydrogen",
          content: [
            { type: "thinking", thinking: "Need to list files", thinkingSignature: "c2lnVGhpbms=" },
            { type: "toolCall", id: "call:1", name: "bash", arguments: { command: "ls" } },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call:1",
          toolName: "bash",
          content: [{ type: "text", text: "README.md" }],
          isError: false,
          timestamp: 3,
        },
        {
          role: "assistant",
          provider: "openai",
          model: "gpt-5",
          content: [{ type: "toolCall", id: "call:2", name: "read", arguments: { path: "README.md" } }],
          stopReason: "toolUse",
          timestamp: 4,
        },
        {
          role: "toolResult",
          toolCallId: "call:2",
          toolName: "read",
          content: [{ type: "text", text: "Permission denied" }],
          isError: true,
          timestamp: 5,
        },
      ],
    },
  });

  // Same-provider Gemini tool turn drops thought block on tool turn and transfers pending signature to functionCall.
  assert.equal(geminiTurn.request.contents[1].role, "model");
  assert.equal(geminiTurn.request.contents[1].parts.length, 1);
  assert.equal(geminiTurn.request.contents[1].parts[0].thoughtSignature, "c2lnVGhpbms=");
  assert.equal(geminiTurn.request.contents[1].parts[0].functionCall.id, "call_1");

  // Gemini toolResult uses role "model" and { output } for success.
  assert.equal(geminiTurn.request.contents[2].role, "model");
  assert.deepEqual(geminiTurn.request.contents[2].parts[0].functionResponse.response, {
    output: "README.md",
  });

  // Foreign provider toolCall injects SKIP_THOUGHT_SIGNATURE_VALIDATOR on Gemini.
  assert.equal(
    geminiTurn.request.contents[3].parts[0].thoughtSignature,
    SKIP_THOUGHT_SIGNATURE_VALIDATOR,
  );
  // Error toolResult sends { error }.
  assert.deepEqual(geminiTurn.request.contents[4].parts[0].functionResponse.response, {
    error: "Permission denied",
  });

  // Verify Claude toolResult uses role "user" and trailing incomplete model turn appends "continue".
  const claudeBody = buildAntigravityRequestBody({
    projectId: "proj-c",
    promptsConfig: buildInitialPromptsConfig(),
    plan: {
      runtimeModelId: "claude-sonnet-5-5-high",
      modelEnum: "MODEL_PLACEHOLDER_M412",
      thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
      isNonGemini: true,
      isClaude: true,
    },
    context: {
      messages: [
        { role: "user", content: "Hi", timestamp: 1 },
        {
          role: "assistant",
          provider: "antigravity",
          model: "claude-sonnet-5-5",
          content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "pwd" } }],
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "bash",
          content: "/repo",
          isError: false,
          timestamp: 3,
        },
        {
          role: "assistant",
          provider: "antigravity",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "Partial" }],
          stopReason: "stop",
          timestamp: 4,
        },
      ],
    },
  });

  assert.equal(claudeBody.request.contents[2].role, "user");
  const lastContent = claudeBody.request.contents.at(-1);
  assert.deepEqual(lastContent, { role: "user", parts: [{ text: "continue" }] });

  // Verify convertTools strips unknown properties uniformly.
  const converted = convertTools([
    { name: "ping", description: "Ping", parameters: { type: "object", $schema: "x" } },
  ]);
  assert.deepEqual(converted, [
    { functionDeclarations: [{ name: "ping", description: "Ping", parameters: { type: "object" } }] },
  ]);
});
