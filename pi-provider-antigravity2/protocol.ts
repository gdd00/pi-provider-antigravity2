import {
  AntigravityAuthError,
  type CredentialSource,
  requireCredentials,
  resolveCredentials,
} from "./auth.ts";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_HOST,
  DEFAULT_USER_AGENT,
  FALLBACK_PROJECT_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./constants.ts";

export {
  AntigravityAuthError,
  DEFAULT_ENDPOINT,
  DEFAULT_HOST,
  DEFAULT_USER_AGENT,
  FALLBACK_PROJECT_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
};

function collectHeadersMap(headers: Headers): Record<string, string> {
  const map: Record<string, string> = {};
  headers.forEach((value, key) => {
    map[key.toLowerCase()] = value;
  });
  return map;
}

/**
 * Structured HTTP error thrown when an Antigravity endpoint returns a non-2xx response.
 * Preserves status code, path, raw error body, and response headers (such as Retry-After).
 */
export class AntigravityHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly errorBody: string;
  readonly headers: Record<string, string>;
  readonly retryAfter?: string;

  constructor(
    status: number,
    path: string,
    errorBody: string,
    headers: Record<string, string> = {},
  ) {
    super(`Antigravity request to ${path} failed (${status}): ${errorBody}`);
    this.name = "AntigravityHttpError";
    this.status = status;
    this.path = path;
    this.errorBody = errorBody;
    this.headers = headers;
    this.retryAfter = headers["retry-after"] ?? headers["retry-after-ms"];
  }
}

export interface AntigravityPostParams {
  auth: string | { token: string };
  path: string;
  body: unknown;
  endpoint?: string;
  userAgent?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface AntigravityStreamResult {
  response: Response;
  stream: ReadableStream<Uint8Array>;
}

function resolveToken(auth: string | { token: string }): string {
  if (typeof auth === "string") return auth;
  if (auth && typeof auth.token === "string") return auth.token;
  throw new Error("Invalid auth parameter: missing token string");
}

/**
 * Builds canonical Antigravity HTTP headers without forcing a manual Host header.
 */
export function buildAntigravityHeaders(
  token: string,
  userAgent = DEFAULT_USER_AGENT,
): Record<string, string> {
  return {
    "User-Agent": userAgent,
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function postAntigravityRaw({
  auth,
  path,
  endpoint = DEFAULT_ENDPOINT,
  userAgent = DEFAULT_USER_AGENT,
  headers,
  body,
  signal,
  fetchImpl = fetch,
}: AntigravityPostParams): Promise<Response> {
  const token = resolveToken(auth);
  const mergedHeaders: Record<string, string> = {
    ...buildAntigravityHeaders(token, userAgent),
  };
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "host") continue;
      mergedHeaders[key] = value;
    }
  }
  return fetchImpl(`${endpoint}/${path}`, {
    method: "POST",
    headers: mergedHeaders,
    body: JSON.stringify(body),
    signal,
  });
}

async function throwHttpError(res: Response, path: string): Promise<never> {
  const errText = await res.text();
  throw new AntigravityHttpError(res.status, path, errText, collectHeadersMap(res.headers));
}

/**
 * Posts a JSON payload to `v1internal` and parses the JSON response, throwing `AntigravityHttpError` on failure.
 */
export async function postAntigravityJson<T>(params: AntigravityPostParams): Promise<T> {
  const res = await postAntigravityRaw(params);
  if (!res.ok) {
    return throwHttpError(res, params.path);
  }
  return (await res.json()) as T;
}

/**
 * Posts a JSON payload to `v1internal` and validates the streaming response body.
 */
export async function postAntigravityStream(
  params: AntigravityPostParams,
): Promise<AntigravityStreamResult> {
  const res = await postAntigravityRaw(params);
  if (!res.ok) {
    return throwHttpError(res, params.path);
  }
  if (!res.body) {
    throw new Error(`No response stream received from Antigravity for ${params.path}.`);
  }
  return { response: res, stream: res.body };
}

export interface AntigravityClient {
  readonly endpoint: string;
  readonly userAgent: string;

  fetchAvailableModels(source?: CredentialSource, signal?: AbortSignal): Promise<any>;
  retrieveQuotaSummary(source?: CredentialSource, signal?: AbortSignal): Promise<any>;
  streamGenerateContent(params: {
    source: CredentialSource;
    body: unknown;
    endpoint?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<AntigravityStreamResult>;
  postJson<T>(
    source: CredentialSource,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<T>;
}

/**
 * Creates a reusable Antigravity protocol client with configurable endpoint, User-Agent, and fetch implementation.
 */
export function createAntigravityClient(options?: {
  endpoint?: string;
  userAgent?: string;
  fetch?: typeof fetch;
}): AntigravityClient {
  const endpoint = options?.endpoint || DEFAULT_ENDPOINT;
  const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
  const fetchImpl = options?.fetch || fetch;

  return {
    endpoint,
    userAgent,

    async fetchAvailableModels(source?: CredentialSource, signal?: AbortSignal): Promise<any> {
      const creds = await requireCredentials(source);
      return postAntigravityJson<any>({
        auth: creds.token,
        endpoint,
        userAgent,
        path: "v1internal:fetchAvailableModels",
        body: { project: creds.projectId },
        signal,
        fetchImpl,
      });
    },

    async retrieveQuotaSummary(source?: CredentialSource, signal?: AbortSignal): Promise<any> {
      const creds = await resolveCredentials(source);
      if (!creds) return undefined;
      return postAntigravityJson<any>({
        auth: creds.token,
        endpoint,
        userAgent,
        path: "v1internal:retrieveUserQuotaSummary",
        body: { project: creds.projectId },
        signal,
        fetchImpl,
      });
    },

    async streamGenerateContent({
      source,
      body,
      endpoint: overrideEndpoint,
      headers,
      signal,
    }): Promise<AntigravityStreamResult> {
      const creds = await requireCredentials(source);
      return postAntigravityStream({
        auth: creds.token,
        endpoint: overrideEndpoint || endpoint,
        userAgent,
        path: "v1internal:streamGenerateContent?alt=sse",
        headers,
        body,
        signal,
        fetchImpl,
      });
    },

    async postJson<T>(
      source: CredentialSource,
      path: string,
      body: unknown = {},
      signal?: AbortSignal,
      headers?: Record<string, string>,
    ): Promise<T> {
      const creds = await requireCredentials(source);
      const mergedBody =
        body && typeof body === "object" && !Array.isArray(body)
          ? { project: creds.projectId, ...(body as Record<string, unknown>) }
          : body;
      return postAntigravityJson<T>({
        auth: creds.token,
        endpoint,
        userAgent,
        path,
        headers,
        body: mergedBody,
        signal,
        fetchImpl,
      });
    },
  };
}

export const defaultAntigravityClient = createAntigravityClient();
