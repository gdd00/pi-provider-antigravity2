import * as fs from "node:fs";
import * as path from "node:path";
import type { Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { CredentialSource } from "./auth.ts";
import { getAgentDir, writeJsonAtomically } from "./config.ts";
import { PROVIDER_API } from "./constants.ts";
import { getModelProfile } from "./model-identity.ts";
import {
  type AntigravityClient,
  DEFAULT_ENDPOINT,
  defaultAntigravityClient,
  PROVIDER_ID,
} from "./protocol.ts";

export const PRIVATE_SNAPSHOT_KEY = "pi-provider-antigravity";
export const MODEL_CACHE_FILE = "pi-provider-antigravity-models.json";

/**
 * Tier suffixes matching Pi ThinkingLevel names (low, medium, high, xhigh, max).
 */
const THINKING_LEVELS: readonly ThinkingLevel[] = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const TIER_SUFFIX_PATTERN = new RegExp(`-(?:${THINKING_LEVELS.join("|")})$`);

const CATALOG_LEVEL_NAMES: Record<number, string> = {
  1: "LOW",
  2: "MEDIUM",
  3: "HIGH",
};

/**
 * Strips a trailing tier suffix (e.g. `-low`, `-medium`, `-high`, `-xhigh`, `-max`)
 * from a runtime model ID to obtain its public base model ID.
 */
export function extractBaseModelId(runtimeId: string): string {
  return runtimeId.replace(TIER_SUFFIX_PATTERN, "");
}

export interface AvailableModelItem {
  id: string;
  displayName?: string;
  modelEnum?: string;
  remainingFraction?: number;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: number;
  supportsImages?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
}

export interface AvailableModelsCatalog {
  models: AvailableModelItem[];
  modelEnums: Record<string, string>;
  agentModelSorts?: string[];
  webSearchModelIds?: string[];
}

export interface CatalogThinking {
  budget?: number;
  level?: number;
}

export interface CatalogSnapshot {
  enums: Record<string, string>;
  runtimeIds: string[];
  thinking: Record<string, CatalogThinking>;
  webSearchModelIds?: string[];
}

export interface CatalogGeneration {
  snapshot: CatalogSnapshot;
  items?: AvailableModelsCatalog;
  version: number;
}

export interface PersistedSnapshot {
  modelEnums: Record<string, string>;
  runtimeIds: string[];
  thinking: Record<string, CatalogThinking>;
  webSearchModelIds?: string[];
}

export interface ThinkingConfig {
  includeThoughts: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string | number;
}

export interface ModelPlan {
  runtimeModelId: string;
  modelEnum: string;
  thinkingConfig: ThinkingConfig;
  isNonGemini: boolean;
  isClaude: boolean;
}

export interface ModelCatalog {
  generation(): CatalogGeneration;
  record(catalogOrRaw: unknown): void;
  restore(persistedOrSnapshot: unknown): void;
  toPersisted(): PersistedSnapshot | undefined;
  loadCachedModels(): Array<Model<any>>;
  refresh(source: CredentialSource, signal?: AbortSignal): Promise<Array<Model<any>>>;
  getWebSearchModelId(): string | undefined;
  resolvePlan(publicModelId: string, effort?: string): ModelPlan;
  formatList(): string;
}

/**
 * Builds a lookup table from runtime model ID to catalog thinking budget and level.
 */
export function buildThinkingMap(
  models: AvailableModelItem[],
): Record<string, CatalogThinking> {
  return Object.fromEntries(
    models.map((m) => [
      m.id,
      {
        ...(typeof m.thinkingBudget === "number" ? { budget: m.thinkingBudget } : {}),
        ...(typeof m.thinkingLevel === "number" ? { level: m.thinkingLevel } : {}),
      },
    ]),
  );
}

function parseWebSearchModelIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids.size ? [...ids] : undefined;
}

function snapshotFromCatalog(catalog: AvailableModelsCatalog): CatalogSnapshot {
  const webSearchModelIds = parseWebSearchModelIds(catalog.webSearchModelIds);
  return {
    enums: { ...catalog.modelEnums },
    runtimeIds: [...new Set(catalog.models.map((m) => m.id))],
    thinking: buildThinkingMap(catalog.models),
    ...(webSearchModelIds && { webSearchModelIds }),
  };
}

function copySnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
  const webSearchModelIds = parseWebSearchModelIds(snapshot.webSearchModelIds);
  return {
    enums: { ...snapshot.enums },
    runtimeIds: [...snapshot.runtimeIds],
    thinking: Object.fromEntries(
      Object.entries(snapshot.thinking).map(([id, info]) => [id, { ...info }]),
    ),
    ...(webSearchModelIds && { webSearchModelIds }),
  };
}

const EMPTY_SNAPSHOT = (): CatalogSnapshot => ({ enums: {}, runtimeIds: [], thinking: {} });

/**
 * Parses the raw `v1internal:fetchAvailableModels` JSON response into a structured catalog,
 * filtering out internal completion models and server-disabled entries.
 */
export function parseAvailableModels(data: any): AvailableModelsCatalog {
  if (!data || typeof data !== "object") {
    return { models: [], modelEnums: {} };
  }

  const models: AvailableModelItem[] = [];
  const modelEnums: Record<string, string> = {};

  const modelsObj = data.models || {};
  for (const [id, info] of Object.entries<any>(modelsObj)) {
    if (id.startsWith("tab_") || id.startsWith("chat_")) continue;
    if (info?.disabled === true) continue;

    const modelEnum = typeof info?.model === "string" ? info.model : undefined;
    if (modelEnum) {
      modelEnums[id] = modelEnum;
    }

    const quotaInfo = info?.quotaInfo || {};
    models.push({
      id,
      displayName: info?.displayName || info?.label || id,
      modelEnum,
      remainingFraction:
        typeof quotaInfo.remainingFraction === "number" ? quotaInfo.remainingFraction : undefined,
      supportsThinking: Boolean(info?.supportsThinking),
      thinkingBudget: typeof info?.thinkingBudget === "number" ? info.thinkingBudget : undefined,
      thinkingLevel: typeof info?.thinkingLevel === "number" ? info.thinkingLevel : undefined,
      supportsImages: Boolean(info?.supportsImages),
      maxTokens: typeof info?.maxTokens === "number" ? info.maxTokens : undefined,
      maxOutputTokens:
        typeof info?.maxOutputTokens === "number" ? info.maxOutputTokens : undefined,
    });
  }

  const agentModelSorts: string[] = [];
  if (Array.isArray(data.agentModelSorts)) {
    for (const sortGroup of data.agentModelSorts) {
      if (Array.isArray(sortGroup?.groups)) {
        for (const group of sortGroup.groups) {
          if (Array.isArray(group?.modelIds)) {
            agentModelSorts.push(...group.modelIds);
          }
        }
      }
    }
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  // These are ordered search backend IDs, not necessarily public chat models.
  const webSearchModelIds = parseWebSearchModelIds(data.webSearchModelIds);
  return {
    models,
    modelEnums,
    ...(agentModelSorts.length > 0 ? { agentModelSorts } : {}),
    ...(webSearchModelIds && { webSearchModelIds }),
  };
}

function toPersistedSnapshot(snapshot: CatalogSnapshot): PersistedSnapshot {
  const { webSearchModelIds } = snapshot;
  return {
    modelEnums: { ...snapshot.enums },
    runtimeIds: [...snapshot.runtimeIds],
    thinking: { ...snapshot.thinking },
    ...(webSearchModelIds && { webSearchModelIds: [...webSearchModelIds] }),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isThinkingRecord(value: unknown): value is Record<string, CatalogThinking> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) => !!entry && typeof entry === "object" && !Array.isArray(entry),
    )
  );
}

function fromPersistedSnapshot(raw: unknown): CatalogSnapshot | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Partial<PersistedSnapshot>;
  const enums = isStringRecord(entry.modelEnums) ? entry.modelEnums : undefined;
  const runtimeIds = Array.isArray(entry.runtimeIds)
    ? entry.runtimeIds.filter((id): id is string => typeof id === "string")
    : undefined;
  const thinking = isThinkingRecord(entry.thinking) ? entry.thinking : undefined;
  const webSearchModelIds = parseWebSearchModelIds(entry.webSearchModelIds);
  if (!enums && !runtimeIds && !thinking && !webSearchModelIds) return undefined;
  return {
    enums: enums ?? {},
    runtimeIds: runtimeIds ?? [],
    thinking: thinking ?? {},
    ...(webSearchModelIds && { webSearchModelIds }),
  };
}

