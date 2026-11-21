import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const VERSION_MARKERS = ["CORE\0", "LINUX\0"];
const VERSION_LINE = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\r?\n/;
const CHANGE_MARKER = "changelist ";
const CHANGE_STAMP = /^(\d+) with baseline \d+ in a mint client based on \/\/depot\/google3\x00/;

function findUniqueStamp(
  bytes: Buffer,
  markers: readonly string[],
  pattern: RegExp,
): string | undefined {
  const matches = new Set<string>();
  for (const marker of markers) {
    const prefix = Buffer.from(marker, "ascii");
    for (let offset = bytes.indexOf(prefix); offset !== -1;) {
      const start = offset + prefix.length;
      const candidate = pattern.exec(bytes.toString("latin1", start, start + 128))?.[1];
      if (candidate) matches.add(candidate);
      if (matches.size > 1) return undefined;
      offset = bytes.indexOf(prefix, start);
    }
  }
  return matches.values().next().value;
}

/**
 * Reads the embedded version line and Google build changelist in known agy
 * binaries. Unknown or ambiguous layouts are ignored rather than guessed.
 */
export function extractAgyBuild(bytes: Buffer): { version: string; cl: string } | undefined {
  const cl = findUniqueStamp(bytes, [CHANGE_MARKER], CHANGE_STAMP);
  if (!cl) return undefined;
  const version = findUniqueStamp(bytes, VERSION_MARKERS, VERSION_LINE);
  return version ? { version, cl } : undefined;
}

export function extractAgyLoginClientId(output: string, redirectUri: string): string | undefined {
  const ids = new Set<string>();
  for (const [candidate] of output.matchAll(/https:\/\/accounts\.google\.com\/[^\s\x1b]+/g)) {
    const url = URL.parse(candidate);
    if (
      url?.origin !== "https://accounts.google.com" ||
      !["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(url.pathname) ||
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("redirect_uri") !== redirectUri
    ) continue;
    const values = url.searchParams.getAll("client_id");
    if (values.length !== 1 || !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(values[0])) continue;
    ids.add(values[0]);
  }
  return ids.size === 1 ? ids.values().next().value : undefined;
}

/** Ask the installed Linux CLI to print its login URL, then cancel at EOF. */
export async function detectAgyLoginClientId(
  binaryPath: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (process.platform !== "linux" || !path.isAbsolute(binaryPath)) return undefined;
  let dir: string | undefined;
  try {
    const home = dir = await mkdtemp(path.join(os.tmpdir(), "ag2-agy-login-"));
    signal?.throwIfAborted();
    const output = await new Promise<string>((resolve) => {
      // Keep real account state and browser launchers out of the probe.
      const child = execFile(binaryPath, ["acp", "--login", "--disable-telemetry"], {
        cwd: home,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_STATE_HOME: path.join(home, "state"),
          XDG_RUNTIME_DIR: home,
          TMPDIR: home,
          PATH: path.join(home, "no-browser"),
          TERM: "dumb",
        },
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        signal,
      }, (error, stdout, stderr) => {
        // EOF after the URL can be a normal nonzero exit. Ignore spawn and timeout errors.
        resolve(!error || typeof error.code === "number" ? stdout + "\n" + stderr : "");
      });
      child.stdin?.end();
    });
    signal?.throwIfAborted();
    return extractAgyLoginClientId(output, redirectUri);
  } catch {
    signal?.throwIfAborted();
    return undefined;
  } finally {
    if (dir) await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
}
