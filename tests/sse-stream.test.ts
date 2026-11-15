import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createModelCatalog } from "../pi-provider-antigravity2/model-catalog.ts";
import { AntigravityHttpError, type AntigravityClient } from "../pi-provider-antigravity2/protocol.ts";
import {
  attachLoneSignature,
  consumeSseStream,
  createStreamParserState,
  hasAnswerContent,
  parseAntigravitySseResponse,
} from "../pi-provider-antigravity2/sse.ts";
import {
  inspectAntigravityError,
  isSyntheticAgent429,
  isSyntheticWaf429,
  normalizeOverflowError,
  parseDurationMs,
  sleepWithAbort,
  streamAntigravity,
} from "../pi-provider-antigravity2/stream.ts";
import {
  clearWafBlockedSnippets,
  getCachedWafBlockedSnippets,
  isolateBlockedSystemInstruction,
  WAF_SAFE_FALLBACK_SYSTEM_PROMPT,
} from "../pi-provider-antigravity2/waf-recovery.ts";

function sseStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function makeModel(overrides: Record<string, any> = {}): any {
  return {
    id: "gemini-4-hydrogen-high",
    name: "Gemini 4 Hydrogen (high)",
    api: "antigravity-cloud-code",
    provider: "antigravity",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    ...overrides,
  };
}

function makeCatalogWithHydrogen(): ReturnType<typeof createModelCatalog> {
  const catalog = createModelCatalog();
  catalog.record({
    models: {
      "gemini-4-hydrogen-low": {
        displayName: "Gemini 4 Hydrogen (low)",
        model: "MODEL_PLACEHOLDER_M528",
        thinkingLevel: 1,
        maxTokens: 1_048_576,
        maxOutputTokens: 262_144,
        recommended: true,
      },
      "gemini-4-hydrogen-high": {
        displayName: "Gemini 4 Hydrogen (high)",
        model: "MODEL_PLACEHOLDER_M528",
        thinkingLevel: 3,
        maxTokens: 1_048_576,
        maxOutputTokens: 262_144,
        recommended: true,
      },
      "gemini-4-hydrogen-xhigh": {
        displayName: "Gemini 4 Hydrogen (xhigh)",
        model: "MODEL_PLACEHOLDER_M528",
        thinkingLevel: 100,
        maxTokens: 1_048_576,
        maxOutputTokens: 262_144,
        recommended: true,
      },
    },
    agentModelSorts: [
      {
        groups: [
          {
            modelIds: [
              "gemini-4-hydrogen-low",
              "gemini-4-hydrogen-high",
              "gemini-4-hydrogen-xhigh",
            ],
          },
        ],
      },
    ],
  });
  return catalog;
}

const VALID_API_KEY = JSON.stringify({ token: "ya29.test-token", projectId: "proj-test" });

test("parseAntigravitySseResponse parses thinking, text, toolCall, usage, and stopReason", () => {
  const chunks = [
    'data: {"response":{"responseId":"resp-1","modelVersion":"gemini-4-hydrogen-001","candidates":[{"content":{"parts":[{"thought":true,"text":"Let me check "}]}}],"usageMetadata":{"promptTokenCount":1000,"cachedContentTokenCount":200}}}\n\n',
    'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"files.","thoughtSignature":"sig-t1"}]}}]}}\n',
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Checking"},{"functionCall":{"id":"call_1","name":"read","args":{"path":"README.md"}},"thoughtSignature":"sig-call-1"}],"finishReason":"STOP"}}],"usageMetadata":{"promptTokenCount":1000,"cachedContentTokenCount":200,"candidatesTokenCount":40,"thoughtsTokenCount":15,"totalTokenCount":1055}}}\n',
    "data: not-json-ignored\n",
    "data: [DONE]\n",
  ];

  // Split deliberately mid-line to exercise buffering across chunks.
  const joined = chunks.join("");
  const splitChunks = [joined.slice(0, 75), joined.slice(75, 210), joined.slice(210)];

  const events: string[] = [];
  const providerFrames: unknown[] = [];
  const parsed = parseAntigravitySseResponse(
    splitChunks,
    (ev) => events.push(ev.type),
    (payload) => providerFrames.push(payload),
  );

  assert.equal(providerFrames.length, 3);
  assert.equal(parsed.responseId, "resp-1");
  assert.equal(parsed.stopReason, "toolUse");
  assert.deepEqual(parsed.usage, {
    input: 800,
    output: 55,
    cacheRead: 200,
    reasoning: 15,
    total: 1055,
  });

  assert.equal(parsed.content.length, 3);
  assert.deepEqual(parsed.content[0], {
    type: "thinking",
    thinking: "Let me check files.",
    thinkingSignature: "sig-t1",
  });
  assert.deepEqual(parsed.content[1], {
    type: "text",
    text: "Checking",
  });
  assert.deepEqual(parsed.content[2], {
    type: "toolCall",
    id: "call_1",
    name: "read",
    arguments: { path: "README.md" },
    thoughtSignature: "sig-call-1",
  });

  assert.deepEqual(events, [
    "thinking_start",
    "thinking_delta",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
  ]);
  assert.equal(hasAnswerContent(parsed.content), true);
});

