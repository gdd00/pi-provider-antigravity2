import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { detectAgyLoginClientId, extractAgyBuild } from "./agy.ts";
import {
  defaultConfigFile,
  loadProviderConfig,
  resolveAntigravityUserAgent,
  updateProviderConfig,
} from "./config.ts";
import {
  buildAntigravityUserAgent,
  DEFAULT_ENDPOINT,
  DEFAULT_USER_AGENT,
  FALLBACK_PROJECT_ID,
  PROVIDER_ID,
} from "./constants.ts";

export { DEFAULT_ENDPOINT, DEFAULT_USER_AGENT, FALLBACK_PROJECT_ID, PROVIDER_ID };

export interface AntigravityCredentials {
  token: string;
  projectId: string;
}

export interface OAuthCredentialLike {
  access?: string;
  refresh?: string;
  expires?: number;
  type?: string;
}

export type CredentialSource =
  | { modelRegistry?: { getApiKeyForProvider?: (provider: string) => Promise<string | undefined> } }
  | { apiKey?: string }
  | { credential?: OAuthCredentialLike }
  | string
  | null
  | undefined;

export const NOT_LOGGED_IN = "Not logged in. Run /login antigravity first.";

/**
 * Structured error thrown when an operation requires Antigravity credentials
 * but none are configured or resolvable from the context.
 */
export class AntigravityAuthError extends Error {
  constructor(message = NOT_LOGGED_IN) {
    super(message);
    this.name = "AntigravityAuthError";
  }
}

export const REDIRECT_URI = "https://antigravity.google/oauth-callback";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
];

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OAuthClientOptions {
  clientId?: string;
  clientSecret?: string;
  env?: NodeJS.ProcessEnv;
  configFile?: string;
  agyPaths?: string[];
}

function resolveOAuthConfigFile(options?: OAuthClientOptions): string {
  return options?.configFile ?? defaultConfigFile(options?.env);
}

export const MISSING_OAUTH_CLIENT_MSG =
  "Missing Antigravity OAuth client credentials. Set ANTIGRAVITY_CLIENT_ID and " +
  "ANTIGRAVITY_CLIENT_SECRET (or configure oauthClientId and oauthClientSecret in " +
  "~/.pi/agent/pi-provider-antigravity.json). See README for how to obtain them from your local agy CLI.";

/**
 * Resolves Antigravity OAuth client credentials from explicit options, environment variables
 * (`ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET`), or `pi-provider-antigravity.json`
 * (`oauthClientId` / `oauthClientSecret`). Throws `AntigravityAuthError` if incomplete.
 */
export function resolveOAuthClientCredentials(
  options?: OAuthClientOptions,
): OAuthClientCredentials {
  const env = options?.env ?? process.env;
  const fileConfig =
    options?.clientId && options?.clientSecret
      ? undefined
      : loadProviderConfig(resolveOAuthConfigFile(options));

  const clientId =
    options?.clientId?.trim() ||
    env.ANTIGRAVITY_CLIENT_ID?.trim() ||
    (typeof fileConfig?.oauthClientId === "string" ? fileConfig.oauthClientId.trim() : "");

  const clientSecret =
    options?.clientSecret?.trim() ||
    env.ANTIGRAVITY_CLIENT_SECRET?.trim() ||
    (typeof fileConfig?.oauthClientSecret === "string"
      ? fileConfig.oauthClientSecret.trim()
      : "");

  if (!clientId || !clientSecret) {
    throw new AntigravityAuthError(MISSING_OAUTH_CLIENT_MSG);
  }

  return { clientId, clientSecret };
}

const GOOGLE_CLIENT_ID_RE = /[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/g;
const GOOGLE_CLIENT_SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{28}/g;

/**
 * Extracts a Google OAuth `client_id` from either a raw client ID string or a full OAuth URL.
 */
export function extractClientIdFromInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new AntigravityAuthError("No OAuth client_id provided.");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const fromUrl = parsed.searchParams.get("client_id")?.trim();
      if (fromUrl) return fromUrl;
    } catch {
      // Fall through to regex extraction.
    }
  }
  const matched = trimmed.match(GOOGLE_CLIENT_ID_RE)?.[0];
  if (matched) return matched;
  if (/\s/.test(trimmed)) {
    throw new AntigravityAuthError("Invalid client_id: paste the client_id value or full OAuth login URL.");
  }
  return trimmed;
}

/**
 * Extracts unique 35-character `GOCSPX-...` OAuth client secret candidates from binary bytes.
 */
export function extractClientSecretCandidates(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return [...new Set(text.match(GOOGLE_CLIENT_SECRET_RE) ?? [])];
}

