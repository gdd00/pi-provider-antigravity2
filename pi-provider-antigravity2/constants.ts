export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";
export const PROVIDER_API = "antigravity-api";

export const DEFAULT_HOST = "daily-cloudcode-pa.googleapis.com";
export const DEFAULT_ENDPOINT = `https://${DEFAULT_HOST}`;
export const FALLBACK_PROJECT_ID = "aicode-consumers";

export const ANTIGRAVITY_CLI_VERSION = "1.5.7";
export const ANTIGRAVITY_CLI_CL = "1019769835";
export const ANTIGRAVITY_USER_AGENT_TAG = "antigravity";

const OS_TYPE_MAP: Record<string, string> = {
  linux: "linux",
  darwin: "darwin",
  win32: "windows",
};

const ARCH_MAP: Record<string, string> = {
  x64: "amd64",
  arm64: "arm64",
};

/**
 * Builds the canonical Antigravity CLI User-Agent string matching agy 1.5.7 wire captures.
 */
export function buildAntigravityUserAgent(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const osType = OS_TYPE_MAP[platform] ?? (platform || "linux");
  const mappedArch = ARCH_MAP[arch] ?? (arch || "amd64");
  return `antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (aidev_client; os_type=${osType}; arch=${mappedArch}; cl=${ANTIGRAVITY_CLI_CL}; auth_method=consumer)`;
}

export const DEFAULT_USER_AGENT = buildAntigravityUserAgent();