test("attachLoneSignature preserves trailing thoughtSignature across thinking, text, or empty content", () => {
  const onlyThinking: any[] = [{ type: "thinking", thinking: "ponder" }];
  attachLoneSignature(onlyThinking, "sig-lone");
  assert.equal(onlyThinking[0].thinkingSignature, "sig-lone");
  assert.equal(hasAnswerContent(onlyThinking), false);

  const empty: any[] = [];
  attachLoneSignature(empty, "sig-empty");
  assert.deepEqual(empty, [{ type: "text", text: "", textSignature: "sig-empty" }]);
  assert.equal(hasAnswerContent(empty), false);
});

test("consumeSseStream awaits async onProviderEvent before emitting normalized delivery events", async () => {
  const order: string[] = [];
  const state = createStreamParserState();
  const encoder = new TextEncoder();
  const trailing = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}}';

  await consumeSseStream({
    streamBody: sseStreamFromChunks([`${trailing.slice(0, 40)}`, trailing.slice(40)]),
    state,
    onProviderEvent: async () => {
      await new Promise((r) => setTimeout(r, 15));
      order.push("provider");
    },
    onEvent: (ev) => {
      order.push(ev.type);
    },
    onComplete: () => {
      order.push("complete");
    },
  });

  assert.equal(encoder.encode("x").byteLength, 1);
  assert.equal(order[0], "provider");
  assert.equal(order[1], "text_start");
  assert.equal(order[order.length - 1], "complete");
  assert.equal(state.stopReason, "stop");
});

test("normalizeOverflowError prefixes overflow messages but ignores rate-limit errors", () => {
  assert.match(
    normalizeOverflowError("Input token count exceeds the maximum number of tokens allowed"),
    /^context_length_exceeded: /,
  );
  assert.match(normalizeOverflowError("Prompt is too long for model"), /^context_length_exceeded: /);
  assert.equal(
    normalizeOverflowError("RESOURCE_EXHAUSTED: prompt token count exceeds quota window"),
    "RESOURCE_EXHAUSTED: prompt token count exceeds quota window",
  );
  assert.equal(
    normalizeOverflowError("context_length_exceeded: already tagged"),
    "context_length_exceeded: already tagged",
  );
});

