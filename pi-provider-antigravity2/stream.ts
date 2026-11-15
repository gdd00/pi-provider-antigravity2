import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  OAuthCredentials,
  SimpleStreamOptions,
  ThinkingLevel,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
import {
  parseStoredCredentials,
  refreshAntigravityToken,
  requireCredentials,
  type CredentialSource,
} from "./auth.ts";
import { buildAntigravityRequestBody, type ContextHelpers } from "./builder.ts";
import { DEFAULT_ENDPOINT } from "./constants.ts";
import { type ModelCatalog } from "./model-catalog.ts";
import { resolveEffectivePromptsConfig, type PromptsFileConfig } from "./prompts.ts";
import {
  type AntigravityClient,
  AntigravityHttpError,
  defaultAntigravityClient,
} from "./protocol.ts";
import {
  consumeSseStream,
  createStreamParserState,
  hasAnswerContent,
  type StreamDeliveryEvent,
} from "./sse.ts";
import { resolveUnsignedToolCalls, type UnsignedToolCallsMode } from "./settings.ts";
import {
  WAF_SAFE_FALLBACK_SYSTEM_PROMPT,
  applyEmergencyPiSanitization,
  getCachedWafBlockedSnippets,
  isolateBlockedSystemInstruction,
  readSystemInstructionText,
  recordWafBlockedSnippet,
  removeBlockedSnippetsFromText,
  warnWafAutoRemediationOnce,
  withSystemInstructionText,
  type ProbeOutcome,
} from "./waf-recovery.ts";

export interface StreamPiHelpers {
  createStream?: () => AssistantMessageEventStream;
  calculateCost?: (model: Model<any>, usage: Usage) => void;
  clampThinkingLevel?: (model: Model<any>, level?: ThinkingLevel) => ThinkingLevel | undefined;
  contextHelpers?: ContextHelpers;
}

export interface AntigravityStreamOptions extends SimpleStreamOptions {
  credential?: OAuthCredentials;
  onUnauthorized?: (info: {
    model: Model<any>;
    error: AntigravityHttpError;
    signal?: AbortSignal;
  }) => Promise<string | { token: string; projectId?: string } | undefined>;
  onProviderStreamEvent?: (event: unknown, model: Model<any>) => void | Promise<void>;
  trajectoryId?: string;
}

export interface StreamRetryPolicy {
  maxRetries?: number;
  baseDelayMs?: number;
  maxRetryDelayMs?: number;
  maxWafProbes?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  unsignedToolCalls?: UnsignedToolCallsMode;
  readUnsignedToolCalls?: () => UnsignedToolCallsMode;
  promptsConfig?: PromptsFileConfig;
  promptsFile?: string;
}