function resolveDefaultAgyCandidatePaths(env: NodeJS.ProcessEnv): string[] {
  const exeName = process.platform === "win32" ? "agy.exe" : "agy";
  const candidates: string[] = [];
  const pathEnv = env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (path.isAbsolute(trimmed)) candidates.push(path.join(trimmed, exeName));
  }
  if (process.platform !== "win32") {
    candidates.push(
      "/usr/bin/agy",
      "/usr/local/bin/agy",
      "/opt/homebrew/bin/agy",
      path.join(os.homedir(), ".local", "bin", "agy"),
    );
  }
  return [...new Set(candidates)];
}

async function readFirstExistingAgyBinary(
  paths: string[],
  signal?: AbortSignal,
): Promise<{ file: string; bytes: Buffer } | undefined> {
  for (const candidate of paths) {
    signal?.throwIfAborted();
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.isFile() && stat.size > 0) {
        return { file: candidate, bytes: await fs.promises.readFile(candidate, { signal }) };
      }
    } catch {
      signal?.throwIfAborted();
      // Ignore missing or unreadable candidate paths.
    }
  }
  return undefined;
}

function readLocalAgy(options: OAuthClientOptions | undefined, signal?: AbortSignal) {
  const env = options?.env ?? process.env;
  return readFirstExistingAgyBinary(options?.agyPaths ?? resolveDefaultAgyCandidatePaths(env), signal);
}

function userAgentFromAgy(binary: Buffer): string | undefined {
  const build = extractAgyBuild(binary);
  return build ? buildAntigravityUserAgent(process.platform, process.arch, build) : undefined;
}

async function matchClientSecretFromAgy(
  clientId: string,
  binary: Buffer | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!binary) return null;
  const timeout = AbortSignal.timeout(5_000);
  const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const candidates = extractClientSecretCandidates(binary);
  for (const secret of candidates) {
    signal?.throwIfAborted();
    if (timeout.aborted) break;
    try {
      const res = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: secret,
          code: "probe",
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
        }).toString(),
        signal: probeSignal,
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (payload.error === "invalid_grant") {
        return secret;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  return null;
}

export interface AntigravityClientSyncResult {
  oauth: "updated" | "unchanged" | "login-required" | "overridden" | "unavailable";
  userAgent: "updated" | "unchanged" | "unavailable";
}

function hasStoredOAuthLogin(configFile: string): boolean {
  const checkFailed = "Cannot read auth.json to check the current login.";
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(path.dirname(configFile), "auth.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AntigravityAuthError(checkFailed);
  }
  try {
    const auth = JSON.parse(raw);
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error();
    const entry = auth[PROVIDER_ID] as OAuthCredentialLike | undefined;
    return entry?.type === "oauth" || (!entry?.type && !!(entry?.refresh || entry?.access));
  } catch {
    throw new AntigravityAuthError(checkFailed);
  }
}

/** Sync local agy settings without opening a browser or touching account tokens. */
export async function syncAntigravityClient(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  options?: Pick<OAuthClientOptions, "env" | "configFile" | "agyPaths">,
): Promise<AntigravityClientSyncResult> {
  signal?.throwIfAborted();
  const env = options?.env ?? process.env;
  const configFile = resolveOAuthConfigFile(options);
  const agy = await readLocalAgy(options, signal);
  if (!agy) throw new AntigravityAuthError("No readable local agy binary found.");

  const userAgent = userAgentFromAgy(agy.bytes);
  const overridden = !!(env.ANTIGRAVITY_CLIENT_ID?.trim() || env.ANTIGRAVITY_CLIENT_SECRET?.trim());
  const clientId = overridden ? undefined : await detectAgyLoginClientId(agy.file, REDIRECT_URI, signal);
  const clientSecret = clientId ? await matchClientSecretFromAgy(clientId, agy.bytes, fetchImpl, signal) : null;

  signal?.throwIfAborted();
  const config = loadProviderConfig(configFile);
  const savedClientId = typeof config?.oauthClientId === "string" ? config.oauthClientId.trim() : undefined;
  let oauth: AntigravityClientSyncResult["oauth"] = overridden ? "overridden" : "unavailable";
  if (clientId && clientSecret) {
    if (clientId !== savedClientId && hasStoredOAuthLogin(configFile)) {
      oauth = "login-required";
    } else {
      oauth = clientId === config?.oauthClientId && clientSecret === config?.oauthClientSecret
        ? "unchanged" : "updated";
    }
  }

  const uaStatus = !userAgent ? "unavailable" : userAgent === config?.userAgent ? "unchanged" : "updated";
  if (oauth === "updated" || uaStatus === "updated") {
    const wrote = updateProviderConfig(configFile, (cfg) => {
      if (oauth === "updated" && clientId && clientSecret) {
        cfg.oauthClientId = clientId;
        cfg.oauthClientSecret = clientSecret;
      }
      if (uaStatus === "updated") cfg.userAgent = userAgent;
    });
    if (!wrote) throw new AntigravityAuthError("Could not save pi-provider-antigravity.json.");
  }
  return { oauth, userAgent: uaStatus };
}