test("parseDurationMs, inspectAntigravityError, and isSyntheticAgent429 classify synthetic vs real 429", () => {
  assert.equal(parseDurationMs("4.2s"), 4200);
  assert.equal(parseDurationMs("500ms"), 500);
  assert.equal(parseDurationMs("1m30s"), 90_000);
  assert.equal(parseDurationMs({ seconds: 2, nanos: 500_000_000 }), 2500);

  const syntheticErr = new AntigravityHttpError(
    429,
    "v1internal:streamGenerateContent?alt=sse",
    JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Resource has been exhausted (e.g. check quota).",
      },
    }),
    {},
  );
  assert.equal(isSyntheticAgent429(syntheticErr, { requestType: "agent" }), true);
  assert.equal(isSyntheticAgent429(syntheticErr, {}), false);

  const realQuotaWithDelayErr = new AntigravityHttpError(
    429,
    "v1internal:streamGenerateContent?alt=sse",
    JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{ metadata: { quotaResetDelay: "2.5s" } }],
      },
    }),
  );
  const inspectedQuota = inspectAntigravityError(realQuotaWithDelayErr);
  assert.equal(inspectedQuota.isResourceExhausted, true);
  assert.equal(inspectedQuota.hasPayloadDelay, true);
  assert.equal(inspectedQuota.retryDelayMs, 2500);
  assert.equal(isSyntheticAgent429(realQuotaWithDelayErr, { requestType: "agent" }), false);

  const headerDelayErr = new AntigravityHttpError(
    429,
    "v1internal:streamGenerateContent?alt=sse",
    JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
    { "retry-after": "3" },
  );
  assert.equal(isSyntheticAgent429(headerDelayErr, { requestType: "agent" }), false);
  assert.equal(inspectAntigravityError(headerDelayErr).retryDelayMs, 3000);
});

test("streamAntigravity retries once with requestType stripped on synthetic 429 and succeeds", async () => {
  const sentBodies: any[] = [];
  const sleepCalls: number[] = [];
  let attempt = 0;

  const client: AntigravityClient = {
    async fetchAvailableModels() {
      return {};
    },
    async postJson() {
      throw new Error("not used");
    },
    async streamGenerateContent(opts) {
      sentBodies.push(structuredClone(opts.body));
      attempt += 1;
      if (attempt === 1) {
        throw new AntigravityHttpError(
          429,
          "v1internal:streamGenerateContent?alt=sse",
          JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }),
        );
      }
      return {
        response: new Response(null, { status: 200, headers: { "x-trace": "ok" } }),
        stream: sseStreamFromChunks([
          'data: {"response":{"responseId":"r-ok","candidates":[{"content":{"parts":[{"text":"Recovered cleanly"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":10,"totalTokenCount":110}}}\n\n',
        ]),
      };
    },
    async retrieveQuotaSummary() {
      return {};
    },
  };

  const catalog = makeCatalogWithHydrogen();
  const model = makeModel({ id: "gemini-4-hydrogen-xhigh", maxTokens: 262_144 });
  const responsesSeen: number[] = [];
  const stream = streamAntigravity(
    model,
    {
      systemPrompt: "You are an engineer.",
      messages: [{ role: "user", content: "hi" }],
    },
    {
      apiKey: VALID_API_KEY,
      reasoning: "xhigh",
      onResponse: (info) => {
        responsesSeen.push(info.status);
      },
    },
    catalog,
    client,
    {},
    {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    },
  );

  const result = await stream.result();
  assert.equal(attempt, 2);
  assert.deepEqual(sleepCalls, []);
  assert.equal(sentBodies[0].requestType, "agent");
  assert.equal("requestType" in sentBodies[1], false);
  assert.equal(sentBodies[1].request.generationConfig.thinkingConfig.thinkingLevel, 100);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, [{ type: "text", text: "Recovered cleanly" }]);
  assert.deepEqual(responsesSeen, [200]);
  assert.ok(result.usage.cost.total > 0);
});

test("streamAntigravity fails fast if synthetic 429 persists after stripping requestType", async () => {
  let calls = 0;
  const sleepCalls: number[] = [];

  const client: AntigravityClient = {
    async fetchAvailableModels() {
      return {};
    },
    async postJson() {
      throw new Error("not used");
    },
    async streamGenerateContent() {
      calls += 1;
      throw new AntigravityHttpError(
        429,
        "v1internal:streamGenerateContent?alt=sse",
        JSON.stringify({
          error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "persistent synthetic 429" },
        }),
      );
    },
    async retrieveQuotaSummary() {
      return {};
    },
  };

  const stream = streamAntigravity(
    makeModel(),
    { messages: [{ role: "user", content: "hi" }] },
    { apiKey: VALID_API_KEY },
    makeCatalogWithHydrogen(),
    client,
    {},
    {
      maxRetries: 3,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    },
  );

  const result = await stream.result();
  assert.equal(calls, 2);
  assert.deepEqual(sleepCalls, []);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage || "", /persistent synthetic 429/);
});

