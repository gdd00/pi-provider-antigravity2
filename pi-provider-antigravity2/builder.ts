import { createHash, randomUUID } from "node:crypto";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_USER_AGENT_TAG, PROVIDER_ID } from "./constants.ts";
import type { ModelPlan, ThinkingConfig } from "./model-catalog.ts";
import { getModelProfile } from "./model-identity.ts";
import {
  applySystemInstructionRewrites,
  loadDefaultPromptsBundle,
  resolveOutboundSystemPrompt,
  type PromptsFileConfig,
  type SystemInstructionRewriteRule,
} from "./prompts.ts";
import type { UnsignedToolCallsMode } from "./settings.ts";

export interface ContextHelpers {
  collapseSystemMessages: (context: any) => { messages: any[] };
  getCurrentSystemPrompt: (messages: any[]) => string | undefined;
  getCurrentTools: (messages: any[]) => Array<any> | undefined;
}

export interface BuildRequestBodyParams {
  projectId: string;
  plan: ModelPlan;
  context: TranscriptContext | Record<string, any>;
  sessionId?: string;
  trajectoryId?: string;
  maxOutputTokens?: number;
  toolChoice?: string;
  unsignedToolCalls?: UnsignedToolCallsMode;
  stripRequestType?: boolean;
  adaptSystemInstruction?: boolean;
  promptsConfig?: PromptsFileConfig;
  promptsFile?: string;
  contextHelpers?: ContextHelpers;
}

const BASE64_SIGNATURE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const DEFAULT_SESSION_ID = "-3750763034362895579";

/**
 * Sentinel sent in `thoughtSignature` for unsigned foreign function calls on Gemini 3+
 * so the API accepts cross-provider tool history without signature validation failure.
 */
export const SKIP_THOUGHT_SIGNATURE_VALIDATOR =
  "c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=";

/**
 * Neutralizes blocked third-party harness signatures in outbound `systemInstruction` text
 * while keeping all instructions, tools, rules, docs, AGENTS.md, and skills intact.
 */
export function adaptSystemInstructionText(
  text: string,
  rewrites?: readonly SystemInstructionRewriteRule[],
): string {
  const bundle = loadDefaultPromptsBundle();
  const rules = rewrites ?? bundle.systemInstructionRewrites;
  return applySystemInstructionRewrites(text, rules, bundle.defaultRewriteFlags);
}

/**
 * Applies `adaptSystemInstructionText` to every text part of a `systemInstruction` payload
 * without mutating the original object.
 */
export function adaptSystemInstructionForAntigravity<
  T extends { role?: string; parts?: Array<{ text?: string; [key: string]: unknown }> },
>(systemInstruction: T, rewrites?: readonly SystemInstructionRewriteRule[]): T {
  if (!systemInstruction || !Array.isArray(systemInstruction.parts)) {
    return systemInstruction;
  }
  return {
    ...systemInstruction,
    parts: systemInstruction.parts.map((part) =>
      typeof part?.text === "string"
        ? { ...part, text: adaptSystemInstructionText(part.text, rewrites) }
        : part,
    ),
  };
}

function readMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : item?.type === "text" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Pure TypeScript fallback implementing Pi v1.5.2 transcript context normalization and
 * system-message collapsing (also accepts legacy `{ systemPrompt, tools, messages }`).
 */