async function resolveOrSetupOAuthClientForLogin(
  callbacks: OAuthLoginCallbacks,
  fetchImpl: typeof fetch,
  clientOptions?: OAuthClientOptions,
): Promise<OAuthClientCredentials & { configFile: string; save: () => void }> {
  const env = clientOptions?.env ?? process.env;
  const configFile = resolveOAuthConfigFile(clientOptions);
  const fileConfig = loadProviderConfig(configFile);
  const explicitId = clientOptions?.clientId?.trim() || env.ANTIGRAVITY_CLIENT_ID?.trim();
  const explicitSecret = clientOptions?.clientSecret?.trim() || env.ANTIGRAVITY_CLIENT_SECRET?.trim();

  let clientId = explicitId ||
    (typeof fileConfig?.oauthClientId === "string" ? fileConfig.oauthClientId.trim() : "");
  let clientSecret = explicitSecret ||
    (typeof fileConfig?.oauthClientSecret === "string" ? fileConfig.oauthClientSecret.trim() : "");

  const agy = await readLocalAgy(clientOptions, callbacks.signal);
  const userAgent = agy ? userAgentFromAgy(agy.bytes) : undefined;

  const detectedId = agy && !explicitId && (!explicitSecret || !clientId)
    ? await detectAgyLoginClientId(agy.file, REDIRECT_URI, callbacks.signal)
    : undefined;
  let shouldPersist = false;

  const matchSecret = async (id: string) => {
    if (!agy) return null;
    callbacks.onProgress?.("Checking OAuth client_secret from local agy...");
    return matchClientSecretFromAgy(id, agy.bytes, fetchImpl, callbacks.signal);
  };

  const probeId = detectedId || clientId;
  if (probeId && !explicitSecret) {
    const matchedSecret = await matchSecret(probeId);
    if (matchedSecret) {
      clientId = probeId;
      clientSecret = matchedSecret;
      shouldPersist = true;
    }
  }

  // Keep a known pair intact if detection fails; never combine a new ID with a cached Secret.
  if (!clientId || !clientSecret) {
    if (!clientId) {
      clientId = detectedId || extractClientIdFromInput(await callbacks.onPrompt({
        message: "Paste Antigravity OAuth client_id (or full agy login URL):",
      }));
      clientSecret = explicitSecret || "";
    } else if (detectedId && !clientSecret) {
      clientId = detectedId;
    }
    if (!clientSecret) {
      const matchedSecret = clientId !== probeId ? await matchSecret(clientId) : null;
      clientSecret = matchedSecret || (await callbacks.onPrompt({
        message: "Could not auto-detect client_secret from agy. Paste OAuth client_secret (GOCSPX-...):",
      })).trim();
    }
    if (!clientSecret) throw new AntigravityAuthError(MISSING_OAUTH_CLIENT_MSG);
    shouldPersist = true;
  }

  return {
    clientId,
    clientSecret,
    configFile,
    save() {
      const credentialsChanged = shouldPersist &&
        (clientId !== fileConfig?.oauthClientId || clientSecret !== fileConfig?.oauthClientSecret);
      const userAgentChanged = userAgent !== undefined && userAgent !== fileConfig?.userAgent;
      if (!credentialsChanged && !userAgentChanged) return;

      const wrote = updateProviderConfig(configFile, (cfg) => {
        if (credentialsChanged) {
          cfg.oauthClientId = clientId;
          cfg.oauthClientSecret = clientSecret;
        }
        if (userAgentChanged) cfg.userAgent = userAgent;
      });
      if (!wrote) {
        callbacks.onProgress?.(`Could not save Antigravity settings to ${path.basename(configFile)}.`);
        return;
      }
      if (credentialsChanged) {
        callbacks.onProgress?.(`Saved OAuth client credentials to ${path.basename(configFile)}.`);
      }
      if (userAgentChanged) {
        callbacks.onProgress?.(`Saved User-Agent from local agy to ${path.basename(configFile)}.`);
      }
    },
  };
}

/**
 * Strips accidental leading hyphens on Google OAuth refresh tokens (e.g. `-1//...` -> `1//...`)
 * while trimming surrounding whitespace.
 */