test("streamAntigravity honors quotaResetDelay bounded backoff and fails fast above maxRetryDelayMs", async () => {
  const sleepCalls: number[] = [];
  let calls = 0;

  const clientWithRetryableDelay: AntigravityClient = {
    async fetchAvailableModels() {
      return {};
    },
    async postJson() {
      throw new Error("not used");
    },
    async streamGenerateContent() {
      calls += 1;
      if (calls === 1) {
        throw new AntigravityHttpError(
          429,
          "v1internal:streamGenerateContent?alt=sse",
          JSON.stringify({
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              details: [{ metadata: { quotaResetDelay: "1.2s" } }],
            },
          }),
        );
      }
      return {
        response: new Response(null, { status: 200 }),
        stream: sseStreamFromChunks([
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"After wait"}]},"finishReason":"STOP"}]}}\n\n',
        ]),
      };
    },
    async retrieveQuotaSummary() {
      return {};
    },
  };

  const okResult = await streamAntigravity(
    makeModel(),
    { messages: [{ role: "user", content: "hello" }] },
    { apiKey: VALID_API_KEY },
    makeCatalogWithHydrogen(),
    clientWithRetryableDelay,
    {},
    {
      maxRetryDelayMs: 5000,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    },
  ).result();

  assert.equal(okResult.stopReason, "stop");
  assert.deepEqual(sleepCalls, [1200]);

  let longCalls = 0;
  const clientTooLong: AntigravityClient = {
    async fetchAvailableModels() {
      return {};
    },
    async postJson() {
      throw new Error("not used");
    },
    async streamGenerateContent() {
      longCalls += 1;
      throw new AntigravityHttpError(
        429,
        "v1internal:streamGenerateContent?alt=sse",
        JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            details: [{ metadata: { retryDelay: "120s" } }],
          },
        }),
      );
    },
    async retrieveQuotaSummary() {
      return {};
    },
  };

  const failFastResult = await streamAntigravity(
    makeModel(),
    { messages: [{ role: "user", content: "hello" }] },
    { apiKey: VALID_API_KEY },
    makeCatalogWithHydrogen(),
    clientTooLong,
    {},
    {
      maxRetryDelayMs: 30_000,
      sleep: async () => {
        assert.fail("should not sleep beyond maxRetryDelayMs");
      },
    },
  ).result();

  assert.equal(longCalls, 1);
  assert.equal(failFastResult.stopReason, "error");
});

test("streamAntigravity recovers once on HTTP 401 via onUnauthorized hook", async () => {
  const seenAuthHeaders: string[] = [];
  let calls = 0;

  const client: AntigravityClient = {
    async fetchAvailableModels() {
      return {};
    },
    async postJson() {
      throw new Error("not used");
    },
    async streamGenerateContent(opts) {
      calls += 1;
      const source = opts.source as { apiKey?: string };
      seenAuthHeaders.push(source.apiKey || "");
      if (calls === 1) {
        throw new AntigravityHttpError(
          401,
          "v1internal:streamGenerateContent?alt=sse",
          "expired token",
        );
      }
      return {
        response: new Response(null, { status: 200 }),
        stream: sseStreamFromChunks([
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Refreshed ok"}]},"finishReason":"STOP"}]}}\n\n',
        ]),
      };
    },
    async retrieveQuotaSummary() {
      return {};
    },
  };

  const result = await streamAntigravity(
    makeModel(),
    { messages: [{ role: "user", content: "test" }] },
    {
      apiKey: VALID_API_KEY,
      onUnauthorized: async () => ({ token: "ya29.new-token", projectId: "proj-test" }),
    },
    makeCatalogWithHydrogen(),
    client,
  ).result();

  assert.equal(calls, 2);
  assert.equal(JSON.parse(seenAuthHeaders[0]).token, "ya29.test-token");
  assert.equal(JSON.parse(seenAuthHeaders[1]).token, "ya29.new-token");
  assert.equal(result.stopReason, "stop");
});