export function collapseSystemMessages(context: any): { messages: any[] } {
  const rawMessages = Array.isArray(context?.messages) ? [...context.messages] : [];

  const nonSystemMessages: any[] = [];
  const systemTexts: string[] = [];
  const sections = new Map<string, string>();
  const toolMap = new Map<string, any>();

  if (typeof context?.systemPrompt === "string" && context.systemPrompt.trim()) {
    systemTexts.push(context.systemPrompt);
  }
  if (Array.isArray(context?.tools)) {
    for (const tool of context.tools) {
      if (tool?.name) toolMap.set(tool.name, tool);
    }
  }

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "system") {
      nonSystemMessages.push(msg);
      continue;
    }
    const text = readMessageText(msg.content);
    if (text) systemTexts.push(text);
    if (msg.sections && typeof msg.sections === "object") {
      for (const [key, val] of Object.entries<string | null>(msg.sections)) {
        if (val === null) sections.delete(key);
        else if (typeof val === "string") sections.set(key, val);
      }
    }
    if (Array.isArray(msg.tools)) {
      for (const tool of msg.tools) {
        if (tool?.name) toolMap.set(tool.name, tool);
      }
    }
    if (Array.isArray(msg.toolsAdded)) {
      for (const tool of msg.toolsAdded) {
        if (tool?.name) toolMap.set(tool.name, tool);
      }
    }
    if (Array.isArray(msg.toolsRemoved)) {
      for (const ref of msg.toolsRemoved) {
        const name = typeof ref === "string" ? ref : ref?.name;
        if (name) toolMap.delete(name);
      }
    }
  }

  const combinedParts = [...systemTexts];
  for (const val of sections.values()) {
    if (val) combinedParts.push(val);
  }

  const tools = [...toolMap.values()];
  const hasSystemState = combinedParts.length > 0 || tools.length > 0;
  if (!hasSystemState) {
    return { messages: nonSystemMessages };
  }

  return {
    messages: [
      {
        role: "system",
        content: combinedParts.join("\n\n"),
        ...(tools.length > 0 ? { tools, toolsAdded: tools } : {}),
        timestamp: 0,
      },
      ...nonSystemMessages,
    ],
  };
}

/**
 * Pure TypeScript reader for the active system prompt in collapsed or raw transcript messages.
 */
export function getCurrentSystemPrompt(messages: any[]): string | undefined {
  const parts: string[] = [];
  for (const msg of messages || []) {
    if (msg?.role !== "system") continue;
    const text = readMessageText(msg.content);
    if (text) parts.push(text);
  }
  const combined = parts.join("\n\n").trim();
  return combined.length > 0 ? combined : undefined;
}

/**
 * Pure TypeScript reader for the active tool declarations in transcript system messages.
 */
export function getCurrentTools(messages: any[]): Array<any> {
  const toolMap = new Map<string, any>();
  for (const msg of messages || []) {
    if (msg?.role !== "system") continue;
    if (Array.isArray(msg.tools)) {
      for (const tool of msg.tools) {
        if (tool?.name) toolMap.set(tool.name, tool);
      }
    }
    if (Array.isArray(msg.toolsAdded)) {
      for (const tool of msg.toolsAdded) {
        if (tool?.name) toolMap.set(tool.name, tool);
      }
    }
    if (Array.isArray(msg.toolsRemoved)) {
      for (const ref of msg.toolsRemoved) {
        const name = typeof ref === "string" ? ref : ref?.name;
        if (name) toolMap.delete(name);
      }
    }
  }
  return [...toolMap.values()];
}

/**
 * Strips the leading system message from collapsed transcript messages so only
 * conversational turns (`user`, `assistant`, `toolResult`, etc.) remain.
 */
export function withoutInitialSystemMessage(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return messages.filter((msg, idx) => !(idx === 0 && msg?.role === "system"));
}

const DEFAULT_CONTEXT_HELPERS: ContextHelpers = {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
};

function isValidThoughtSignature(sig: unknown): sig is string {
  if (typeof sig !== "string" || sig.length === 0) return false;
  if (sig.includes("=") && sig.length % 4 !== 0) return false;
  return BASE64_SIGNATURE_PATTERN.test(sig);
}

function resolveThoughtSignature(
  isSameProviderAndModel: boolean,
  sig: unknown,
): string | undefined {
  if (!isSameProviderAndModel) return undefined;
  return isValidThoughtSignature(sig) ? sig : undefined;
}