function resolveRuntimeModelId(
  modelId: string,
  effort: string | undefined,
  runtimeIds: string[],
): string {
  const desired = effort ?? "high";
  const tiered = `${modelId}-${desired}`;
  if (runtimeIds.includes(tiered)) return tiered;
  if (runtimeIds.includes(modelId)) return modelId;

  const variants = runtimeIds.filter((id) => extractBaseModelId(id) === modelId);
  if (variants.length === 1) return variants[0];
  if (variants.length > 1) {
    const fallbackOrder =
      desired === "off" || desired === "minimal"
        ? ["low", "medium", "high", "xhigh", "max"]
        : ["high", "medium", "xhigh", "max", "low"];
    for (const tier of fallbackOrder) {
      const candidate = `${modelId}-${tier}`;
      if (variants.includes(candidate)) return candidate;
    }
    return variants[0];
  }

  return modelId;
}

/**
 * Resolves the wire `thinkingConfig` for a runtime model ID from the catalog snapshot.
 * Maps ranks 1/2/3 to LOW/MEDIUM/HIGH, preserves positive integer levels above 3
 * (such as xhigh rank 100) numerically for Gemini models, and supports budget-based models.
 */
export function resolveThinkingConfig(
  runtimeModelId: string,
  snapshot: CatalogSnapshot,
): ThinkingConfig {
  const entry = snapshot.thinking[runtimeModelId];
  const profile = getModelProfile(runtimeModelId);
  const level = entry?.level;
  const named = typeof level === "number" ? CATALOG_LEVEL_NAMES[level] : undefined;

  if (named) {
    return { includeThoughts: true, thinkingLevel: named };
  }

  if (profile.isClaude && typeof entry?.budget === "number") {
    return { includeThoughts: true, thinkingBudget: entry.budget };
  }

  if (typeof level === "number" && Number.isInteger(level) && level > 0 && !profile.isClaude) {
    return { includeThoughts: true, thinkingLevel: level };
  }

  if (typeof entry?.budget === "number") {
    return { includeThoughts: true, thinkingBudget: entry.budget };
  }

  return { includeThoughts: false, thinkingBudget: 0 };
}

/**
 * Resolves a public model ID and Pi effort level into a wire ModelPlan from `snapshot`.
 */
export function resolveModelPlan(
  publicModelId: string,
  effort: string | undefined,
  snapshot: CatalogSnapshot,
): ModelPlan {
  const runtimeModelId = resolveRuntimeModelId(publicModelId, effort, snapshot.runtimeIds);
  const modelEnum = snapshot.enums[runtimeModelId];
  if (!modelEnum) {
    throw new Error(
      `Unknown model "${runtimeModelId}". Run /antigravity refresh, then pick a current model.`,
    );
  }
  const profile = getModelProfile(runtimeModelId);
  return {
    runtimeModelId,
    modelEnum,
    thinkingConfig: resolveThinkingConfig(runtimeModelId, snapshot),
    isNonGemini: profile.isNonGemini,
    isClaude: profile.isClaude,
  };
}