test("streamAntigravity preserves prior projectId when onUnauthorized returns a bare token string or omits projectId", async () => {
  const initialKey = JSON.stringify({ token: "ya29.initial", projectId: "proj-custom-42" });

  for (const recoveredValue of [
    "ya29.bare-refreshed",
    JSON.stringify({ token: "ya29.json-no-proj" }),
    { token: "ya29.obj-no-proj" },
  ]) {
    const seenProjects: string[] = [];
    const seenAuthHeaders: string[] = [];
    let calls = 0;

    const client: AntigravityClient = {
      async fetchAvailableModels() {
        return {};
      },
      async postJson() {
        throw new Error("not used");
      },
      async streamGenerateContent(opts) {
        calls += 1;
        seenProjects.push(String(opts.body.project));
        seenAuthHeaders.push(String((opts.source as { apiKey?: string }).apiKey || ""));
        if (calls === 1) {
          throw new AntigravityHttpError(
            401,
            "v1internal:streamGenerateContent?alt=sse",
            "expired token",
          );
        }
        return {
          response: new Response(null, { status: 200 }),
          stream: sseStreamFromChunks([
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Preserved ok"}]},"finishReason":"STOP"}]}}\n\n',
          ]),
        };
      },
      async retrieveQuotaSummary() {
        return {};
      },
    };

    const result = await streamAntigravity(
      makeModel(),
      { messages: [{ role: "user", content: "test" }] },
      {
        apiKey: initialKey,
        onUnauthorized: async () => recoveredValue,
      },
      makeCatalogWithHydrogen(),
      client,
    ).result();

    assert.equal(calls, 2);
    assert.deepEqual(seenProjects, ["proj-custom-42", "proj-custom-42"]);
    assert.equal(JSON.parse(seenAuthHeaders[1]).projectId, "proj-custom-42");
    assert.equal(result.stopReason, "stop");
  }
});

test("streamAntigravity surfaces actionable unsigned tool call hint and thinking-only exhaustion", async () => {
  const clientUnsigned: AntigravityClient = {
    async fetchAvailableModels() {
      return {};
    },
    async postJson() {
      throw new Error("not used");
    },
    async streamGenerateContent() {
      throw new AntigravityHttpError(
        400,
        "v1internal:streamGenerateContent?alt=sse",
        "Function call is missing a thought_signature",
      );
    },
    async retrieveQuotaSummary() {
      return {};
    },
  };

  const unsignedErr = await streamAntigravity(
    makeModel(),
    { messages: [{ role: "user", content: "hi" }] },
    { apiKey: VALID_API_KEY },
    makeCatalogWithHydrogen(),
    clientUnsigned,
    {},
    { unsignedToolCalls: "fail" },
  ).result();

  assert.equal(unsignedErr.stopReason, "error");
  assert.match(unsignedErr.errorMessage || "", /Unsigned tool calls.*skip/i);

  const clientThinkingOnly: AntigravityClient = {
    async fetchAvailableModels() {
      return {};
    },
    async postJson() {
      throw new Error("not used");
    },
    async streamGenerateContent() {
      return {
        response: new Response(null, { status: 200 }),
        stream: sseStreamFromChunks([
          'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"thinking only"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":0,"thoughtsTokenCount":950,"totalTokenCount":960}}}\n\n',
        ]),
      };
    },
    async retrieveQuotaSummary() {
      return {};
    },
  };

  const thinkingOnlyErr = await streamAntigravity(
    makeModel({ maxTokens: 1000 }),
    { messages: [{ role: "user", content: "hi" }] },
    { apiKey: VALID_API_KEY, maxTokens: 1000 },
    makeCatalogWithHydrogen(),
    clientThinkingOnly,
  ).result();

  assert.equal(thinkingOnlyErr.stopReason, "error");
  assert.match(thinkingOnlyErr.errorMessage || "", /ended after thinking only/);
});

