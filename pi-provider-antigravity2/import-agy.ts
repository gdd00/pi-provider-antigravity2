import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  AntigravityAuthError,
  refreshAntigravityToken,
  resolveAgyImportOAuthClient,
  type OAuthClientOptions,
} from "./auth.ts";
import { defaultConfigFile, writeJsonAtomically } from "./config.ts";
import { PROVIDER_ID } from "./constants.ts";

const runFile = promisify(execFile);
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const KEYRING_ATTRIBUTES = ["service", "gemini", "username", "antigravity"];

async function runLocalCommand(command: string, args: string[], signal: AbortSignal): Promise<string> {
  const { stdout } = await runFile(command, args, {
    signal, timeout: 4000, maxBuffer: MAX_CREDENTIAL_BYTES, encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  return stdout;
}

async function readAgyKeyring(
  signal: AbortSignal,
  run = runLocalCommand,
): Promise<string | undefined> {
  const bus = (args: string[]) => run("busctl", ["--user", "--auto-start=no", "--json=short", "call", ...args], signal);
  try {
    const owner = await bus([
      "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
      "NameHasOwner", "s", "org.freedesktop.secrets",
    ]);
    const [hasOwner] = JSON.parse(owner).data;
    if (hasOwner === false) return undefined;
    if (hasOwner !== true) throw new Error();
  } catch (error) {
    signal.throwIfAborted();
    const { code, stderr } = error as { code?: string; stderr?: string };
    if (code === "ENOENT") throw new AntigravityAuthError("busctl is required to check the Linux Secret Service.");
    if (typeof stderr === "string" &&
        /Failed to (?:connect to bus|connect to user scope bus via local transport|open user bus): (?:No medium found|No such file or directory|Connection refused)\s*$/.test(stderr)) {
      return undefined;
    }
    throw new AntigravityAuthError("Could not check the Linux Secret Service. Check the current user D-Bus session.");
  }

  try {
    const matches = await bus([
      "org.freedesktop.secrets", "/org/freedesktop/secrets", "org.freedesktop.Secret.Service",
      "SearchItems", "a{ss}", "2", ...KEYRING_ATTRIBUTES,
    ]);
    const [unlocked, locked] = JSON.parse(matches).data;
    if (!Array.isArray(unlocked) || !Array.isArray(locked)) throw new Error();
    if (unlocked.length + locked.length === 0) return undefined;
    if (unlocked.length + locked.length > 1) {
      throw new AntigravityAuthError("Multiple agy keyring entries found; no account was selected.");
    }
    if (locked.length) throw new AntigravityAuthError("The agy keyring entry is locked. Unlock it and retry.");
    return await run("secret-tool", ["lookup", ...KEYRING_ATTRIBUTES], signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AntigravityAuthError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AntigravityAuthError("secret-tool (libsecret) is required to read the agy keyring entry.");
    }
    throw new AntigravityAuthError("Could not read the agy keyring entry.");
  }
}

async function readAgyFallback(home: string): Promise<string | undefined> {
  const file = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  try {
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error();
      }
      const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead > MAX_CREDENTIAL_BYTES) throw new Error();
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AntigravityAuthError("Could not read the agy fallback file. It must be a private regular file owned by the current user.");
  }
}

function parseAgyRefreshToken(raw: string): string {
  let value: { auth_method?: unknown; token?: { refresh_token?: unknown } } | null;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AntigravityAuthError("Unrecognized agy credential format.");
  }
  if (value?.auth_method !== "consumer") {
    throw new AntigravityAuthError("Import supports only agy personal Google OAuth logins.");
  }
  const token = value.token?.refresh_token;
  if (typeof token !== "string" || !token.trim()) {
    throw new AntigravityAuthError("The agy login has no Refresh Token. Sign in to agy again.");
  }
  return token;
}

function authData(file: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Do not treat a dangling auth.json symlink as an empty store.
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) return {};
    }
    throw new AntigravityAuthError("Could not read Pi auth.json; existing credentials were not changed.");
  }
}

function persistImport(file: string, previous: string | undefined, entry: unknown, signal: AbortSignal): void {
  let lock: string;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    file = fs.lstatSync(file, { throwIfNoEntry: false })
      ? fs.realpathSync(file)
      : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    // Pi's auth store uses proper-lockfile on the resolved path. Hold its lock
    // only for synchronous read/compare/write; never wait on UI or HTTP here.
    lock = `${file}.lock`;
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AntigravityAuthError("Pi auth.json is busy. Retry after the other credential operation finishes.");
    }
    throw new AntigravityAuthError("Could not lock Pi auth.json.");
  }

  try {
    const current = authData(file);
    if (JSON.stringify(current[PROVIDER_ID]) !== previous) {
      throw new AntigravityAuthError("Pi's Antigravity login changed during import. Retry to confirm the new state.");
    }
    signal.throwIfAborted();
    if (!writeJsonAtomically(file, { ...current, [PROVIDER_ID]: entry }, 0o600)) {
      throw new AntigravityAuthError("Could not save the imported login to Pi auth.json.");
    }
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // A cleanup error must not report the completed write as a failed import.
    }
  }
}

interface AgyImportOptions extends Omit<OAuthClientOptions, "clientId" | "clientSecret"> {
  home?: string;
  runLocalCommand?: typeof runLocalCommand;
  confirmReplace: () => Promise<boolean>;
}

/** Import one local consumer OAuth login, without writing to agy or provider config. */
export async function importAgyLogin(
  commandSignal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
  options: AgyImportOptions,
): Promise<"imported" | "cancelled"> {
  if (process.platform !== "linux") throw new AntigravityAuthError("agy login import is currently Linux-only.");
  commandSignal?.throwIfAborted();

  const configFile = options.configFile ?? defaultConfigFile(options.env);
  const file = path.join(path.dirname(configFile), "auth.json");
  const previous = JSON.stringify(authData(file)[PROVIDER_ID]);
  if (previous !== undefined && !await options.confirmReplace()) return "cancelled";
  commandSignal?.throwIfAborted();
  const timeout = AbortSignal.timeout(30_000);
  const signal = commandSignal ? AbortSignal.any([commandSignal, timeout]) : timeout;

  const raw = await readAgyKeyring(signal, options.runLocalCommand) ?? await readAgyFallback(options.home ?? homedir());
  if (raw === undefined) throw new AntigravityAuthError("No local agy login found. Sign in to agy first.");
  const refresh = parseAgyRefreshToken(raw);

  // Never forward token-bearing requests to a redirect target.
  const noRedirect: typeof fetch = (input, init) => fetchImpl(input, { ...init, redirect: "error" });
  const pair = await resolveAgyImportOAuthClient(signal, noRedirect, options);
  let renewed: Awaited<ReturnType<typeof refreshAntigravityToken>>;
  try {
    renewed = await refreshAntigravityToken({ refresh, access: "", expires: 0 }, signal, noRedirect, {
      ...options, configFile, ...pair,
    });
    if (!Number.isFinite(renewed.expires) || renewed.expires <= Date.now()) throw new Error();
  } catch {
    signal.throwIfAborted();
    throw new AntigravityAuthError("Could not refresh the agy login. Check the OAuth client settings or sign in to agy again.");
  }

  // Pin the validated client to this login, so no second file needs changing.
  // Explicit OAuth overrides still take precedence on subsequent refreshes.
  persistImport(file, previous, { ...renewed, type: "oauth", agyOAuthClient: pair }, signal);
  return "imported";
}