function deriveSessionId(conversation: Array<any>, explicitSessionId?: string): string {
  if (
    explicitSessionId &&
    typeof explicitSessionId === "string" &&
    explicitSessionId.trim().length > 0
  ) {
    return explicitSessionId.trim();
  }

  const firstMsg = conversation?.[0];
  if (!firstMsg) return randomUUID();

  const seedContent =
    typeof firstMsg.content === "string"
      ? firstMsg.content
      : JSON.stringify(firstMsg.content || "");

  const hash = createHash("sha256")
    .update(`antigravity:conversation:${seedContent}`)
    .digest()
    .subarray(0, 16);

  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function v5Uuid(seed: string): string {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resolveNumericSessionId(sessionId: string): string {
  return /^-?\d+$/.test(sessionId) ? sessionId : DEFAULT_SESSION_ID;
}

function normalizeToolCallId(id: string | undefined): string | undefined {
  if (!id || typeof id !== "string") return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

/**
 * Strips JSON Schema meta-keywords (`$schema`, `$id`, `$defs`, `definitions`) rejected by Google Protobuf Schema.
 */
export function stripMetaSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = new Set(["$schema", "$id", "$defs", "definitions"]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}

/**
 * Recursively normalizes a JSON Schema object into Google FunctionDeclaration `parameters` subset.
 */
export function normalizeCustomToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);

  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(s)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) {
      if (key === "const" && s.enum === undefined && typeof value === "string") {
        out.enum = [value];
      }
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const scalar = value.find((e) => typeof e === "string" && e !== "null");
      if (scalar) out.type = scalar;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === "enum" && Array.isArray(value) && !value.every((e) => typeof e === "string")) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

/**
 * Converts Pi tool definitions into Antigravity `functionDeclarations` format.
 */
export function convertTools(
  tools: Array<any> | undefined,
): Array<{ functionDeclarations: Array<any> }> | undefined {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = stripMetaSchema(tool.parameters) || { type: "object", properties: {} };
        return {
          name: tool.name,
          description: tool.description,
          parameters: normalizeCustomToolSchema(schema),
        };
      }),
    },
  ];
}