function formatModelDisplayName(baseId: string, rawDisplayName?: string): string {
  if (rawDisplayName) {
    const cleaned = rawDisplayName.replace(/\s*\([^)]*\)/g, "").trim();
    if (cleaned.length > 0) return cleaned;
  }
  return baseId
    .split("-")
    .map((w) => (/^\d+(\.\d+)?$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function minAcrossVariants(values: Array<number | undefined>): number | undefined {
  const known = values.filter((n): n is number => typeof n === "number" && n > 0);
  return known.length > 0 ? Math.min(...known) : undefined;
}

/**
 * Synthesizes a Pi Model entry covering all tier variants of `baseId`.
 */
export function synthesizeDynamicModel(
  baseId: string,
  items: AvailableModelItem[],
): Model<any> {
  const repItem = items.find((it) => it.id === `${baseId}-high` || it.id === baseId) || items[0];

  const tiers = new Set(
    items.map((it) => (it.id === baseId ? "high" : it.id.slice(baseId.length + 1))),
  );
  const thinkingLevelMap: ThinkingLevelMap = { off: null, minimal: null };
  for (const level of THINKING_LEVELS) {
    thinkingLevelMap[level] = tiers.has(level) ? level : null;
  }

  const profile = getModelProfile(baseId);
  return {
    id: baseId,
    name: formatModelDisplayName(baseId, repItem?.displayName),
    provider: PROVIDER_ID,
    api: PROVIDER_API,
    baseUrl: DEFAULT_ENDPOINT,
    reasoning: items.some((it) => it.supportsThinking),
    thinkingLevelMap,
    input: items.every((it) => it.supportsImages) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    promptCache: profile.promptCache,
    contextWindow:
      minAcrossVariants(items.map((it) => it.maxTokens)) ?? profile.defaultContextWindow,
    maxTokens:
      minAcrossVariants(items.map((it) => it.maxOutputTokens)) ?? profile.defaultMaxOutputTokens,
  };
}

/**
 * Builds deduplicated public Pi Model definitions ordered by `agentModelSorts`.
 */
export function buildDynamicPublicModels(catalog?: AvailableModelsCatalog): Array<Model<any>> {
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    return [];
  }

  const agentSortIds = catalog.agentModelSorts;
  const eligibleItems =
    Array.isArray(agentSortIds) && agentSortIds.length > 0
      ? catalog.models.filter((m) => agentSortIds.includes(m.id))
      : catalog.models;

  const runtimeGroups = new Map<string, AvailableModelItem[]>();
  for (const item of eligibleItems) {
    const baseId = extractBaseModelId(item.id);
    const list = runtimeGroups.get(baseId) || [];
    list.push(item);
    runtimeGroups.set(baseId, list);
  }

  const orderedBaseIds: string[] = [];
  if (Array.isArray(agentSortIds)) {
    for (const sortId of agentSortIds) {
      const baseId = extractBaseModelId(sortId);
      if (runtimeGroups.has(baseId) && !orderedBaseIds.includes(baseId)) {
        orderedBaseIds.push(baseId);
      }
    }
  }
  for (const baseId of runtimeGroups.keys()) {
    if (!orderedBaseIds.includes(baseId)) {
      orderedBaseIds.push(baseId);
    }
  }

  return orderedBaseIds.map((baseId) => synthesizeDynamicModel(baseId, runtimeGroups.get(baseId)!));
}

function formatTokenCount(n?: number): string {
  if (typeof n !== "number") return "N/A";
  if (n % 1048576 === 0) return `${n / 1048576}M`;
  if (n % 1024 === 0) return `${n / 1024}k`;
  if (n % 1000 === 0) return `${n / 1000}k`;
  return `${Math.round(n / 1024)}k`;
}

/**
 * Formats an `AvailableModelsCatalog` as an aligned CLI summary table.
 */
export function formatModelsList(catalog: AvailableModelsCatalog): string {
  const sorts = catalog.agentModelSorts;
  const recommendedOnly = Array.isArray(sorts) && sorts.length > 0;
  const rank = new Map((sorts || []).map((id, i) => [id, i]));

  const models = (
    recommendedOnly ? catalog.models.filter((m) => rank.has(m.id)) : catalog.models.slice()
  ).sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
  );

  const rows = models.map((m) => {
    const flags: string[] = [];
    if (m.supportsThinking) flags.push("thinking");
    if (m.supportsImages) flags.push("images");
    return {
      id: m.id,
      name: formatModelDisplayName(m.id, m.displayName || m.id),
      ctx: `${formatTokenCount(m.maxTokens)}/${formatTokenCount(m.maxOutputTokens)}`,
      feat: flags.length > 0 ? flags.join(", ") : "-",
      rem:
        typeof m.remainingFraction === "number"
          ? `${Math.round(m.remainingFraction * 100)}%`
          : "N/A",
    };
  });

  const headers = { id: "Model", name: "Name", ctx: "Context", feat: "Features", rem: "Rem" };
  const w = {
    id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
    name: Math.max(headers.name.length, ...rows.map((r) => r.name.length)),
    ctx: Math.max(headers.ctx.length, ...rows.map((r) => r.ctx.length)),
    feat: Math.max(headers.feat.length, ...rows.map((r) => r.feat.length)),
  };

  const lines: string[] = [
    `Available Antigravity Models (${models.length}${recommendedOnly ? " recommended" : ""}):`,
    `  ${headers.id.padEnd(w.id)}  ${headers.name.padEnd(w.name)}  ${headers.ctx.padEnd(w.ctx)}  ${headers.feat.padEnd(w.feat)}  ${headers.rem}`,
  ];
  for (const r of rows) {
    lines.push(
      `  ${r.id.padEnd(w.id)}  ${r.name.padEnd(w.name)}  ${r.ctx.padEnd(w.ctx)}  ${r.feat.padEnd(w.feat)}  ${r.rem.padStart(4)}`,
    );
  }
  return lines.join("\n");
}