test("sleepWithAbort aborts promptly when signal fires", async () => {
  const controller = new AbortController();
  const promise = sleepWithAbort(5000, controller.signal);
  setTimeout(() => controller.abort(new Error("cancelled")), 10);
  await assert.rejects(promise, /cancelled/);
});

test("isSyntheticWaf429 classifies headerless synthetic 429 regardless of requestType", () => {
  const err = new AntigravityHttpError(
    429,
    "v1internal:streamGenerateContent?alt=sse",
    JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }),
  );
  assert.equal(isSyntheticWaf429(err), true);
  assert.equal(isSyntheticAgent429(err, {}), false);

  const delayed = new AntigravityHttpError(
    429,
    "v1internal:streamGenerateContent?alt=sse",
    JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
    { "retry-after": "5" },
  );
  assert.equal(isSyntheticWaf429(delayed), false);
});

test("isolateBlockedSystemInstruction isolates single, multiple, and seam triggers cleanly", async () => {
  const textWithMultiple = [
    "You are a coding assistant.",
    "<tools>\n- read\n- SECRET_TOOL_WAF_PHRASE\n- write\n</tools>",
    "<rules>\n- Be concise\n- SECRET_RULE_WAF_PHRASE\n</rules>",
    "<cwd>/repo</cwd>",
  ].join("\n\n");

  const multiResult = await isolateBlockedSystemInstruction({
    body: {
      project: "p",
      model: "gemini-4-hydrogen-medium",
      request: { systemInstruction: { role: "user", parts: [{ text: textWithMultiple }] } },
    },
    runProbe: async (probeBody) => {
      const txt = probeBody.request?.systemInstruction?.parts?.[0]?.text ?? "";
      return txt.includes("SECRET_TOOL_WAF_PHRASE") || txt.includes("SECRET_RULE_WAF_PHRASE")
        ? { kind: "blocked" }
        : { kind: "clean" };
    },
  });
  assert.equal(multiResult.status, "recovered");
  if (multiResult.status === "recovered") {
    assert.deepEqual(multiResult.blockedSnippets.sort(), [
      "- SECRET_RULE_WAF_PHRASE",
      "- SECRET_TOOL_WAF_PHRASE",
    ]);
    assert.ok(multiResult.sanitizedText.includes("<tools>\n- read\n- write\n</tools>"));
    assert.ok(multiResult.sanitizedText.includes("<rules>\n- Be concise\n</rules>"));
    assert.ok(multiResult.sanitizedText.includes("<cwd>/repo</cwd>"));
  }

  // Cross-line seam trigger (only triggers when lineA + "\n" + lineB appear together).
  const seamText = "You are a coding assistant.\n\n<rules>\npart one\npart two\n</rules>";
  const seamResult = await isolateBlockedSystemInstruction({
    body: {
      project: "p",
      model: "gemini-4-hydrogen-medium",
      request: { systemInstruction: { role: "user", parts: [{ text: seamText }] } },
    },
    runProbe: async (probeBody) => {
      const txt = probeBody.request?.systemInstruction?.parts?.[0]?.text ?? "";
      return txt.includes("part one\npart two") ? { kind: "blocked" } : { kind: "clean" };
    },
  });
  assert.equal(seamResult.status, "recovered");
  if (seamResult.status === "recovered") {
    assert.equal(seamResult.sanitizedText.includes("part one\npart two"), false);
  }

  // Global 429 (baseline also blocked) stops in 2 probes without bisecting.
  let globalProbeCalls = 0;
  const globalResult = await isolateBlockedSystemInstruction({
    body: {
      project: "p",
      model: "gemini-4-hydrogen-medium",
      request: { systemInstruction: { role: "user", parts: [{ text: "Line A\n\nLine B" }] } },
    },
    runProbe: async () => {
      globalProbeCalls += 1;
      return { kind: "blocked" };
    },
  });
  assert.equal(globalResult.status, "global-429");
  assert.equal(globalProbeCalls, 2);
});