export function normalizeRefreshToken(rawToken: string): string {
  const trimmed = rawToken.trim();
  return trimmed.replace(/^-+(1\/\/)/, "$1");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  return { verifier, challenge };
}

/**
 * Validates and extracts an OAuth authorization code from pasted user input.
 */
export function extractCodeFromInput(rawInput: string): string {
  let code = rawInput.trim();
  if (!code) {
    throw new Error("No authorization code provided");
  }

  if (code.startsWith("code=")) {
    code = code.slice(5).trim();
    if (!code) {
      throw new Error("No authorization code provided");
    }
  }

  if (/[\s:?#&=%+]/.test(code)) {
    throw new Error("Invalid authorization code: paste the code value itself, not the callback URL");
  }

  return code;
}

/**
 * Resolves the Cloud Code Assist project ID for the authenticated user,
 * falling back to `FALLBACK_PROJECT_ID` if lookup fails or returns empty.
 */
export async function fetchProjectId(
  token: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  configFile?: string,
): Promise<string> {
  try {
    const res = await fetchImpl(`${DEFAULT_ENDPOINT}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: {
        "User-Agent": resolveAntigravityUserAgent(configFile),
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { cloudaicompanionProject?: string };
      if (data.cloudaicompanionProject) {
        return data.cloudaicompanionProject;
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return FALLBACK_PROJECT_ID;
}

/**
 * Runs interactive PKCE OAuth login for Antigravity and returns stored OAuth credentials.
 */
export async function loginAntigravity(
  callbacks: OAuthLoginCallbacks,
  fetchImpl: typeof fetch = fetch,
  clientOptions?: OAuthClientOptions,
): Promise<OAuthCredentials> {
  const { clientId, clientSecret, configFile, save } = await resolveOrSetupOAuthClientForLogin(
    callbacks,
    fetchImpl,
    clientOptions,
  );
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");

  const authParams = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  callbacks.onAuth({ url: `${AUTH_URL}?${authParams.toString()}` });

  let timer: NodeJS.Timeout | undefined;
  const abortPromise = new Promise<never>((_, rej) => {
    if (callbacks.signal?.aborted) {
      rej(callbacks.signal.reason ?? new Error("Login cancelled"));
      return;
    }
    callbacks.signal?.addEventListener(
      "abort",
      () => rej(callbacks.signal?.reason ?? new Error("Login cancelled")),
      { once: true },
    );
  });

  const manualPromptPromise = (async () => {
    const input = await callbacks.onPrompt({
      message: "Paste authorization code from browser:",
    });
    return extractCodeFromInput(input);
  })();

  const timeoutPromise = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error("Timed out waiting for authorization code (5 minutes)")),
      OAUTH_CALLBACK_TIMEOUT_MS,
    );
  });

  let code: string;
  try {
    code = await Promise.race([manualPromptPromise, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  callbacks.onProgress?.("Exchanging authorization code for tokens...");

  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
    signal: callbacks.signal,
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Failed to exchange token (${tokenRes.status}): ${errText}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  callbacks.signal?.throwIfAborted();
  save();

  callbacks.onProgress?.("Resolving Code Assist project ID...");
  const projectId = await fetchProjectId(tokens.access_token, callbacks.signal, fetchImpl, configFile);

  return {
    refresh: normalizeRefreshToken(tokens.refresh_token || ""),
    access: JSON.stringify({ token: tokens.access_token, projectId }),
    expires: Date.now() + (tokens.expires_in || 3600) * 1000,
  };
}

/**
 * Refreshes an Antigravity OAuth access token, normalizing any malformed refresh token
 * prefix and preserving an existing non-fallback project ID if lookup fails.
 */
export async function refreshAntigravityToken(
  credentials: OAuthCredentials,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  clientOptions?: OAuthClientOptions,
): Promise<OAuthCredentials> {
  const normalizedRefresh = normalizeRefreshToken(credentials.refresh || "");
  if (!normalizedRefresh) {
    throw new AntigravityAuthError("Missing OAuth refresh token. Run /login antigravity first.");
  }

  const { clientId, clientSecret } = resolveOAuthClientCredentials(clientOptions);

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: normalizedRefresh,
    grant_type: "refresh_token",
  });

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to refresh token (${res.status}): ${errText}`);
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  let existingProjectId = FALLBACK_PROJECT_ID;
  if (credentials.access) {
    const existing = parseStoredCredentials(credentials.access);
    if (existing.projectId) {
      existingProjectId = existing.projectId;
    }
  }

  const freshProjectId = await fetchProjectId(
    tokens.access_token, signal, fetchImpl, resolveOAuthConfigFile(clientOptions),
  );
  const projectId = freshProjectId !== FALLBACK_PROJECT_ID ? freshProjectId : existingProjectId;

  const nextRefresh = tokens.refresh_token
    ? normalizeRefreshToken(tokens.refresh_token)
    : normalizedRefresh;

  return {
    refresh: nextRefresh,
    access: JSON.stringify({ token: tokens.access_token, projectId }),
    expires: Date.now() + (tokens.expires_in || 3600) * 1000,
  };
}

/**
 * Returns the packed API key string (`JSON.stringify({ token, projectId })`) stored in `access`.
 */
export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

/**
 * Parses a stored API key string (packed `{ token, projectId }` JSON or plain bearer token)
 * into `{ token, projectId }`.
 */
export function parseStoredCredentials(rawApiKey: string): AntigravityCredentials {
  try {
    const parsed = JSON.parse(rawApiKey) as {
      token?: unknown;
      access_token?: unknown;
      projectId?: unknown;
    };
    const token =
      typeof parsed?.token === "string"
        ? parsed.token
        : typeof parsed?.access_token === "string"
          ? parsed.access_token
          : undefined;
    if (token) {
      const projectId =
        typeof parsed.projectId === "string" && parsed.projectId.trim()
          ? parsed.projectId.trim()
          : FALLBACK_PROJECT_ID;
      return { token, projectId };
    }
  } catch {
    // Plain bearer token string fallback.
  }
  return { token: rawApiKey.trim(), projectId: FALLBACK_PROJECT_ID };
}

/**
 * Extracts and normalizes `{ token, projectId }` from any supported Pi credential source.
 * Returns null if no usable token is present.
 */
export async function resolveCredentials(
  source: CredentialSource,
): Promise<AntigravityCredentials | null> {
  if (!source) return null;

  let raw: string | undefined;
  if (typeof source === "string") {
    raw = source.trim();
  } else if (typeof source === "object") {
    if ("modelRegistry" in source && source.modelRegistry?.getApiKeyForProvider) {
      raw = await source.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
    } else if ("apiKey" in source && typeof source.apiKey === "string") {
      raw = source.apiKey;
    } else if ("credential" in source && source.credential) {
      raw =
        source.credential.type === "oauth" || !source.credential.type
          ? source.credential.access
          : undefined;
    }
  }

  if (!raw || typeof raw !== "string" || !raw.trim()) {
    return null;
  }

  const parsed = parseStoredCredentials(raw);
  if (!parsed.token || !parsed.token.trim()) {
    return null;
  }
  return parsed;
}

/**
 * Resolves Antigravity credentials from `source` or throws `AntigravityAuthError`.
 */
export async function requireCredentials(
  source: CredentialSource,
  errorMessage = NOT_LOGGED_IN,
): Promise<AntigravityCredentials> {
  const creds = await resolveCredentials(source);
  if (!creds) {
    throw new AntigravityAuthError(errorMessage);
  }
  return creds;
}

const EXPIRY_SAFETY_BUFFER_MS = 60_000;

function isOAuthCredentialExpired(expires: unknown, nowMs: number): boolean {
  return typeof expires === "number" && Number.isFinite(expires) && expires <= nowMs + EXPIRY_SAFETY_BUFFER_MS;
}

/**
 * Resolves credentials from `source`, automatically refreshing an OAuth `{ credential }`
 * via `refreshAntigravityToken` when `access` is empty/missing or expired and `refresh`
 * is present. Does not mutate caller objects or disk storage.
 */
export async function resolveOrRefreshCredentialSource(
  source: CredentialSource,
  options?: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    now?: () => number;
    clientOptions?: OAuthClientOptions;
  },
): Promise<AntigravityCredentials | null> {
  const nowFn = options?.now ?? Date.now;
  const cred =
    source && typeof source === "object" && "credential" in source ? source.credential : undefined;

  if (cred && (cred.type === "oauth" || !cred.type)) {
    const hasRefresh = typeof cred.refresh === "string" && cred.refresh.trim().length > 0;
    const direct = await resolveCredentials(source);
    const expired = isOAuthCredentialExpired(cred.expires, nowFn());

    if (direct && !expired) {
      return direct;
    }

    if (hasRefresh) {
      const refreshed = await refreshAntigravityToken(
        {
          refresh: cred.refresh!,
          access: typeof cred.access === "string" ? cred.access : "",
          expires: typeof cred.expires === "number" ? cred.expires : 0,
        },
        options?.signal,
        options?.fetchImpl,
        options?.clientOptions,
      );
      return parseStoredCredentials(refreshed.access);
    }

    return direct;
  }

  return resolveCredentials(source);
}
