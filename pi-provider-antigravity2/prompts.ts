import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, writeJsonAtomically } from "./config.ts";

export const PROVIDER_PROMPTS_FILE = "pi-provider-antigravity-prompts.json";

const PROMPTS_FILE_NOTE =
  "Each entry has piOriginal (from Pi), extensionBuiltIn (built-in default), and userModified (active at runtime). " +
  "piOriginal and extensionBuiltIn are for reference only; edit userModified to customize. " +
  "File is generated from Pi only when missing; piOriginal is re-checked only when piVersion changes, while file integrity is always checked.";

export interface SystemInstructionRewriteRule {
  pattern: string;
  flags?: string;
  replacement: string;
}

export interface RewriteRuleEntry {
  pattern: string;
  flags?: string;
  piOriginal: string | null;
  extensionBuiltIn: string | null;
  userModified: string | null;
}

export interface PromptEntry<T> {
  description: string;
  piOriginal: T;
  extensionBuiltIn: T;
  userModified: T;
}

export interface SystemInstructionRewritesSection {
  description: string;
  defaultFlags: string;
  rules: RewriteRuleEntry[];
}

export interface PromptsCollection {
  preamble: PromptEntry<string>;
  systemInstructionRewrites: SystemInstructionRewritesSection;
  searchSystemInstruction: PromptEntry<string | null>;
  webSearchToolDescription: PromptEntry<string | null>;
  webSearchToolSnippet: PromptEntry<string | null>;
  webSearchToolGuidelines: PromptEntry<string[] | null>;
}

export interface PromptsFileConfig {
  version: number;
  piVersion?: string;
  updatedAt: string;
  note: string;
  prompts: PromptsCollection;
}

export interface BuiltInPromptsBundle {
  descriptions: {
    preamble: string;
    systemInstructionRewrites: string;
    searchSystemInstruction: string;
    webSearchToolDescription: string;
    webSearchToolSnippet: string;
    webSearchToolGuidelines: string;
  };
  defaultRewriteFlags: string;
  systemInstructionRewrites: SystemInstructionRewriteRule[];
  searchSystemInstruction: string;
  webSearchTool: {
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
  };
}

const DEFAULT_PROMPTS_PATH = fileURLToPath(new URL("./default-prompts.json", import.meta.url));
const warnedInvalidPatterns = new Set<string>();
const warnedParseErrors = new Set<string>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, idx) => deepEqual(item, b[idx]));
  }
  if (Array.isArray(b)) return false;
  if (typeof a === "object") {
    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;
    const keysA = Object.keys(recA);
    const keysB = Object.keys(recB);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(recB, key) && deepEqual(recA[key], recB[key]));
  }
  return false;
}

function normalizeRewriteRules(raw: unknown): SystemInstructionRewriteRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: SystemInstructionRewriteRule[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.pattern !== "string" || typeof entry.replacement !== "string") continue;
    rules.push({
      pattern: entry.pattern,
      ...(typeof entry.flags === "string" ? { flags: entry.flags } : {}),
      replacement: entry.replacement,
    });
  }
  return rules;
}

function normalizeRewriteRuleEntries(raw: unknown): RewriteRuleEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RewriteRuleEntry[] = [];
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.pattern !== "string") continue;
    const piOriginal =
      item.piOriginal === null || typeof item.piOriginal === "string" ? item.piOriginal : null;
    const extensionBuiltIn =
      item.extensionBuiltIn === null || typeof item.extensionBuiltIn === "string"
        ? item.extensionBuiltIn
        : null;
    const userModified =
      item.userModified === null || typeof item.userModified === "string"
        ? item.userModified
        : extensionBuiltIn;
    entries.push({
      pattern: item.pattern,
      ...(typeof item.flags === "string" ? { flags: item.flags } : {}),
      piOriginal,
      extensionBuiltIn,
      userModified,
    });
  }
  return entries;
}

function normalizeGuidelines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function normalizeStringField(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    return raw.join("\n");
  }
  return undefined;
}

function isValidRewriteRuleEntryShape(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.pattern !== "string") return false;
  if (entry.flags !== undefined && typeof entry.flags !== "string") return false;
  if (entry.piOriginal !== null && typeof entry.piOriginal !== "string") return false;
  if (entry.extensionBuiltIn !== null && typeof entry.extensionBuiltIn !== "string") return false;
  if (entry.userModified !== null && typeof entry.userModified !== "string") return false;
  return true;
}

function isValidStringPromptEntry(
  entry: unknown,
  allowNullPiOriginal: boolean,
): boolean {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.description !== "string") return false;
  if (allowNullPiOriginal) {
    if (entry.piOriginal !== null && normalizeStringField(entry.piOriginal) === undefined) {
      return false;
    }
  } else if (normalizeStringField(entry.piOriginal) === undefined) {
    return false;
  }
  return (
    normalizeStringField(entry.extensionBuiltIn) !== undefined &&
    normalizeStringField(entry.userModified) !== undefined
  );
}

function isValidStringArrayPromptEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.description !== "string") return false;
  if (
    entry.piOriginal !== null &&
    (!Array.isArray(entry.piOriginal) || !entry.piOriginal.every((x) => typeof x === "string"))
  ) {
    return false;
  }
  return (
    Array.isArray(entry.extensionBuiltIn) &&
    entry.extensionBuiltIn.every((x) => typeof x === "string") &&
    Array.isArray(entry.userModified) &&
    entry.userModified.every((x) => typeof x === "string")
  );
}