function buildUserParts(content: unknown): Array<any> {
  const parts: Array<any> = [];
  if (typeof content === "string") {
    parts.push({ text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;

  for (const item of content) {
    if (item?.type === "text") {
      parts.push({ text: item.text });
    } else if (item?.type === "image") {
      parts.push({
        inlineData: {
          mimeType: item.mimeType || "image/png",
          data: item.data,
        },
      });
    }
  }
  return parts;
}

function buildModelParts(
  msg: any,
  runtimeProfile: ReturnType<typeof getModelProfile>,
  skipUnsigned: boolean,
): Array<any> {
  const isSameProvider = !msg.provider || msg.provider === PROVIDER_ID;
  const isSameModel = runtimeProfile.isReplayCompatible(msg.model);
  const isSameProviderAndModel = isSameProvider && isSameModel;
  const parts: Array<any> = [];

  const isToolTurn =
    Array.isArray(msg.content) &&
    msg.content.some((item: any) => item.type === "tool_use" || item.type === "toolCall");
  let pendingThinkingSig: string | undefined;

  if (typeof msg.content === "string") {
    parts.push({ text: msg.content });
    return parts;
  }
  if (!Array.isArray(msg.content)) return parts;

  for (const item of msg.content) {
    if (item.type === "text") {
      if (typeof item.text !== "string" || item.text === "") {
        pendingThinkingSig =
          resolveThoughtSignature(isSameProviderAndModel, item.textSignature) || pendingThinkingSig;
        continue;
      }
      const part: any = { text: item.text };
      const sig =
        resolveThoughtSignature(isSameProviderAndModel, item.textSignature) || pendingThinkingSig;
      if (sig) {
        part.thoughtSignature = sig;
        pendingThinkingSig = undefined;
      }
      parts.push(part);
    } else if (item.type === "thinking") {
      const candidateSig = item.thinkingSignature;
      if (
        !isSameProviderAndModel ||
        runtimeProfile.isGpt ||
        (typeof candidateSig === "string" && candidateSig.trim().startsWith("{"))
      ) {
        continue;
      }
      const sig = resolveThoughtSignature(true, candidateSig);
      if (sig) pendingThinkingSig = sig;
      if (!isToolTurn) {
        parts.push({ thought: true, text: item.thinking || "" });
      }
    } else if (item.type === "tool_use" || item.type === "toolCall") {
      const part: any = {
        functionCall: {
          id: normalizeToolCallId(item.id),
          name: item.name,
          args: item.input || item.arguments || {},
        },
      };
      const sig =
        resolveThoughtSignature(isSameProviderAndModel, item.thoughtSignature) ||
        pendingThinkingSig;
      if (sig) {
        part.thoughtSignature = sig;
        pendingThinkingSig = undefined;
      } else if (runtimeProfile.isGemini && (!isSameProviderAndModel || skipUnsigned)) {
        part.thoughtSignature = SKIP_THOUGHT_SIGNATURE_VALIDATOR;
      }
      parts.push(part);
    }
  }

  if (parts.length > 0 && pendingThinkingSig && !parts.some((p) => p.thoughtSignature)) {
    parts[parts.length - 1].thoughtSignature = pendingThinkingSig;
  }
  return parts;
}

function buildToolResultContent(
  msg: any,
  messages: Array<any>,
  toolResultRole: "user" | "model",
): Record<string, any> {
  let toolName = msg.toolName || msg.name;
  if (!toolName && (msg.toolCallId || msg.id)) {
    const rawTargetId = msg.toolCallId || msg.id;
    const normTargetId = normalizeToolCallId(rawTargetId);
    for (const prev of messages) {
      if (prev.role === "assistant" && Array.isArray(prev.content)) {
        const found = prev.content.find(
          (c: any) =>
            (c.type === "tool_use" || c.type === "toolCall") &&
            (c.id === rawTargetId || normalizeToolCallId(c.id) === normTargetId),
        );
        if (found) {
          toolName = found.name;
          break;
        }
      }
    }
  }

  let toolText = "";
  const imageParts: Array<any> = [];
  if (Array.isArray(msg.content)) {
    const textParts: string[] = [];
    for (const c of msg.content) {
      if (typeof c === "string") textParts.push(c);
      else if (c.type === "text") textParts.push(c.text);
      else if (c.type === "image") {
        imageParts.push({
          inlineData: { mimeType: c.mimeType || "image/png", data: c.data },
        });
      } else {
        textParts.push(JSON.stringify(c));
      }
    }
    toolText = textParts.join("\n");
  } else if (typeof msg.content === "string") {
    toolText = msg.content;
  } else if (msg.content) {
    toolText = JSON.stringify(msg.content);
  }

  const functionResponse: any = {
    name: toolName || "tool",
    response: msg.isError ? { error: toolText } : { output: toolText },
  };
  const callId = normalizeToolCallId(msg.toolCallId || msg.id);
  if (callId) functionResponse.id = callId;
  if (imageParts.length > 0) functionResponse.parts = imageParts;

  return { role: toolResultRole, parts: [{ functionResponse }] };
}

/**
 * Translates Pi conversation turns into Antigravity `request.contents`, preserving
 * thought signatures, tool schemas, and family-specific tool result roles.
 */
export function translateTurnTrace(
  conversation: Array<any>,
  runtimeModelId: string,
  skipUnsigned = false,
): Array<any> {
  const contents: Array<any> = [];
  const messages = conversation || [];
  const runtimeProfile = getModelProfile(runtimeModelId);
  const toolResultRole: "user" | "model" = runtimeProfile.isClaude ? "user" : "model";

  for (const msg of messages) {
    if (msg.role === "user") {
      const parts = buildUserParts(msg.content);
      if (parts.length > 0) contents.push({ role: "user", parts });
    } else if (msg.role === "assistant") {
      if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
      const parts = buildModelParts(msg, runtimeProfile, skipUnsigned);
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else if (msg.role === "toolResult") {
      contents.push(buildToolResultContent(msg, messages, toolResultRole));
    }
  }

  if (contents.length > 0) {
    const lastContent = contents[contents.length - 1];
    if (lastContent.role === "model" && !lastContent.parts?.some((p: any) => p.functionResponse)) {
      contents.push({ role: "user", parts: [{ text: "continue" }] });
    }
  }

  return contents;
}

function clampClaudeThinkingConfig(
  thinkingConfig: ThinkingConfig,
  isClaude: boolean,
  maxOutputTokens: number,
): ThinkingConfig {
  const next: ThinkingConfig = { ...thinkingConfig };
  if (
    isClaude &&
    typeof next.thinkingBudget === "number" &&
    next.thinkingBudget > 0 &&
    maxOutputTokens > 0 &&
    next.thinkingBudget >= maxOutputTokens
  ) {
    if (maxOutputTokens > 1) {
      next.thinkingBudget = maxOutputTokens - 1;
    } else {
      delete next.thinkingBudget;
      next.includeThoughts = false;
    }
  }
  return next;
}

/**
 * Builds the complete Antigravity `v1internal:streamGenerateContent` request envelope.
 */
export function buildAntigravityRequestBody(params: BuildRequestBodyParams): Record<string, any> {
  const {
    projectId,
    plan,
    context,
    maxOutputTokens = 65536,
    stripRequestType = false,
    adaptSystemInstruction = true,
    contextHelpers = DEFAULT_CONTEXT_HELPERS,
  } = params;

  const transcript = contextHelpers.collapseSystemMessages(context);
  const systemPrompt = contextHelpers.getCurrentSystemPrompt(transcript.messages);
  const tools = convertTools(contextHelpers.getCurrentTools(transcript.messages));
  const conversation = withoutInitialSystemMessage(transcript.messages);

  const sessionId = deriveSessionId(conversation, params.sessionId);
  const cascadeId = v5Uuid(`antigravity:cascade:${sessionId}`);
  const trajectoryId =
    params.trajectoryId &&
    typeof params.trajectoryId === "string" &&
    params.trajectoryId.trim().length > 0
      ? params.trajectoryId.trim()
      : v5Uuid(`antigravity:${sessionId}`);

  const contents = translateTurnTrace(
    conversation,
    plan.runtimeModelId,
    params.unsignedToolCalls === "skip",
  );

  const requestIndex = contents.filter(
    (c) => c.role === "model" && !c.parts?.some((p: any) => p.functionResponse),
  ).length;
  const requestId = `agent/${cascadeId}/${Date.now()}/${trajectoryId}/${contents.length}`;

  const usedProfiles = conversation
    .filter(
      (m: any) =>
        m.role === "assistant" && m.model && m.stopReason !== "error" && m.stopReason !== "aborted",
    )
    .map((m: any) => getModelProfile(m.model));
  const usedClaude = plan.isClaude || usedProfiles.some((p) => p.isClaude);
  const usedNonGemini = plan.isNonGemini || usedProfiles.some((p) => p.isNonGemini);

  const labels: Record<string, string> = {
    cascade_id: cascadeId,
    last_step_index: String(Math.max(0, contents.length - 1)),
    model_enum: plan.modelEnum,
    request_id: `${trajectoryId}-${requestIndex}`,
    root_cascade_id: cascadeId,
    trajectory_id: trajectoryId,
    used_claude: String(usedClaude),
    used_claude_conservative: String(usedClaude),
    used_non_gemini_model: String(usedNonGemini),
  };

  const request: Record<string, any> = { contents };

  if (systemPrompt) {
    const effectiveSystemPrompt = adaptSystemInstruction
      ? resolveOutboundSystemPrompt(systemPrompt, params.promptsConfig ?? params.promptsFile)
      : systemPrompt;
    request.systemInstruction = {
      role: "user",
      parts: [{ text: effectiveSystemPrompt }],
    };
  }

  if (tools) {
    request.tools = tools;
  }

  if (params.toolChoice && params.toolChoice.toLowerCase() !== "auto") {
    const tc = String(params.toolChoice).toLowerCase();
    const mode = tc === "none" ? "NONE" : tc === "any" || tc === "required" ? "ANY" : "AUTO";
    request.toolConfig = { functionCallingConfig: { mode } };
  }

  request.labels = labels;
  request.generationConfig = {
    maxOutputTokens,
    thinkingConfig: clampClaudeThinkingConfig(plan.thinkingConfig, plan.isClaude, maxOutputTokens),
  };
  request.sessionId = resolveNumericSessionId(sessionId);

  const envelope: Record<string, any> = {
    project: projectId,
    requestId,
    request,
    model: plan.runtimeModelId,
    userAgent: ANTIGRAVITY_USER_AGENT_TAG,
  };

  if (!stripRequestType) {
    envelope.requestType = "agent";
  }

  return envelope;
}
