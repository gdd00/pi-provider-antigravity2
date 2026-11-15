import type { TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

export type ParsedBlock = TextContent | ThinkingContent | ToolCall;

export interface ParsedUsage {
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  total: number;
}

export interface ParsedStreamResult {
  content: ParsedBlock[];
  usage: ParsedUsage;
  stopReason: "pending" | "stop" | "toolUse" | "length" | "error";
  rawStopReason?: string;
  responseId?: string;
}

export type StreamDeliveryEvent =
  | { type: "text_start" | "thinking_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall };

export interface StreamParserState {
  content: ParsedBlock[];
  usage: ParsedUsage;
  stopReason: ParsedStreamResult["stopReason"];
  rawStopReason?: string;
  openType: "text" | "thinking" | null;
  lastThoughtSignature?: string;
  responseId?: string;
  modelVersion?: string;
  buffer: string;
}

/**
 * Creates a fresh SSE parser state, optionally reusing an output content array.
 */
export function createStreamParserState(content: ParsedBlock[] = []): StreamParserState {
  return {
    content,
    usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 },
    stopReason: "pending",
    openType: null,
    buffer: "",
  };
}

/**
 * Attaches a trailing `thoughtSignature` onto an existing block when no block already
 * carries one, or preserves it on an empty signature-carrier text block.
 */
export function attachLoneSignature(content: ParsedBlock[], lastThoughtSignature?: string): void {
  if (!lastThoughtSignature) return;
  const attached = content.some((b) =>
    b.type === "thinking"
      ? Boolean(b.thinkingSignature)
      : b.type === "toolCall"
        ? Boolean(b.thoughtSignature)
        : b.type === "text"
          ? Boolean(b.textSignature)
          : false,
  );
  if (attached) return;

  const thinking = content.find((b): b is ThinkingContent => b.type === "thinking");
  if (thinking) {
    if (!thinking.thinkingSignature) thinking.thinkingSignature = lastThoughtSignature;
    return;
  }

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block?.type === "text" && !block.textSignature) {
      block.textSignature = lastThoughtSignature;
      return;
    }
  }

  content.push({ type: "text", text: "", textSignature: lastThoughtSignature });
}

/**
 * Returns true if the parsed blocks contain an actual answer (non-empty text or tool call).
 */
export function hasAnswerContent(content: ParsedBlock[]): boolean {
  return content.some((block) =>
    block.type === "toolCall"
      ? true
      : block.type === "text"
        ? block.text.trim().length > 0
        : false,
  );
}

function closeOpenBlock(
  state: StreamParserState,
  onEvent?: (ev: StreamDeliveryEvent) => void,
): void {
  if (state.openType === null) return;
  const contentIndex = state.content.length - 1;
  const block = state.content[contentIndex];
  if (block?.type === "thinking") {
    onEvent?.({ type: "thinking_end", contentIndex, content: block.thinking });
  } else if (block?.type === "text") {
    onEvent?.({ type: "text_end", contentIndex, content: block.text });
  }
  state.openType = null;
}

function parseSseDataPayload(rawLine: string): any | undefined {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return undefined;
  const dataStr = line.slice(5).trim();
  if (!dataStr || dataStr === "[DONE]") return undefined;
  try {
    return JSON.parse(dataStr);
  } catch {
    return undefined;
  }
}

function updateUsageMetadata(state: StreamParserState, um: any): void {
  const promptTokens = typeof um.promptTokenCount === "number" ? um.promptTokenCount : 0;
  const cacheRead = typeof um.cachedContentTokenCount === "number" ? um.cachedContentTokenCount : 0;
  state.usage.input = Math.max(0, promptTokens - cacheRead);
  state.usage.cacheRead = cacheRead;
  const candidates = typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : 0;
  const thoughts = typeof um.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : 0;
  state.usage.output = candidates + thoughts;
  state.usage.reasoning = thoughts;
  if (typeof um.totalTokenCount === "number") state.usage.total = um.totalTokenCount;
}

function applyCandidateStopReason(state: StreamParserState, finishReason: unknown): void {
  if (finishReason === "MAX_TOKENS") {
    state.stopReason = "length";
    state.rawStopReason = "MAX_TOKENS";
  } else if (finishReason === "STOP") {
    if (state.stopReason === "pending") {
      state.stopReason = "stop";
    }
  } else if (typeof finishReason === "string") {
    state.stopReason = "error";
    state.rawStopReason = finishReason;
  }
}