function hasValidPromptsFileShape(raw: Record<string, unknown>): boolean {
  if (
    typeof raw.version !== "number" ||
    typeof raw.updatedAt !== "string" ||
    typeof raw.note !== "string" ||
    !isPlainObject(raw.prompts)
  ) {
    return false;
  }

  const p = raw.prompts;
  if (!isValidStringPromptEntry(p.preamble, false)) return false;

  if (
    !isPlainObject(p.systemInstructionRewrites) ||
    typeof p.systemInstructionRewrites.description !== "string" ||
    typeof p.systemInstructionRewrites.defaultFlags !== "string" ||
    !Array.isArray(p.systemInstructionRewrites.rules) ||
    !p.systemInstructionRewrites.rules.every(isValidRewriteRuleEntryShape)
  ) {
    return false;
  }

  if (!isValidStringPromptEntry(p.searchSystemInstruction, true)) return false;
  if (!isValidStringPromptEntry(p.webSearchToolDescription, true)) return false;
  if (!isValidStringPromptEntry(p.webSearchToolSnippet, true)) return false;
  if (!isValidStringArrayPromptEntry(p.webSearchToolGuidelines)) return false;

  return true;
}

function resolvePiVersionFromEnv(): string | undefined {
  const pkgDir = process.env.PI_PACKAGE_DIR?.trim();
  if (pkgDir) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
      if (typeof pkg?.version === "string" && pkg.version.trim()) {
        return pkg.version.trim();
      }
    } catch {
      // Ignore unreadable PI_PACKAGE_DIR.
    }
  }
  return undefined;
}

/**
 * Extracts only the opening preamble of Pi's system prompt (the part modified by this extension)
 * while leaving `<tools>`, `<rules>`, `<docs>`, `<skills>`, and `<cwd>` in `rest`.
 */
export function extractPromptPreamble(fullPrompt: string): { preamble: string; rest: string } {
  if (!fullPrompt) return { preamble: "", rest: "" };
  const sectionMatch = /\n\n<[a-z][a-z0-9_-]*>\n/.exec(fullPrompt);
  if (sectionMatch) {
    return {
      preamble: fullPrompt.slice(0, sectionMatch.index),
      rest: fullPrompt.slice(sectionMatch.index),
    };
  }
  const sepIdx = fullPrompt.indexOf("\n\n");
  if (sepIdx !== -1) {
    return {
      preamble: fullPrompt.slice(0, sepIdx),
      rest: fullPrompt.slice(sepIdx),
    };
  }
  return { preamble: fullPrompt, rest: "" };
}

/**
 * Loads the extension's built-in prompt defaults from `default-prompts.json`.
 */
export function loadDefaultPromptsBundle(
  bundlePath: string = DEFAULT_PROMPTS_PATH,
): BuiltInPromptsBundle {
  const raw = JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as Record<string, unknown>;
  const descRaw = isPlainObject(raw.descriptions) ? raw.descriptions : {};
  const toolRaw = isPlainObject(raw.webSearchTool) ? raw.webSearchTool : {};
  return {
    descriptions: {
      preamble: typeof descRaw.preamble === "string" ? descRaw.preamble : "",
      systemInstructionRewrites:
        typeof descRaw.systemInstructionRewrites === "string"
          ? descRaw.systemInstructionRewrites
          : "",
      searchSystemInstruction:
        typeof descRaw.searchSystemInstruction === "string"
          ? descRaw.searchSystemInstruction
          : "",
      webSearchToolDescription:
        typeof descRaw.webSearchToolDescription === "string"
          ? descRaw.webSearchToolDescription
          : "",
      webSearchToolSnippet:
        typeof descRaw.webSearchToolSnippet === "string" ? descRaw.webSearchToolSnippet : "",
      webSearchToolGuidelines:
        typeof descRaw.webSearchToolGuidelines === "string"
          ? descRaw.webSearchToolGuidelines
          : "",
    },
    defaultRewriteFlags:
      typeof raw.defaultRewriteFlags === "string" && raw.defaultRewriteFlags.trim()
        ? raw.defaultRewriteFlags.trim()
        : "gi",
    systemInstructionRewrites: normalizeRewriteRules(raw.systemInstructionRewrites),
    searchSystemInstruction:
      typeof raw.searchSystemInstruction === "string" ? raw.searchSystemInstruction : "",
    webSearchTool: {
      description: typeof toolRaw.description === "string" ? toolRaw.description : "",
      promptSnippet: typeof toolRaw.promptSnippet === "string" ? toolRaw.promptSnippet : "",
      promptGuidelines: normalizeGuidelines(toolRaw.promptGuidelines),
    },
  };
}

/**
 * Resolves the prompts JSON file path inside Pi's agent directory
 * (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).
 */
export function defaultPromptsFile(
  env: NodeJS.ProcessEnv = process.env,
  agentDirOverride?: string,
): string {
  return path.join(getAgentDir(env, agentDirOverride), PROVIDER_PROMPTS_FILE);
}