export interface ErrorDelayInfo {
  status?: number;
  isResourceExhausted: boolean;
  hasRetryHeader: boolean;
  hasPayloadDelay: boolean;
  retryDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

const NON_OVERFLOW_PATTERN =
  /rate limit|too many requests|quota exceeded|resource_exhausted/i;
const CONTEXT_OVERFLOW_PATTERN =
  /(?:(?:input|prompt) token count.*exceeds|prompt (?:is )?too long)/i;

/**
 * Prefixes matching context-overflow messages with `context_length_exceeded:` so
 * Pi's compaction loop triggers without misrouting quota errors.
 */
export function normalizeOverflowError(rawMessage: string): string {
  if (rawMessage.includes("context_length_exceeded")) return rawMessage;
  if (!NON_OVERFLOW_PATTERN.test(rawMessage) && CONTEXT_OVERFLOW_PATTERN.test(rawMessage)) {
    return `context_length_exceeded: ${rawMessage}`;
  }
  return rawMessage;
}

/**
 * Pure fallback cost calculator using Pi's per-million token rates on `model.cost`.
 */
export function calculateCostFallback(model: Model<any>, usage: Usage): void {
  const rate = model.cost;
  if (!rate) return;
  const input = ((usage.input || 0) * (rate.input || 0)) / 1_000_000;
  const output = ((usage.output || 0) * (rate.output || 0)) / 1_000_000;
  const cacheRead = ((usage.cacheRead || 0) * (rate.cacheRead || 0)) / 1_000_000;
  const cacheWrite = ((usage.cacheWrite || 0) * (rate.cacheWrite || 0)) / 1_000_000;
  usage.cost = {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

/**
 * Pure fallback thinking-level clamping against `model.thinkingLevelMap`.
 */
export function clampThinkingLevelFallback(
  model: Model<any>,
  requested?: ThinkingLevel,
): ThinkingLevel | undefined {
  const level = requested ?? "high";
  const map = model.thinkingLevelMap;
  if (!map) return level;

  const mapped = map[level];
  if (typeof mapped === "string") return mapped as ThinkingLevel;

  const preference: readonly ThinkingLevel[] =
    level === "off" || level === "minimal"
      ? ["low", "medium", "high", "xhigh", "max"]
      : level === "max" || level === "xhigh"
        ? ["xhigh", "high", "medium", "low"]
        : ["high", "medium", "xhigh", "max", "low"];

  for (const candidate of preference) {
    const val = map[candidate];
    if (typeof val === "string") return val as ThinkingLevel;
  }
  return undefined;
}

/**
 * Minimal zero-dependency AssistantMessageEventStream for headless or test environments.
 */
export function createFallbackEventStream(): AssistantMessageEventStream {
  const queue: AssistantMessageEvent[] = [];
  let waiting: ((res: IteratorResult<AssistantMessageEvent>) => void) | null = null;
  let closed = false;
  let finalMessage: AssistantMessage | undefined;
  let resolveResult!: (msg: AssistantMessage) => void;
  const resultPromise = new Promise<AssistantMessage>((resolve) => {
    resolveResult = resolve;
  });

  return {
    push(event: AssistantMessageEvent) {
      if (closed) return;
      if (event.type === "done") finalMessage = event.message;
      else if (event.type === "error") finalMessage = event.error;

      if (waiting) {
        const cb = waiting;
        waiting = null;
        cb({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    end(result?: AssistantMessage) {
      if (closed) return;
      closed = true;
      if (result) finalMessage = result;
      if (finalMessage) resolveResult(finalMessage);
      if (waiting) {
        const cb = waiting;
        waiting = null;
        cb({ value: undefined as any, done: true });
      }
    },
    result() {
      return resultPromise;
    },
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      return {
        next(): Promise<IteratorResult<AssistantMessageEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  } as AssistantMessageEventStream;
}

/**
 * Parses Google Protobuf duration strings (e.g. `"4.2s"`, `"500ms"`, `"1m30s"`),
 * numeric seconds, or `{ seconds, nanos }` objects into milliseconds.
 */
export function parseDurationMs(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw * 1000;
  }
  if (raw && typeof raw === "object") {
    const rec = raw as { seconds?: unknown; nanos?: unknown };
    const sec = Number(rec.seconds ?? 0);
    const nanos = Number(rec.nanos ?? 0);
    if ((Number.isFinite(sec) || Number.isFinite(nanos)) && (rec.seconds !== undefined || rec.nanos !== undefined)) {
      return Math.max(0, Math.round(sec * 1000 + nanos / 1_000_000));
    }
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1000);
  }

  let totalMs = 0;
  let matchedAny = false;
  const unitRegex = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gi;
  let match: RegExpExecArray | null;
  while ((match = unitRegex.exec(trimmed)) !== null) {
    matchedAny = true;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "ms") totalMs += value;
    else if (unit === "s") totalMs += value * 1000;
    else if (unit === "m") totalMs += value * 60_000;
    else if (unit === "h") totalMs += value * 3_600_000;
  }
  return matchedAny ? Math.round(totalMs) : undefined;
}

function parseRetryHeaderMs(
  headers: Record<string, string> | undefined,
  retryAfter: string | undefined,
  nowFn: () => number,
): { hasRetryHeader: boolean; delayMs?: number } {
  const rawMs = headers?.["retry-after-ms"];
  if (typeof rawMs === "string" && rawMs.trim()) {
    const parsedMs = Number(rawMs.trim());
    return {
      hasRetryHeader: true,
      delayMs: Number.isFinite(parsedMs) ? Math.max(0, Math.round(parsedMs)) : undefined,
    };
  }

  const rawAfter = retryAfter ?? headers?.["retry-after"];
  if (typeof rawAfter !== "string" || !rawAfter.trim()) {
    return { hasRetryHeader: false };
  }
  const trimmed = rawAfter.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return { hasRetryHeader: true, delayMs: Math.round(Number(trimmed) * 1000) };
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return { hasRetryHeader: true, delayMs: Math.max(0, dateMs - nowFn()) };
  }
  return { hasRetryHeader: true };
}

function findPayloadDelayValue(node: unknown): unknown {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPayloadDelayValue(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  for (const key of ["quotaResetDelay", "retryDelay"]) {
    const val = obj[key];
    if (val !== undefined && val !== null && val !== "") {
      return val;
    }
  }
  for (const value of Object.values(obj)) {
    const found = findPayloadDelayValue(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Inspects an HTTP error to determine if it is a rate/quota limit error and whether
 * `Retry-After` or `quotaResetDelay` / `retryDelay` duration metadata is present.
 */
export function inspectAntigravityError(
  err: unknown,
  nowFn: () => number = Date.now,
): ErrorDelayInfo {
  const httpErr =
    err instanceof AntigravityHttpError
      ? err
      : err && typeof err === "object" && "status" in err
        ? (err as {
            status?: number;
            errorBody?: string;
            message?: string;
            retryAfter?: string;
            headers?: Record<string, string>;
          })
        : undefined;

  const status = typeof httpErr?.status === "number" ? httpErr.status : undefined;
  const errorBody =
    typeof httpErr?.errorBody === "string"
      ? httpErr.errorBody
      : err instanceof Error
        ? err.message
        : "";

  const headerInfo = parseRetryHeaderMs(httpErr?.headers, httpErr?.retryAfter, nowFn);

  let parsedJson: unknown;
  try {
    parsedJson = errorBody ? JSON.parse(errorBody) : undefined;
  } catch {
    parsedJson = undefined;
  }

  const rootError = Array.isArray(parsedJson)
    ? (parsedJson[0] as any)?.error
    : (parsedJson as any)?.error;
  const jsonStatus = typeof rootError?.status === "string" ? rootError.status : undefined;
  const isResourceExhausted =
    status === 429 &&
    (jsonStatus === "RESOURCE_EXHAUSTED" || /RESOURCE_EXHAUSTED/i.test(errorBody));

  const payloadDelayRaw = parsedJson !== undefined ? findPayloadDelayValue(parsedJson) : undefined;
  const payloadDelayMs =
    payloadDelayRaw !== undefined ? parseDurationMs(payloadDelayRaw) : undefined;
  const hasPayloadDelay = payloadDelayMs !== undefined;

  return {
    status,
    isResourceExhausted,
    hasRetryHeader: headerInfo.hasRetryHeader,
    hasPayloadDelay,
    retryDelayMs: payloadDelayMs ?? headerInfo.delayMs,
  };
}

/**
 * Returns true if the error is an instant synthetic `429 RESOURCE_EXHAUSTED`
 * (lacking any Retry-After header or JSON reset/retry delay), which Antigravity's
 * proxy WAF returns for blocked `systemInstruction` or `requestType` payloads.
 */
export function isSyntheticWaf429(err: unknown, nowFn: () => number = Date.now): boolean {
  const info = inspectAntigravityError(err, nowFn);
  return (
    info.status === 429 &&
    info.isResourceExhausted &&
    !info.hasRetryHeader &&
    !info.hasPayloadDelay
  );
}

/**
 * Returns true if the error is an instant synthetic `429 RESOURCE_EXHAUSTED` triggered
 * by `requestType === "agent"` (lacking any Retry-After header or JSON reset/retry delay).
 */
export function isSyntheticAgent429(
  err: unknown,
  requestBody: Record<string, any> | undefined,
  nowFn: () => number = Date.now,
): boolean {
  if (requestBody?.requestType !== "agent") return false;
  return isSyntheticWaf429(err, nowFn);
}

async function closeStreamResultQuietly(res: {
  response?: Response;
  stream?: AsyncIterable<unknown>;
}): Promise<void> {
  const iter = res.stream?.[Symbol.asyncIterator]?.();
  await iter?.return?.().catch(() => {});
  await res.response?.body?.cancel?.().catch(() => {});
}

function applyOutboundWafTransforms(
  body: Record<string, any>,
  options: { emergencySanitizeSystem: boolean; isolatedSanitizedSystemText?: string },
): Record<string, any> {
  const rawSystemText = readSystemInstructionText(body);
  if (!rawSystemText) return body;

  let nextSystemText = rawSystemText;
  const cachedSnippets = getCachedWafBlockedSnippets();
  if (cachedSnippets.length > 0) {
    const afterCache = removeBlockedSnippetsFromText(nextSystemText, cachedSnippets);
    if (afterCache !== nextSystemText) {
      nextSystemText = afterCache || WAF_SAFE_FALLBACK_SYSTEM_PROMPT;
    }
  }

  if (options.emergencySanitizeSystem) {
    nextSystemText = applyEmergencyPiSanitization(nextSystemText);
  }

  if (options.isolatedSanitizedSystemText !== undefined) {
    nextSystemText = options.isolatedSanitizedSystemText;
  }

  if (nextSystemText === rawSystemText) return body;
  return withSystemInstructionText(body, nextSystemText);
}

/**
 * Sleeps for `ms` milliseconds while respecting AbortSignal immediately.
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Request was aborted"));
  }
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Request was aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof AntigravityHttpError) return false;
  if (err instanceof TypeError) return true;
  const code = (err as { code?: unknown }).code;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_SOCKET"
  );
}

function unsignedToolCallHint(): string {
  return (
    "\n\nA tool call in this turn has no thoughtSignature, usually because another extension " +
    'rewrote the conversation history. Disable that extension, or set "Unsigned tool calls" ' +
    'to "skip" in /antigravity settings. skip sends Google\'s skip_thought_signature_validator ' +
    "for such calls, which may degrade reasoning for the rest of the turn."
  );
}

function collectResponseHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function mergeRequestHeaders(
  model: Model<any>,
  options?: AntigravityStreamOptions,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of [model.headers, options?.headers]) {
    if (!source) continue;
    for (const [k, v] of Object.entries(source)) {
      if (typeof v === "string" && k.toLowerCase() !== "host") {
        merged[k] = v;
      }
    }
  }
  return merged;
}

function packRecoveredCredentials(
  recovered: string | { token: string; projectId?: string },
  fallbackProjectId?: string,
): CredentialSource | undefined {
  const inheritedProjectId = fallbackProjectId?.trim() || undefined;
  if (typeof recovered === "string") {
    const trimmed = recovered.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as {
        token?: unknown;
        access_token?: unknown;
        projectId?: unknown;
      };
      const rawToken =
        typeof parsed?.token === "string"
          ? parsed.token
          : typeof parsed?.access_token === "string"
            ? parsed.access_token
            : undefined;
      if (rawToken !== undefined) {
        if (!rawToken.trim()) return undefined;
        const explicitProject =
          typeof parsed.projectId === "string" && parsed.projectId.trim()
            ? parsed.projectId.trim()
            : undefined;
        const projectId = explicitProject ?? inheritedProjectId;
        return {
          apiKey: JSON.stringify({
            token: rawToken,
            ...(projectId ? { projectId } : {}),
          }),
        };
      }
    } catch {
      // Plain bearer token string.
    }
    const { token } = parseStoredCredentials(trimmed);
    if (!token || !token.trim()) return undefined;
    return {
      apiKey: inheritedProjectId
        ? JSON.stringify({ token, projectId: inheritedProjectId })
        : token,
    };
  }

  if (recovered && typeof recovered === "object" && typeof recovered.token === "string" && recovered.token.trim()) {
    const projectId = recovered.projectId?.trim() || inheritedProjectId;
    return {
      apiKey: JSON.stringify({
        token: recovered.token,
        ...(projectId ? { projectId } : {}),
      }),
    };
  }
  return undefined;
}

async function tryRecoverUnauthorized(
  err: unknown,
  model: Model<any>,
  options: AntigravityStreamOptions | undefined,
  fetchImpl?: typeof fetch,
  fallbackProjectId?: string,
): Promise<CredentialSource | undefined> {
  if (!(err instanceof AntigravityHttpError) || err.status !== 401) {
    return undefined;
  }

  if (options?.onUnauthorized) {
    const recovered = await options.onUnauthorized({
      model,
      error: err,
      signal: options.signal,
    });
    if (recovered !== undefined) {
      const packed = packRecoveredCredentials(recovered, fallbackProjectId);
      if (packed) return packed;
    }
  }

  if (options?.credential?.refresh) {
    const refreshed = await refreshAntigravityToken(
      options.credential,
      options.signal,
      fetchImpl,
    );
    return { apiKey: refreshed.access };
  }

  return undefined;
}

/**
 * Streams an Antigravity turn into a Pi AssistantMessageEventStream, handling synthetic 429
 * `requestType` fallback, bounded backoff retries for real quota/transient errors,
 * optional 401 token refresh recovery, and SSE event normalization.
 */
export function streamAntigravity(
  model: Model<any>,
  context: TranscriptContext | Record<string, any>,
  options: AntigravityStreamOptions | undefined,
  catalog: ModelCatalog,
  client: AntigravityClient = defaultAntigravityClient,
  piHelpers: StreamPiHelpers = {},
  retryPolicy: StreamRetryPolicy = {},
): AssistantMessageEventStream {
  const createStream = piHelpers.createStream ?? createFallbackEventStream;
  const calcCost = piHelpers.calculateCost ?? calculateCostFallback;
  const clampLevel = piHelpers.clampThinkingLevel ?? clampThinkingLevelFallback;
  const maxRetries = retryPolicy.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = retryPolicy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxRetryDelayMs = retryPolicy.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const sleep = retryPolicy.sleep ?? sleepWithAbort;
  const nowFn = retryPolicy.now ?? Date.now;

  const stream = createStream();

  (async () => {
    const unsignedToolCalls =
      retryPolicy.unsignedToolCalls ??
      retryPolicy.readUnsignedToolCalls?.() ??
      resolveUnsignedToolCalls();

    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: nowFn(),
    };

    try {
      stream.push({ type: "start", partial: output });

      const effort = clampLevel(model, options?.reasoning ?? "high");
      const trajectoryId =
        options && "trajectoryId" in options && typeof options.trajectoryId === "string"
          ? options.trajectoryId
          : undefined;
      const plan = catalog.resolvePlan(model.id, effort);
      const maxOutputTokens = options?.maxTokens ?? model.maxTokens;
      const endpoint = model.baseUrl || DEFAULT_ENDPOINT;
      const mergedHeaders = mergeRequestHeaders(model, options);

      let activeSource: CredentialSource = options as CredentialSource;
      let stripRequestType = false;
      let strippedFallbackUsed = false;
      let emergencySanitizeSystem = false;
      let wafIsolationUsed = false;
      let isolatedSanitizedSystemText: string | undefined;
      let authRefreshUsed = false;
      let transientAttempts = 0;

      const executeWafProbe = async (
        probeBody: Record<string, any>,
        projectId: string,
      ): Promise<ProbeOutcome> => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const probeRes = await client.streamGenerateContent({
              source: activeSource,
              endpoint,
              headers: mergedHeaders,
              body: probeBody,
              signal: options?.signal,
            });
            await closeStreamResultQuietly(probeRes);
            return { kind: "clean" };
          } catch (probeErr) {
            if (options?.signal?.aborted) throw probeErr;
            if (attempt === 0 && !authRefreshUsed) {
              const refreshed = await tryRecoverUnauthorized(
                probeErr,
                model,
                options,
                retryPolicy.fetchImpl,
                projectId,
              );
              if (refreshed) {
                activeSource = refreshed;
                authRefreshUsed = true;
                continue;
              }
            }
            if (isSyntheticWaf429(probeErr, nowFn)) {
              return { kind: "blocked" };
            }
            return { kind: "inconclusive", error: probeErr };
          }
        }
        return { kind: "inconclusive", error: new Error("WAF probe exhausted retries") };
      };

      while (true) {
        if (options?.signal?.aborted) {
          throw options.signal.reason ?? new Error("Request was aborted");
        }

        const creds = await requireCredentials(activeSource);
        const promptsConfig =
          retryPolicy.promptsConfig ?? resolveEffectivePromptsConfig(retryPolicy.promptsFile);

        let requestBody = buildAntigravityRequestBody({
          projectId: creds.projectId,
          plan,
          context,
          sessionId: options?.sessionId,
          trajectoryId,
          maxOutputTokens,
          toolChoice: options?.toolChoice,
          unsignedToolCalls,
          stripRequestType,
          promptsConfig,
          promptsFile: retryPolicy.promptsFile,
          contextHelpers: piHelpers.contextHelpers,
        });

        if (options?.onPayload) {
          const replacement = await options.onPayload(requestBody, model);
          if (replacement !== undefined) {
            requestBody = replacement as Record<string, any>;
            if (stripRequestType && requestBody && "requestType" in requestBody) {
              const cloned = { ...requestBody };
              delete cloned.requestType;
              requestBody = cloned;
            }
          }
        }

        requestBody = applyOutboundWafTransforms(requestBody, {
          emergencySanitizeSystem,
          isolatedSanitizedSystemText,
        });

        let streamResult;
        try {
          streamResult = await client.streamGenerateContent({
            source: activeSource,
            endpoint,
            headers: mergedHeaders,
            body: requestBody,
            signal: options?.signal,
          });
        } catch (err) {
          if (options?.signal?.aborted) throw err;

          if (!authRefreshUsed) {
            const refreshedSource = await tryRecoverUnauthorized(
              err,
              model,
              options,
              retryPolicy.fetchImpl,
              creds.projectId,
            );
            if (refreshedSource) {
              activeSource = refreshedSource;
              authRefreshUsed = true;
              continue;
            }
          }

          const syntheticWaf429 = isSyntheticWaf429(err, nowFn);
          if (!strippedFallbackUsed && syntheticWaf429) {
            const hadRequestType = requestBody?.requestType === "agent";
            const currentSys = readSystemInstructionText(requestBody);
            const sanitizedSys = currentSys ? applyEmergencyPiSanitization(currentSys) : currentSys;
            stripRequestType = true;
            emergencySanitizeSystem = true;
            strippedFallbackUsed = true;
            if (hadRequestType || sanitizedSys !== currentSys) {
              continue;
            }
          }

          if (strippedFallbackUsed && !wafIsolationUsed && syntheticWaf429) {
            wafIsolationUsed = true;
            const currentSys = readSystemInstructionText(requestBody);
            const maxWafProbes = retryPolicy.maxWafProbes;
            if (
              currentSys.trim() &&
              currentSys.trim() !== WAF_SAFE_FALLBACK_SYSTEM_PROMPT &&
              (maxWafProbes === undefined || maxWafProbes > 0)
            ) {
              const recovery = await isolateBlockedSystemInstruction({
                body: requestBody,
                maxProbes: maxWafProbes,
                runProbe: (probeBody) => executeWafProbe(probeBody, creds.projectId),
              });
              if (recovery.status === "recovered") {
                for (const snippet of recovery.blockedSnippets) {
                  recordWafBlockedSnippet(snippet);
                }
                warnWafAutoRemediationOnce(recovery.blockedSnippets);
                isolatedSanitizedSystemText = recovery.sanitizedText;
                stripRequestType = true;
                continue;
              }
            }
          }

          const info = inspectAntigravityError(err, nowFn);
          if (
            info.status === 429 &&
            strippedFallbackUsed &&
            !info.hasRetryHeader &&
            !info.hasPayloadDelay
          ) {
            throw err;
          }

          const isRetryableStatus =
            info.status !== undefined && RETRYABLE_HTTP_STATUSES.has(info.status);
          if ((isRetryableStatus || isTransientNetworkError(err)) && transientAttempts < maxRetries) {
            const delayMs =
              info.retryDelayMs !== undefined
                ? info.retryDelayMs
                : Math.min(maxRetryDelayMs, baseDelayMs * 2 ** transientAttempts);

            if (delayMs > maxRetryDelayMs) {
              throw err;
            }

            transientAttempts += 1;
            await sleep(delayMs, options?.signal);
            continue;
          }

          throw err;
        }

        if (options?.onResponse) {
          await options.onResponse(
            {
              status: streamResult.response.status,
              headers: collectResponseHeaders(streamResult.response),
            },
            model,
          );
        }

        const state = createStreamParserState(output.content);
        let lastTotalTokens = -1;

        const updateOutputMetadata = () => {
          output.usage.input = state.usage.input;
          output.usage.cacheRead = state.usage.cacheRead;
          output.usage.output = state.usage.output;
          output.usage.reasoning = state.usage.reasoning;
          output.usage.totalTokens = state.usage.total;
          if (state.usage.total !== lastTotalTokens) {
            lastTotalTokens = state.usage.total;
            if (model.cost) calcCost(model, output.usage);
          }
          if (state.responseId) output.responseId ||= state.responseId;
          if (state.modelVersion && state.modelVersion !== model.id) {
            output.responseModel = state.modelVersion;
          }
          output.stopReason = state.stopReason;
          if (state.rawStopReason) output.rawStopReason = state.rawStopReason;
        };

        await consumeSseStream({
          streamBody: streamResult.stream,
          state,
          signal: options?.signal,
          onProviderEvent: options?.onProviderStreamEvent
            ? (payload) => options.onProviderStreamEvent!(payload, model)
            : undefined,
          onEvent: (ev: StreamDeliveryEvent) => {
            updateOutputMetadata();
            stream.push({ ...ev, partial: output } as AssistantMessageEvent);
          },
          onComplete: updateOutputMetadata,
        });

        break;
      }

      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error("Request was aborted");
      }
      if (output.stopReason === "pending") {
        throw new Error("Provider stream ended without a stop reason");
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(
          output.rawStopReason
            ? `Provider stopped with: ${output.rawStopReason}`
            : output.errorMessage || "An unknown error occurred",
        );
      }

      if (output.stopReason === "stop" && !hasAnswerContent(output.content)) {
        const reasoningTokens = output.usage.reasoning ?? 0;
        const budgetThreshold = Math.max(1, Math.floor(maxOutputTokens * 0.9));
        if (reasoningTokens >= budgetThreshold) {
          throw new Error(
            `Antigravity returned no answer: the turn ended after thinking only ` +
              `(reasoning ${reasoningTokens} of ${maxOutputTokens} max output tokens). ` +
              `Lower the thinking level or prompt again.`,
          );
        }
        throw new Error(
          `Antigravity returned an empty response with no answer ` +
            `(reasoning ${reasoningTokens} of ${maxOutputTokens} max output tokens). ` +
            `Please retry your request.`,
        );
      }

      const doneReason: "stop" | "toolUse" | "length" =
        output.stopReason === "toolUse" || output.stopReason === "length"
          ? output.stopReason
          : "stop";

      stream.push({
        type: "done",
        reason: doneReason,
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      const rawMessage = error instanceof Error ? error.message : String(error);
      output.errorMessage = normalizeOverflowError(rawMessage);
      if (unsignedToolCalls === "fail" && rawMessage.includes("missing a thought_signature")) {
        output.errorMessage += unsignedToolCallHint();
      }
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}