function readJsonFileSafe(filePath: string): any | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function hasUsableSnapshot(snapshot?: CatalogSnapshot): snapshot is CatalogSnapshot {
  return Boolean(
    snapshot && (snapshot.runtimeIds.length > 0 || Object.keys(snapshot.enums).length > 0),
  );
}

/**
 * Creates a stateful ModelCatalog managing catalog refresh, snapshot persistence,
 * cold-start bootstrap, plan resolution, and CLI formatting.
 */
export function createModelCatalog(deps?: {
  client?: AntigravityClient;
  agentDir?: string;
}): ModelCatalog {
  const client = deps?.client ?? defaultAntigravityClient;
  const agentDir = deps?.agentDir ?? getAgentDir();
  const cacheFile = path.join(agentDir, MODEL_CACHE_FILE);
  let generation: CatalogGeneration = { snapshot: EMPTY_SNAPSHOT(), version: 0 };

  const record = (catalogOrRaw: unknown) => {
    const catalog =
      catalogOrRaw &&
      typeof catalogOrRaw === "object" &&
      "models" in catalogOrRaw &&
      Array.isArray((catalogOrRaw as AvailableModelsCatalog).models) &&
      "modelEnums" in catalogOrRaw &&
      typeof (catalogOrRaw as AvailableModelsCatalog).modelEnums === "object"
        ? (catalogOrRaw as AvailableModelsCatalog)
        : parseAvailableModels(catalogOrRaw);

    generation = {
      snapshot: snapshotFromCatalog(catalog),
      items: catalog,
      version: generation.version + 1,
    };
  };

  const restore = (persistedOrSnapshot: unknown) => {
    if (generation.version > 0) return;
    if (!persistedOrSnapshot || typeof persistedOrSnapshot !== "object") return;

    if (
      "enums" in persistedOrSnapshot &&
      "runtimeIds" in persistedOrSnapshot &&
      Array.isArray((persistedOrSnapshot as CatalogSnapshot).runtimeIds)
    ) {
      generation = {
        snapshot: copySnapshot(persistedOrSnapshot as CatalogSnapshot),
        version: 0,
      };
      return;
    }

    const snapshot = fromPersistedSnapshot(persistedOrSnapshot);
    if (snapshot) {
      generation = { snapshot: copySnapshot(snapshot), version: 0 };
    }
  };

  const toPersisted = (): PersistedSnapshot | undefined => {
    const { version, snapshot } = generation;
    if (version === 0 && snapshot.runtimeIds.length === 0 && !snapshot.webSearchModelIds) {
      return undefined;
    }
    return toPersistedSnapshot(snapshot);
  };

  const loadCachedModels = (): Array<Model<any>> => {
    const cached = readJsonFileSafe(cacheFile);
    const legacy = () => readJsonFileSafe(path.join(agentDir, "models-store.json"))?.[PROVIDER_ID];
    const usable = (entry: any): boolean =>
      Array.isArray(entry?.models) && entry.models.length > 0 &&
      hasUsableSnapshot(fromPersistedSnapshot(entry[PRIVATE_SNAPSHOT_KEY]));
    const entry = usable(cached) ? cached : legacy();
    if (!usable(entry)) return [];
    restore(entry[PRIVATE_SNAPSHOT_KEY]);
    return entry.models;
  };

  const refresh = async (source: CredentialSource, signal?: AbortSignal): Promise<Array<Model<any>>> => {
    signal?.throwIfAborted();
    const json = await client.fetchAvailableModels(source, signal);
    signal?.throwIfAborted();
    const catalog = parseAvailableModels(json);
    const models = buildDynamicPublicModels(catalog);
    if (models.length === 0) throw new Error("No models were returned.");
    if (!writeJsonAtomically(cacheFile, {
      models,
      [PRIVATE_SNAPSHOT_KEY]: toPersistedSnapshot(snapshotFromCatalog(catalog)),
    }, 0o600)) {
      throw new Error(`Could not save Antigravity model cache: ${cacheFile}`);
    }
    record(catalog);
    return models;
  };

  return {
    generation: () => ({ ...generation, snapshot: copySnapshot(generation.snapshot) }),
    record,
    restore,
    toPersisted,
    loadCachedModels,
    refresh,
    getWebSearchModelId: () => generation.snapshot.webSearchModelIds?.[0],
    resolvePlan: (publicModelId, effort) =>
      resolveModelPlan(publicModelId, effort, generation.snapshot),
    formatList: () =>
      generation.items ? formatModelsList(generation.items) : "No models available.",
  };
}