test("streamAntigravity self-heals unknown WAF triggers in systemInstruction and caches remediation for subsequent turns", async () => {
  clearWafBlockedSnippets();
  const seenRequests: any[] = [];
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: unknown) => {
    warnings.push(String(msg));
  };

  try {
    const client: AntigravityClient = {
      async fetchAvailableModels() {
        return {};
      },
      async postJson() {
        throw new Error("not used");
      },
      async streamGenerateContent(opts) {
        seenRequests.push(structuredClone(opts.body));
        const sys = (opts.body?.request?.systemInstruction?.parts ?? [])
          .map((p: any) => p?.text ?? "")
          .join("\n");
        if (sys.includes("BRAND_NEW_GOOGLE_WAF_TRIGGER")) {
          throw new AntigravityHttpError(
            429,
            "v1internal:streamGenerateContent?alt=sse",
            JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }),
          );
        }
        return {
          response: new Response(null, { status: 200 }),
          stream: sseStreamFromChunks([
            'data: {"response":{"responseId":"r-healed","candidates":[{"content":{"parts":[{"text":"Healed OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":5,"totalTokenCount":55}}}\n\n',
          ]),
        };
      },
      async retrieveQuotaSummary() {
        return {};
      },
    };

    const systemPrompt = [
      "You are a coding assistant.",
      "<tools>\n- read\n- write\n</tools>",
      "<rules>\n- Keep edits minimal\n- BRAND_NEW_GOOGLE_WAF_TRIGGER\n- Report accurately\n</rules>",
      "<cwd>/tmp/work</cwd>",
    ].join("\n\n");

    const catalog = makeCatalogWithHydrogen();
    const model = makeModel();

    // Turn 1: discovers and removes ONLY "- BRAND_NEW_GOOGLE_WAF_TRIGGER", succeeds, and caches it.
    const turn1 = await streamAntigravity(
      model,
      { systemPrompt, messages: [{ role: "user", content: "hi" }] },
      { apiKey: VALID_API_KEY },
      catalog,
      client,
      {},
      { sleep: async () => {} },
    ).result();

    assert.equal(turn1.stopReason, "stop");
    assert.deepEqual(turn1.content, [{ type: "text", text: "Healed OK" }]);
    assert.deepEqual(getCachedWafBlockedSnippets(), ["- BRAND_NEW_GOOGLE_WAF_TRIGGER"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /BRAND_NEW_GOOGLE_WAF_TRIGGER/);

    const finalTurn1Body = seenRequests[seenRequests.length - 1];
    assert.equal("requestType" in finalTurn1Body, false);
    const finalTurn1Sys = finalTurn1Body.request.systemInstruction.parts[0].text;
    assert.equal(finalTurn1Sys.includes("BRAND_NEW_GOOGLE_WAF_TRIGGER"), false);
    assert.ok(finalTurn1Sys.includes("<tools>\n- read\n- write\n</tools>"));
    assert.ok(finalTurn1Sys.includes("<rules>\n- Keep edits minimal\n- Report accurately\n</rules>"));
    assert.ok(finalTurn1Sys.includes("<cwd>/tmp/work</cwd>"));
    assert.notEqual(finalTurn1Sys, WAF_SAFE_FALLBACK_SYSTEM_PROMPT);

    // Turn 2: applies cached snippet remediation immediately in 1 request with 0 retries/probes.
    const countBeforeTurn2 = seenRequests.length;
    const turn2 = await streamAntigravity(
      model,
      { systemPrompt, messages: [{ role: "user", content: "follow-up" }] },
      { apiKey: VALID_API_KEY },
      catalog,
      client,
      {},
      { sleep: async () => {} },
    ).result();

    assert.equal(turn2.stopReason, "stop");
    assert.equal(seenRequests.length - countBeforeTurn2, 1);
    assert.equal(seenRequests[seenRequests.length - 1].requestType, "agent");
  } finally {
    console.warn = origWarn;
    clearWafBlockedSnippets();
  }
});