function entriesToActiveRules(entries: readonly RewriteRuleEntry[]): SystemInstructionRewriteRule[] {
  const rules: SystemInstructionRewriteRule[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.pattern !== "string" || typeof entry.userModified !== "string") {
      continue;
    }
    rules.push({
      pattern: entry.pattern,
      ...(typeof entry.flags === "string" ? { flags: entry.flags } : {}),
      replacement: entry.userModified,
    });
  }
  return rules;
}

/**
 * Applies regex rewrite rules to a system prompt string without throwing on malformed patterns.
 */
export function applySystemInstructionRewrites(
  text: string,
  rules: readonly SystemInstructionRewriteRule[],
  defaultFlags = "gi",
): string {
  let adapted = text;
  const fallbackFlags = defaultFlags || "gi";
  for (const rule of rules) {
    if (!rule || typeof rule.pattern !== "string" || typeof rule.replacement !== "string") {
      continue;
    }
    const flags = rule.flags ?? fallbackFlags;
    try {
      const regex = new RegExp(rule.pattern, flags);
      adapted = adapted.replace(regex, rule.replacement);
    } catch (err) {
      const key = `${rule.pattern}::${flags}`;
      if (!warnedInvalidPatterns.has(key)) {
        warnedInvalidPatterns.add(key);
        console.warn(
          `[pi-provider-antigravity2] Ignoring invalid systemInstructionRewrites regex /${rule.pattern}/${flags}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return adapted;
}

function builtInRulesToEntries(
  rules: readonly SystemInstructionRewriteRule[],
): RewriteRuleEntry[] {
  return rules.map((r) => ({
    pattern: r.pattern,
    ...(typeof r.flags === "string" ? { flags: r.flags } : {}),
    piOriginal: null,
    extensionBuiltIn: r.replacement,
    userModified: r.replacement,
  }));
}

function buildPromptsCollection(
  piPreamble: string,
  builtIn: BuiltInPromptsBundle,
): PromptsCollection {
  const builtInPreamble = applySystemInstructionRewrites(
    piPreamble,
    builtIn.systemInstructionRewrites,
    builtIn.defaultRewriteFlags,
  );
  return {
    preamble: {
      description: builtIn.descriptions.preamble,
      piOriginal: piPreamble,
      extensionBuiltIn: builtInPreamble,
      userModified: builtInPreamble,
    },
    systemInstructionRewrites: {
      description: builtIn.descriptions.systemInstructionRewrites,
      defaultFlags: builtIn.defaultRewriteFlags,
      rules: builtInRulesToEntries(builtIn.systemInstructionRewrites),
    },
    searchSystemInstruction: {
      description: builtIn.descriptions.searchSystemInstruction,
      piOriginal: null,
      extensionBuiltIn: builtIn.searchSystemInstruction,
      userModified: builtIn.searchSystemInstruction,
    },
    webSearchToolDescription: {
      description: builtIn.descriptions.webSearchToolDescription,
      piOriginal: null,
      extensionBuiltIn: builtIn.webSearchTool.description,
      userModified: builtIn.webSearchTool.description,
    },
    webSearchToolSnippet: {
      description: builtIn.descriptions.webSearchToolSnippet,
      piOriginal: null,
      extensionBuiltIn: builtIn.webSearchTool.promptSnippet,
      userModified: builtIn.webSearchTool.promptSnippet,
    },
    webSearchToolGuidelines: {
      description: builtIn.descriptions.webSearchToolGuidelines,
      piOriginal: null,
      extensionBuiltIn: [...builtIn.webSearchTool.promptGuidelines],
      userModified: [...builtIn.webSearchTool.promptGuidelines],
    },
  };
}

/**
 * Builds a complete initial `PromptsFileConfig` from `default-prompts.json` and an optional session prompt.
 */
export function buildInitialPromptsConfig(
  sessionSystemPromptText = "",
  nowIso: string = new Date().toISOString(),
  piVersion?: string,
): PromptsFileConfig {
  const builtIn = loadDefaultPromptsBundle();
  const { preamble } = extractPromptPreamble(sessionSystemPromptText);

  return {
    version: 1,
    ...(piVersion ? { piVersion } : {}),
    updatedAt: nowIso,
    note: PROMPTS_FILE_NOTE,
    prompts: buildPromptsCollection(preamble, builtIn),
  };
}

function normalizePromptsConfigObject(raw: Record<string, unknown>): PromptsFileConfig {
  const builtIn = loadDefaultPromptsBundle();
  const rawPrompts = isPlainObject(raw.prompts) ? raw.prompts : undefined;

  const rawPreamble = isPlainObject(rawPrompts?.preamble) ? rawPrompts.preamble : undefined;
  const rawRewrites = isPlainObject(rawPrompts?.systemInstructionRewrites)
    ? rawPrompts.systemInstructionRewrites
    : undefined;
  const rawSearch = isPlainObject(rawPrompts?.searchSystemInstruction)
    ? rawPrompts.searchSystemInstruction
    : undefined;
  const rawToolDesc = isPlainObject(rawPrompts?.webSearchToolDescription)
    ? rawPrompts.webSearchToolDescription
    : undefined;
  const rawToolSnippet = isPlainObject(rawPrompts?.webSearchToolSnippet)
    ? rawPrompts.webSearchToolSnippet
    : undefined;
  const rawToolGuidelines = isPlainObject(rawPrompts?.webSearchToolGuidelines)
    ? rawPrompts.webSearchToolGuidelines
    : undefined;

  // Legacy nested webSearchTool fallback for transparent migration.
  const rawLegacyTool = isPlainObject(rawPrompts?.webSearchTool)
    ? rawPrompts.webSearchTool
    : undefined;
  const rawLegacyToolExt = isPlainObject(rawLegacyTool?.extensionBuiltIn)
    ? rawLegacyTool.extensionBuiltIn
    : undefined;
  const rawLegacyToolUser = isPlainObject(rawLegacyTool?.userModified)
    ? rawLegacyTool.userModified
    : undefined;

  const defaultFlags =
    typeof rawRewrites?.defaultFlags === "string" && rawRewrites.defaultFlags.trim()
      ? rawRewrites.defaultFlags.trim()
      : builtIn.defaultRewriteFlags;

  const rewriteEntries = Array.isArray(rawRewrites?.rules)
    ? normalizeRewriteRuleEntries(rawRewrites.rules)
    : builtInRulesToEntries(builtIn.systemInstructionRewrites);

  const piPreamble = normalizeStringField(rawPreamble?.piOriginal) ?? "";
  const extPreamble =
    normalizeStringField(rawPreamble?.extensionBuiltIn) ??
    applySystemInstructionRewrites(
      piPreamble,
      builtIn.systemInstructionRewrites,
      builtIn.defaultRewriteFlags,
    );
  const userPreamble = normalizeStringField(rawPreamble?.userModified) ?? extPreamble;

  const piSearch =
    rawSearch?.piOriginal === null ? null : (normalizeStringField(rawSearch?.piOriginal) ?? null);
  const extSearch =
    normalizeStringField(rawSearch?.extensionBuiltIn) ?? builtIn.searchSystemInstruction;
  const userSearch = normalizeStringField(rawSearch?.userModified) ?? extSearch;

  const piDesc =
    rawToolDesc?.piOriginal === null
      ? null
      : (normalizeStringField(rawToolDesc?.piOriginal) ?? null);
  const extDesc =
    normalizeStringField(rawToolDesc?.extensionBuiltIn ?? rawLegacyToolExt?.description) ??
    builtIn.webSearchTool.description;
  const userDesc =
    normalizeStringField(rawToolDesc?.userModified ?? rawLegacyToolUser?.description) ?? extDesc;

  const piSnippet =
    rawToolSnippet?.piOriginal === null
      ? null
      : (normalizeStringField(rawToolSnippet?.piOriginal) ?? null);
  const extSnippet =
    normalizeStringField(rawToolSnippet?.extensionBuiltIn ?? rawLegacyToolExt?.promptSnippet) ??
    builtIn.webSearchTool.promptSnippet;
  const userSnippet =
    normalizeStringField(rawToolSnippet?.userModified ?? rawLegacyToolUser?.promptSnippet) ??
    extSnippet;

  const piGuidelines = Array.isArray(rawToolGuidelines?.piOriginal)
    ? normalizeGuidelines(rawToolGuidelines.piOriginal)
    : null;
  const extGuidelines = Array.isArray(
    rawToolGuidelines?.extensionBuiltIn ?? rawLegacyToolExt?.promptGuidelines,
  )
    ? normalizeGuidelines(rawToolGuidelines?.extensionBuiltIn ?? rawLegacyToolExt?.promptGuidelines)
    : [...builtIn.webSearchTool.promptGuidelines];
  const userGuidelines = Array.isArray(
    rawToolGuidelines?.userModified ?? rawLegacyToolUser?.promptGuidelines,
  )
    ? normalizeGuidelines(rawToolGuidelines?.userModified ?? rawLegacyToolUser?.promptGuidelines)
    : [...extGuidelines];

  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    ...(typeof raw.piVersion === "string" && raw.piVersion.trim()
      ? { piVersion: raw.piVersion.trim() }
      : {}),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    note: typeof raw.note === "string" ? raw.note : PROMPTS_FILE_NOTE,
    prompts: {
      preamble: {
        description:
          typeof rawPreamble?.description === "string"
            ? rawPreamble.description
            : builtIn.descriptions.preamble,
        piOriginal: piPreamble,
        extensionBuiltIn: extPreamble,
        userModified: userPreamble,
      },
      systemInstructionRewrites: {
        description:
          typeof rawRewrites?.description === "string"
            ? rawRewrites.description
            : builtIn.descriptions.systemInstructionRewrites,
        defaultFlags,
        rules: rewriteEntries,
      },
      searchSystemInstruction: {
        description:
          typeof rawSearch?.description === "string"
            ? rawSearch.description
            : builtIn.descriptions.searchSystemInstruction,
        piOriginal: piSearch,
        extensionBuiltIn: extSearch,
        userModified: userSearch,
      },
      webSearchToolDescription: {
        description:
          typeof rawToolDesc?.description === "string"
            ? rawToolDesc.description
            : builtIn.descriptions.webSearchToolDescription,
        piOriginal: piDesc,
        extensionBuiltIn: extDesc,
        userModified: userDesc,
      },
      webSearchToolSnippet: {
        description:
          typeof rawToolSnippet?.description === "string"
            ? rawToolSnippet.description
            : builtIn.descriptions.webSearchToolSnippet,
        piOriginal: piSnippet,
        extensionBuiltIn: extSnippet,
        userModified: userSnippet,
      },
      webSearchToolGuidelines: {
        description:
          typeof rawToolGuidelines?.description === "string"
            ? rawToolGuidelines.description
            : builtIn.descriptions.webSearchToolGuidelines,
        piOriginal: piGuidelines,
        extensionBuiltIn: extGuidelines,
        userModified: userGuidelines,
      },
    },
  };
}

/**
 * Loads and parses the prompts JSON file, returning `undefined` when absent or invalid.
 */
export function loadPromptsFile(file: string = defaultPromptsFile()): PromptsFileConfig | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isPlainObject(raw)) return undefined;
    return normalizePromptsConfigObject(raw);
  } catch {
    return undefined;
  }
}

/**
 * Resolves a normalized `PromptsFileConfig` from an explicit config object, a file path,
 * or the default prompts file, falling back to built-in defaults when absent.
 */
export function resolveEffectivePromptsConfig(
  fileOrConfig?: string | PromptsFileConfig,
): PromptsFileConfig {
  if (fileOrConfig && typeof fileOrConfig === "object") {
    return normalizePromptsConfigObject(fileOrConfig as unknown as Record<string, unknown>);
  }
  const file = typeof fileOrConfig === "string" ? fileOrConfig : defaultPromptsFile();
  return loadPromptsFile(file) ?? buildInitialPromptsConfig();
}

export interface SyncPromptsFileOptions {
  file?: string;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  sessionSystemPrompt?: string | (() => string | undefined);
  piVersion?: string;
  nowIso?: string;
}

export type SyncPromptsReason =
  | "created"
  | "version-unchanged"
  | "file-repaired"
  | "pi-original-updated"
  | "version-recorded"
  | "skipped-empty-prompt"
  | "parse-error";

export interface SyncPromptsFileResult {
  config: PromptsFileConfig;
  file: string;
  written: boolean;
  parseError: boolean;
  reason: SyncPromptsReason;
}

function resolveIncomingPrompt(
  input: string | (() => string | undefined) | undefined,
): string {
  const raw = typeof input === "function" ? input() : input;
  return typeof raw === "string" ? raw : "";
}

function syncStringEntry(
  rawEntry: unknown,
  nextExtValue: string,
  description: string,
  piOriginalValue: string | null,
): PromptEntry<string | null> {
  const entry = isPlainObject(rawEntry) ? rawEntry : undefined;
  const prevExt = normalizeStringField(entry?.extensionBuiltIn);
  const prevUser =
    entry?.userModified === undefined ? undefined : normalizeStringField(entry.userModified);
  const customized =
    prevUser !== undefined && (prevExt === undefined || prevUser !== prevExt);
  return {
    description,
    piOriginal: piOriginalValue,
    extensionBuiltIn: nextExtValue,
    userModified: customized ? prevUser : nextExtValue,
  };
}

function syncStringArrayEntry(
  rawEntry: unknown,
  nextExtValue: string[],
  description: string,
): PromptEntry<string[] | null> {
  const entry = isPlainObject(rawEntry) ? rawEntry : undefined;
  const prevExt = Array.isArray(entry?.extensionBuiltIn)
    ? normalizeGuidelines(entry.extensionBuiltIn)
    : undefined;
  const prevUser = Array.isArray(entry?.userModified)
    ? normalizeGuidelines(entry.userModified)
    : undefined;
  const customized =
    prevUser !== undefined && (prevExt === undefined || !deepEqual(prevUser, prevExt));
  return {
    description,
    piOriginal: null,
    extensionBuiltIn: [...nextExtValue],
    userModified: customized ? prevUser : [...nextExtValue],
  };
}

function buildUpdatedCollection(
  rawExisting: Record<string, unknown>,
  targetPiPreamble: string,
  builtIn: BuiltInPromptsBundle,
): PromptsCollection {
  const normalizedExisting = normalizePromptsConfigObject(rawExisting);
  const rawPrompts = isPlainObject(rawExisting.prompts) ? rawExisting.prompts : undefined;

  const rawPreamble = isPlainObject(rawPrompts?.preamble) ? rawPrompts.preamble : undefined;
  const rawRewrites = isPlainObject(rawPrompts?.systemInstructionRewrites)
    ? rawPrompts.systemInstructionRewrites
    : undefined;

  // 1. systemInstructionRewrites (pattern outside, piOriginal/extensionBuiltIn/userModified inside)
  const nextDefaultFlags =
    typeof rawRewrites?.defaultFlags === "string" && rawRewrites.defaultFlags.trim()
      ? rawRewrites.defaultFlags.trim()
      : builtIn.defaultRewriteFlags;

  const builtInByPattern = new Map(
    builtIn.systemInstructionRewrites.map((r) => [r.pattern, r] as const),
  );

  let nextRewriteEntries: RewriteRuleEntry[];
  if (Array.isArray(rawRewrites?.rules)) {
    const synced: RewriteRuleEntry[] = [];
    for (const rawRule of rawRewrites.rules) {
      if (!isPlainObject(rawRule) || typeof rawRule.pattern !== "string") continue;
      const match = builtInByPattern.get(rawRule.pattern);
      const nextExt = match ? match.replacement : null;
      const prevExt =
        rawRule.extensionBuiltIn === null || typeof rawRule.extensionBuiltIn === "string"
          ? rawRule.extensionBuiltIn
          : undefined;
      const hasUserVal =
        rawRule.userModified === null || typeof rawRule.userModified === "string";
      const prevUser = hasUserVal ? (rawRule.userModified as string | null) : undefined;
      const customized =
        prevUser !== undefined && (prevExt === undefined || prevUser !== prevExt);

      synced.push({
        pattern: rawRule.pattern,
        ...(typeof rawRule.flags === "string" ? { flags: rawRule.flags } : {}),
        piOriginal: null,
        extensionBuiltIn: nextExt,
        userModified: customized ? prevUser : nextExt,
      });
    }
    nextRewriteEntries = synced;
  } else {
    nextRewriteEntries = builtInRulesToEntries(builtIn.systemInstructionRewrites);
  }

  // 2. preamble
  const prevPiPreamble = normalizedExisting.prompts.preamble.piOriginal;
  const nextExtPreamble = applySystemInstructionRewrites(
    targetPiPreamble,
    builtIn.systemInstructionRewrites,
    builtIn.defaultRewriteFlags,
  );
  const prevExtPreamble = normalizeStringField(rawPreamble?.extensionBuiltIn) ?? "";
  const prevUserPreamble = normalizeStringField(rawPreamble?.userModified);
  const prevUserRewrittenPrevPi = applySystemInstructionRewrites(
    prevPiPreamble,
    entriesToActiveRules(normalizedExisting.prompts.systemInstructionRewrites.rules),
    normalizedExisting.prompts.systemInstructionRewrites.defaultFlags,
  );
  const userPreambleCustomized =
    prevUserPreamble !== undefined &&
    prevUserPreamble.length > 0 &&
    prevUserPreamble !== prevExtPreamble &&
    prevUserPreamble !== prevUserRewrittenPrevPi;
  const nextUserPreamble = userPreambleCustomized
    ? prevUserPreamble
    : applySystemInstructionRewrites(
        targetPiPreamble,
        entriesToActiveRules(nextRewriteEntries),
        nextDefaultFlags,
      );

  return {
    preamble: {
      description: builtIn.descriptions.preamble,
      piOriginal: targetPiPreamble,
      extensionBuiltIn: nextExtPreamble,
      userModified: nextUserPreamble,
    },
    systemInstructionRewrites: {
      description: builtIn.descriptions.systemInstructionRewrites,
      defaultFlags: nextDefaultFlags,
      rules: nextRewriteEntries,
    },
    searchSystemInstruction: syncStringEntry(
      rawPrompts?.searchSystemInstruction,
      builtIn.searchSystemInstruction,
      builtIn.descriptions.searchSystemInstruction,
      null,
    ),
    webSearchToolDescription: syncStringEntry(
      rawPrompts?.webSearchToolDescription,
      builtIn.webSearchTool.description,
      builtIn.descriptions.webSearchToolDescription,
      null,
    ),
    webSearchToolSnippet: syncStringEntry(
      rawPrompts?.webSearchToolSnippet,
      builtIn.webSearchTool.promptSnippet,
      builtIn.descriptions.webSearchToolSnippet,
      null,
    ),
    webSearchToolGuidelines: syncStringArrayEntry(
      rawPrompts?.webSearchToolGuidelines,
      builtIn.webSearchTool.promptGuidelines,
      builtIn.descriptions.webSearchToolGuidelines,
    ),
  };
}

/**
 * Manages `pi-provider-antigravity-prompts.json` lifecycle:
 * 1. Only creates the file from Pi when the file does not exist yet.
 * 2. When the file exists and `piVersion` is unchanged:
 *    - Skips extracting Pi's prompt (does NOT overwrite `piOriginal`).
 *    - Still validates file structure, `extensionBuiltIn`, and `userModified` placeholders,
 *      repairing missing/broken fields without touching user customizations.
 * 3. When the file exists and `piVersion` changed (or `piVersion` was absent):
 *    - Extracts Pi's prompt and compares `piOriginal`; if different (Pi updated or user
 *      accidentally modified `piOriginal`), updates `piOriginal` and syncs placeholders.
 * 4. Never overwrites a file that has invalid JSON syntax.
 */
export function syncPromptsFile(options?: SyncPromptsFileOptions): SyncPromptsFileResult {
  const file = options?.file ?? defaultPromptsFile(options?.env, options?.agentDir);
  const nowIso = options?.nowIso ?? new Date().toISOString();
  const currentPiVersion = options?.piVersion?.trim() || resolvePiVersionFromEnv();

  let rawExisting: Record<string, unknown> | undefined;
  try {
    const content = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(content);
    if (!isPlainObject(parsed)) {
      const fallbackPrompt = resolveIncomingPrompt(options?.sessionSystemPrompt);
      return {
        config: buildInitialPromptsConfig(fallbackPrompt, nowIso, currentPiVersion),
        file,
        written: false,
        parseError: true,
        reason: "parse-error",
      };
    }
    rawExisting = parsed;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      if (!warnedParseErrors.has(file)) {
        warnedParseErrors.add(file);
        console.warn(
          `[pi-provider-antigravity2] Failed to read/parse ${file}; keeping existing file untouched and using defaults.`,
        );
      }
      const fallbackPrompt = resolveIncomingPrompt(options?.sessionSystemPrompt);
      return {
        config: buildInitialPromptsConfig(fallbackPrompt, nowIso, currentPiVersion),
        file,
        written: false,
        parseError: true,
        reason: "parse-error",
      };
    }
  }

  // Case 1: File does not exist yet -> extract from Pi and generate file.
  if (!rawExisting) {
    const incomingPrompt = resolveIncomingPrompt(options?.sessionSystemPrompt);
    const initial = buildInitialPromptsConfig(incomingPrompt, nowIso, currentPiVersion);
    const written = writeJsonAtomically(file, initial);
    return {
      config: initial,
      file,
      written,
      parseError: false,
      reason: "created",
    };
  }

  const builtIn = loadDefaultPromptsBundle();
  const existingConfig = normalizePromptsConfigObject(rawExisting);
  const storedPiVersion =
    typeof rawExisting.piVersion === "string" && rawExisting.piVersion.trim()
      ? rawExisting.piVersion.trim()
      : undefined;

  // Case 2: File exists and Pi version has NOT changed ->
  // skip extracting Pi's prompt, but STILL validate & repair file structure / extensionBuiltIn / placeholders.
  if (currentPiVersion && storedPiVersion === currentPiVersion) {
    const keptPiPreamble = existingConfig.prompts.preamble.piOriginal;
    const nextPrompts = buildUpdatedCollection(rawExisting, keptPiPreamble, builtIn);
    const needsRepair =
      !hasValidPromptsFileShape(rawExisting) || !deepEqual(existingConfig.prompts, nextPrompts);

    if (!needsRepair) {
      return {
        config: existingConfig,
        file,
        written: false,
        parseError: false,
        reason: "version-unchanged",
      };
    }

    const repairedConfig: PromptsFileConfig = {
      version: typeof rawExisting.version === "number" ? rawExisting.version : 1,
      piVersion: currentPiVersion,
      updatedAt: nowIso,
      note: PROMPTS_FILE_NOTE,
      prompts: nextPrompts,
    };
    const written = writeJsonAtomically(file, repairedConfig);
    return {
      config: repairedConfig,
      file,
      written,
      parseError: false,
      reason: "file-repaired",
    };
  }

  // Case 3: Pi version changed (or piVersion was absent) -> extract Pi's prompt to detect piOriginal drift.
  const incomingPrompt = resolveIncomingPrompt(options?.sessionSystemPrompt);
  if (!incomingPrompt) {
    const keptPiPreamble = existingConfig.prompts.preamble.piOriginal;
    const nextPrompts = buildUpdatedCollection(rawExisting, keptPiPreamble, builtIn);
    const needsRepair =
      !hasValidPromptsFileShape(rawExisting) || !deepEqual(existingConfig.prompts, nextPrompts);

    if (needsRepair) {
      const repairedConfig: PromptsFileConfig = {
        version: typeof rawExisting.version === "number" ? rawExisting.version : 1,
        ...(storedPiVersion ? { piVersion: storedPiVersion } : {}),
        updatedAt: nowIso,
        note: PROMPTS_FILE_NOTE,
        prompts: nextPrompts,
      };
      const written = writeJsonAtomically(file, repairedConfig);
      return {
        config: repairedConfig,
        file,
        written,
        parseError: false,
        reason: "file-repaired",
      };
    }

    return {
      config: existingConfig,
      file,
      written: false,
      parseError: false,
      reason: "skipped-empty-prompt",
    };
  }

  const { preamble: incomingPreamble } = extractPromptPreamble(incomingPrompt);
  const piOriginalChanged =
    existingConfig.prompts.preamble.piOriginal !== incomingPreamble ||
    existingConfig.prompts.systemInstructionRewrites.rules.some((r) => r.piOriginal !== null) ||
    existingConfig.prompts.searchSystemInstruction.piOriginal !== null ||
    existingConfig.prompts.webSearchToolDescription.piOriginal !== null ||
    existingConfig.prompts.webSearchToolSnippet.piOriginal !== null ||
    existingConfig.prompts.webSearchToolGuidelines.piOriginal !== null;

  const targetPiPreamble = piOriginalChanged
    ? incomingPreamble
    : existingConfig.prompts.preamble.piOriginal;
  const nextPrompts = buildUpdatedCollection(rawExisting, targetPiPreamble, builtIn);

  if (!piOriginalChanged) {
    const needsRepair =
      !hasValidPromptsFileShape(rawExisting) || !deepEqual(existingConfig.prompts, nextPrompts);

    if (needsRepair || (currentPiVersion && storedPiVersion !== currentPiVersion)) {
      const nextConfig: PromptsFileConfig = {
        version: typeof rawExisting.version === "number" ? rawExisting.version : 1,
        ...(currentPiVersion ? { piVersion: currentPiVersion } : {}),
        updatedAt: nowIso,
        note: PROMPTS_FILE_NOTE,
        prompts: nextPrompts,
      };
      const written = writeJsonAtomically(file, nextConfig);
      return {
        config: nextConfig,
        file,
        written,
        parseError: false,
        reason: needsRepair ? "file-repaired" : "version-recorded",
      };
    }

    return {
      config: existingConfig,
      file,
      written: false,
      parseError: false,
      reason: "version-unchanged",
    };
  }

  const nextConfig: PromptsFileConfig = {
    version: 1,
    ...(currentPiVersion ? { piVersion: currentPiVersion } : {}),
    updatedAt: nowIso,
    note: PROMPTS_FILE_NOTE,
    prompts: nextPrompts,
  };

  const written = writeJsonAtomically(file, nextConfig);
  return {
    config: nextConfig,
    file,
    written,
    parseError: false,
    reason: "pi-original-updated",
  };
}

/**
 * Resolves the effective outbound `systemInstruction` text using `userModified`.
 * When `userModified` preamble was manually customized, replaces only the matching
 * Pi preamble while keeping live sections (`<tools>`, `<rules>`, `<cwd>`, etc.) intact.
 */
export function resolveOutboundSystemPrompt(
  incomingSystemPrompt: string,
  fileOrConfig?: string | PromptsFileConfig,
): string {
  const cfg = resolveEffectivePromptsConfig(fileOrConfig);
  const defaultFlags = cfg.prompts.systemInstructionRewrites.defaultFlags;
  const userRewrites = entriesToActiveRules(cfg.prompts.systemInstructionRewrites.rules);
  const piOriginalPreamble = cfg.prompts.preamble.piOriginal;
  const extBuiltInPreamble = cfg.prompts.preamble.extensionBuiltIn;
  const userModifiedPreamble = cfg.prompts.preamble.userModified;

  const isPreambleCustomized =
    userModifiedPreamble.length > 0 &&
    userModifiedPreamble !== extBuiltInPreamble &&
    userModifiedPreamble !==
      applySystemInstructionRewrites(piOriginalPreamble, userRewrites, defaultFlags);

  if (isPreambleCustomized && piOriginalPreamble.length > 0) {
    const { preamble, rest } = extractPromptPreamble(incomingSystemPrompt);
    if (preamble === piOriginalPreamble) {
      return (
        userModifiedPreamble + applySystemInstructionRewrites(rest, userRewrites, defaultFlags)
      );
    }
  }

  return applySystemInstructionRewrites(incomingSystemPrompt, userRewrites, defaultFlags);
}

/**
 * Resolves the active `searchSystemInstruction` from `userModified`.
 */
export function resolveSearchSystemInstruction(fileOrConfig?: string | PromptsFileConfig): string {
  const cfg = resolveEffectivePromptsConfig(fileOrConfig);
  return (
    cfg.prompts.searchSystemInstruction.userModified ??
    cfg.prompts.searchSystemInstruction.extensionBuiltIn ??
    ""
  );
}

export interface PromptSyncExtensionLike {
  on?: (event: string, handler: (event: any, ctx: any) => any) => void;
}

/**
 * Checks existing prompts file on startup (when present) and binds `session_start` /
 * `before_agent_start` hooks:
 * - Only creates the file from Pi when missing.
 * - When `piVersion` is unchanged, skips extracting Pi's prompt while still running file checks.
 * - When `piVersion` changes, extracts Pi's prompt and updates `piOriginal` if different.
 */
export function initializePromptSync(
  pi: PromptSyncExtensionLike,
  options?: { file?: string; env?: NodeJS.ProcessEnv; agentDir?: string; piVersion?: string },
): string {
  const file = options?.file ?? defaultPromptsFile(options?.env, options?.agentDir);
  const piVersion = options?.piVersion;

  if (fs.existsSync(file)) {
    syncPromptsFile({ file, piVersion });
  }

  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      syncPromptsFile({
        file,
        piVersion,
        sessionSystemPrompt: () =>
          typeof ctx?.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined,
      });
    });

    pi.on("before_agent_start", (event, ctx) => {
      syncPromptsFile({
        file,
        piVersion,
        sessionSystemPrompt: () =>
          typeof event?.systemPrompt === "string" && event.systemPrompt.length > 0
            ? event.systemPrompt
            : typeof ctx?.getSystemPrompt === "function"
              ? ctx.getSystemPrompt()
              : undefined,
      });
    });
  }

  return file;
}

/**
 * Resolves the active `antigravity_websearch` tool prompt metadata from `userModified`.
 */
export function resolveWebSearchToolPrompts(fileOrConfig?: string | PromptsFileConfig): {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
} {
  const cfg = resolveEffectivePromptsConfig(fileOrConfig);
  return {
    description:
      cfg.prompts.webSearchToolDescription.userModified ??
      cfg.prompts.webSearchToolDescription.extensionBuiltIn ??
      "",
    promptSnippet:
      cfg.prompts.webSearchToolSnippet.userModified ??
      cfg.prompts.webSearchToolSnippet.extensionBuiltIn ??
      "",
    promptGuidelines: Array.isArray(cfg.prompts.webSearchToolGuidelines.userModified)
      ? [...cfg.prompts.webSearchToolGuidelines.userModified]
      : Array.isArray(cfg.prompts.webSearchToolGuidelines.extensionBuiltIn)
        ? [...cfg.prompts.webSearchToolGuidelines.extensionBuiltIn]
        : [],
  };
}