function applyPart(
  part: any,
  state: StreamParserState,
  onEvent?: (ev: StreamDeliveryEvent) => void,
): void {
  if (part.thoughtSignature) {
    state.lastThoughtSignature = part.thoughtSignature;
  }

  if (part.thought) {
    const delta = part.text || "";
    if (delta === "" && state.openType !== "thinking") return;
    if (state.openType !== "thinking") {
      closeOpenBlock(state, onEvent);
      state.content.push({ type: "thinking", thinking: "" });
      onEvent?.({ type: "thinking_start", contentIndex: state.content.length - 1 });
      state.openType = "thinking";
    }
    const block = state.content[state.content.length - 1];
    if (block?.type !== "thinking") return;
    block.thinking += delta;
    if (part.thoughtSignature) {
      block.thinkingSignature = part.thoughtSignature;
    }
    onEvent?.({
      type: "thinking_delta",
      contentIndex: state.content.length - 1,
      delta,
    });
  } else if (part.functionCall) {
    closeOpenBlock(state, onEvent);
    if (state.stopReason === "pending" || state.stopReason === "stop") {
      state.stopReason = "toolUse";
    }
    const block: ToolCall = {
      type: "toolCall",
      id: part.functionCall.id || `call_${state.content.length}`,
      name: part.functionCall.name || "",
      arguments: part.functionCall.args || {},
      thoughtSignature: part.thoughtSignature || state.lastThoughtSignature,
    };
    state.content.push(block);
    const contentIndex = state.content.length - 1;
    onEvent?.({ type: "toolcall_start", contentIndex });
    onEvent?.({
      type: "toolcall_delta",
      contentIndex,
      delta: JSON.stringify(block.arguments),
    });
    onEvent?.({ type: "toolcall_end", contentIndex, toolCall: block });
  } else if (part.text !== undefined) {
    if (part.text === "" && state.openType !== "text") return;
    if (state.openType !== "text") {
      closeOpenBlock(state, onEvent);
      state.content.push({ type: "text", text: "" });
      onEvent?.({ type: "text_start", contentIndex: state.content.length - 1 });
      state.openType = "text";
    }
    const block = state.content[state.content.length - 1];
    if (block?.type !== "text") return;
    block.text += part.text;
    onEvent?.({
      type: "text_delta",
      contentIndex: state.content.length - 1,
      delta: part.text,
    });
  }
}

function applyParsedPayload(
  payload: any,
  state: StreamParserState,
  onEvent?: (ev: StreamDeliveryEvent) => void,
): void {
  const streamError = payload?.error ?? payload?.response?.error;
  if (streamError) {
    throw new Error(streamError.message ?? JSON.stringify(streamError));
  }

  const response = payload.response || payload;
  if (response.responseId && !state.responseId) {
    state.responseId = response.responseId;
  }
  if (typeof response.modelVersion === "string" && response.modelVersion) {
    state.modelVersion = response.modelVersion;
  }
  if (response.usageMetadata) {
    updateUsageMetadata(state, response.usageMetadata);
  }

  const candidate = response.candidates?.[0];
  if (!candidate) return;

  applyCandidateStopReason(state, candidate.finishReason);

  const parts = candidate.content?.parts || [];
  for (const part of parts) {
    applyPart(part, state, onEvent);
  }
}

function feedChunkSync(
  chunk: string,
  state: StreamParserState,
  onEvent?: (ev: StreamDeliveryEvent) => void,
  onProviderEvent?: (payload: unknown) => void,
): void {
  state.buffer += chunk;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() || "";
  for (const line of lines) {
    const payload = parseSseDataPayload(line);
    if (payload === undefined) continue;
    onProviderEvent?.(payload);
    applyParsedPayload(payload, state, onEvent);
  }
}

function finishStreamSync(
  state: StreamParserState,
  onEvent?: (ev: StreamDeliveryEvent) => void,
  onProviderEvent?: (payload: unknown) => void,
): void {
  if (state.buffer.trim() !== "") {
    const payload = parseSseDataPayload(state.buffer);
    if (payload !== undefined) {
      onProviderEvent?.(payload);
      applyParsedPayload(payload, state, onEvent);
    }
  }
  state.buffer = "";
  closeOpenBlock(state, onEvent);
  attachLoneSignature(state.content, state.lastThoughtSignature);
}

/**
 * Pure synchronous parser for whole or chunked Antigravity SSE payloads.
 */
export function parseAntigravitySseResponse(
  rawSse: string | Iterable<string>,
  onEvent?: (ev: StreamDeliveryEvent) => void,
  onProviderEvent?: (payload: unknown) => void,
): ParsedStreamResult {
  const state = createStreamParserState();
  if (typeof rawSse === "string") {
    feedChunkSync(rawSse, state, onEvent, onProviderEvent);
  } else {
    for (const chunk of rawSse) {
      feedChunkSync(chunk, state, onEvent, onProviderEvent);
    }
  }
  finishStreamSync(state, onEvent, onProviderEvent);

  return {
    content: state.content,
    usage: state.usage,
    stopReason: state.stopReason,
    rawStopReason: state.rawStopReason,
    responseId: state.responseId,
  };
}

/**
 * Incrementally consumes a ReadableStream of SSE bytes, optionally awaiting
 * `onProviderEvent` for each parsed JSON frame before dispatching normalized events.
 */
export async function consumeSseStream(params: {
  streamBody: ReadableStream<Uint8Array>;
  state: StreamParserState;
  onEvent: (ev: StreamDeliveryEvent) => void;
  onProviderEvent?: (payload: unknown) => void | Promise<void>;
  onComplete?: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { streamBody, state, onEvent, onProviderEvent, onComplete, signal } = params;
  const reader = streamBody.getReader();
  const decoder = new TextDecoder();

  const handleLine = async (rawLine: string) => {
    const payload = parseSseDataPayload(rawLine);
    if (payload === undefined) return;
    if (onProviderEvent) {
      await onProviderEvent(payload);
    }
    applyParsedPayload(payload, state, onEvent);
  };

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      state.buffer += decoder.decode(value, { stream: true });
      const lines = state.buffer.split("\n");
      state.buffer = lines.pop() || "";
      for (const line of lines) {
        await handleLine(line);
      }
    }
    const trailing = decoder.decode();
    if (trailing) state.buffer += trailing;
    if (state.buffer.trim() !== "") {
      await handleLine(state.buffer);
    }
    state.buffer = "";
    closeOpenBlock(state, onEvent);
    attachLoneSignature(state.content, state.lastThoughtSignature);
    onComplete?.();
  } finally {
    reader.releaseLock();
  }
}
