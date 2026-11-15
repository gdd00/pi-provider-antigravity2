import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AnyModel,
  Model,
  RefreshModelsContext,
  ThinkingLevel,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import {
  type CredentialSource,
  type OAuthCredentialLike,
  resolveOrRefreshCredentialSource,
} from "./auth.ts";
import { defaultConfigFile, getAgentDir } from "./config.ts";
import { PROVIDER_API } from "./constants.ts";
import { getModelProfile } from "./model-identity.ts";
import {
  type AntigravityClient,
  createAntigravityClient,
  DEFAULT_ENDPOINT,
  defaultAntigravityClient,
  PROVIDER_ID,
} from "./protocol.ts";

export const PRIVATE_SNAPSHOT_KEY = "pi-provider-antigravity";

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

type StoreEntry = NonNullable<RefreshModelsContext["stored"]>;

export type RefreshContext = Omit<RefreshModelsContext, "stored" | "publish"> & {
  stored?: Readonly<StoreEntry> & { [PRIVATE_SNAPSHOT_KEY]?: PersistedSnapshot };
  publish?(publication: {
    persist?: (StoreEntry & { [PRIVATE_SNAPSHOT_KEY]?: PersistedSnapshot }) | null;
    update?: () => void;
  }): Promise<boolean>;
};

export interface CatalogRefreshOutcome {
  status: "fresh" | "stale" | "failed";
  catalog?: AvailableModelsCatalog;
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
}

export interface CatalogThinking {
  budget?: number;
  level?: number;
}

export interface CatalogSnapshot {
  enums: Record<string, string>;
  runtimeIds: string[];
  thinking: Record<string, CatalogThinking>;
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

export interface BootstrapCatalogOptions {
  agentDir?: string;
  client?: AntigravityClient;
  offline?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface BootstrapCatalogResult {
  models: Array<AnyModel>;
  fromStore: boolean;
}

export interface ModelCatalog {
  generation(): CatalogGeneration;
  record(catalogOrRaw: unknown): void;
  restore(persistedOrSnapshot: unknown): void;
  toPersisted(): PersistedSnapshot | undefined;
  refresh(context: RefreshContext): Promise<Array<AnyModel>>;
  bootstrapFromDiskOrAuth(options?: BootstrapCatalogOptions): Promise<BootstrapCatalogResult>;
  refreshGeneration(doRefresh: () => unknown): Promise<CatalogRefreshOutcome>;
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

function snapshotFromCatalog(catalog: AvailableModelsCatalog): CatalogSnapshot {
  return {
    enums: { ...catalog.modelEnums },
    runtimeIds: [...new Set(catalog.models.map((m) => m.id))],
    thinking: buildThinkingMap(catalog.models),
  };
}

function copySnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
  return {
    enums: { ...snapshot.enums },
    runtimeIds: [...snapshot.runtimeIds],
    thinking: Object.fromEntries(
      Object.entries(snapshot.thinking).map(([id, info]) => [id, { ...info }]),
    ),
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

  return {
    models,
    modelEnums,
    ...(agentModelSorts.length > 0 ? { agentModelSorts } : {}),
  };
}

function toPersistedSnapshot(snapshot: CatalogSnapshot): PersistedSnapshot {
  return {
    modelEnums: { ...snapshot.enums },
    runtimeIds: [...snapshot.runtimeIds],
    thinking: { ...snapshot.thinking },
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
  if (!enums && !runtimeIds && !thinking) return undefined;
  return { enums: enums ?? {}, runtimeIds: runtimeIds ?? [], thinking: thinking ?? {} };
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

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;

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

function resolveAuthEntryToSource(entry: unknown): CredentialSource {
  if (!entry) return undefined;
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  if (record.type === "api_key" && typeof record.key === "string") {
    return { apiKey: record.key };
  }
  return { credential: entry as OAuthCredentialLike };
}

/**
 * Creates a stateful ModelCatalog managing catalog refresh, snapshot persistence,
 * cold-start bootstrap, plan resolution, and CLI formatting.
 */
export function createModelCatalog(deps?: {
  client?: AntigravityClient;
  fetchImpl?: typeof fetch;
}): ModelCatalog {
  const client =
    deps?.client ??
    (deps?.fetchImpl ? createAntigravityClient({ fetch: deps.fetchImpl }) : defaultAntigravityClient);
  const defaultFetchImpl = deps?.fetchImpl;
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
    if (generation.version === 0 && generation.snapshot.runtimeIds.length === 0) {
      return undefined;
    }
    return toPersistedSnapshot(generation.snapshot);
  };

  const buildPersistPayload = (models: Array<AnyModel>) => ({
    models,
    checkedAt: Date.now(),
    [PRIVATE_SNAPSHOT_KEY]: toPersisted(),
  });

  const refresh = async (context: RefreshContext): Promise<Array<AnyModel>> => {
    const persisted = context.stored?.[PRIVATE_SNAPSHOT_KEY];
    if (persisted) restore(persisted);

    const storedModels = (): Array<AnyModel> => [...(context.stored?.models ?? [])];
    if (!context.allowNetwork) {
      const existingStored = storedModels();
      if (existingStored.length > 0) {
        return existingStored;
      }
      if (generation.items) {
        const bootstrappedModels = buildDynamicPublicModels(generation.items);
        if (bootstrappedModels.length > 0 && context.publish) {
          try {
            await context.publish({ persist: buildPersistPayload(bootstrappedModels) });
          } catch {
            // Persistence during offline startup refresh is best-effort.
          }
        }
        return bootstrappedModels;
      }
      return existingStored;
    }

    try {
      const resolvedCreds = await resolveOrRefreshCredentialSource(
        context as CredentialSource,
        {
          signal: context.signal,
          fetchImpl: defaultFetchImpl,
        },
      );
      const fetchSource: CredentialSource = resolvedCreds
        ? {
            apiKey: JSON.stringify({
              token: resolvedCreds.token,
              projectId: resolvedCreds.projectId,
            }),
          }
        : (context as CredentialSource);

      const json = await client.fetchAvailableModels(fetchSource, context.signal);
      const catalog = parseAvailableModels(json);
      record(catalog);

      const dynamicModels = buildDynamicPublicModels(catalog);

      if (context.publish) {
        await context.publish({ persist: buildPersistPayload(dynamicModels) });
      }

      return dynamicModels;
    } catch {
      return storedModels();
    }
  };

  const bootstrapFromDiskOrAuth = async (
    options?: BootstrapCatalogOptions,
  ): Promise<BootstrapCatalogResult> => {
    const agentDir = options?.agentDir || getAgentDir();
    const storeJson = readJsonFileSafe(path.join(agentDir, "models-store.json"));
    const storeEntry = storeJson?.[PROVIDER_ID];
    const storeModels = Array.isArray(storeEntry?.models) ? storeEntry.models : undefined;
    const rawSnapshot = storeEntry?.[PRIVATE_SNAPSHOT_KEY];
    const parsedSnapshot = fromPersistedSnapshot(rawSnapshot);

    if (storeModels && storeModels.length > 0 && hasUsableSnapshot(parsedSnapshot)) {
      restore(rawSnapshot);
      return { models: [...storeModels], fromStore: true };
    }

    if (options?.offline || options?.signal?.aborted) {
      return { models: [], fromStore: false };
    }

    const authJson = readJsonFileSafe(path.join(agentDir, "auth.json"));
    const authSource = resolveAuthEntryToSource(authJson?.[PROVIDER_ID]);
    if (!authSource) {
      return { models: [], fromStore: false };
    }

    const timeoutMs = options?.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
    const controller = new AbortController();
    const onExternalAbort = () => {
      controller.abort(options?.signal?.reason ?? new Error("Bootstrap aborted"));
    };
    if (options?.signal) {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            controller.abort(new Error("Antigravity bootstrap timed out"));
          }, timeoutMs)
        : undefined;
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }

    try {
      const resolvedCreds = await resolveOrRefreshCredentialSource(authSource, {
        signal: controller.signal,
        fetchImpl: options?.fetchImpl ?? defaultFetchImpl,
        clientOptions: { configFile: defaultConfigFile(process.env, agentDir) },
      });
      if (!resolvedCreds) {
        return { models: [], fromStore: false };
      }

      const effectiveClient =
        options?.client ??
        (options?.fetchImpl ? createAntigravityClient({ fetch: options.fetchImpl }) : client);
      const packedSource: CredentialSource = {
        apiKey: JSON.stringify({
          token: resolvedCreds.token,
          projectId: resolvedCreds.projectId,
        }),
      };

      const json = await effectiveClient.fetchAvailableModels(packedSource, controller.signal);
      const catalog = parseAvailableModels(json);
      record(catalog);
      return { models: buildDynamicPublicModels(catalog), fromStore: false };
    } catch {
      return { models: [], fromStore: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onExternalAbort);
    }
  };

  const refreshGeneration = async (
    doRefresh: () => unknown,
  ): Promise<CatalogRefreshOutcome> => {
    const versionBefore = generation.version;
    await doRefresh();
    const { items, version } = generation;
    if (!items) return { status: "failed" };
    return { status: version === versionBefore ? "stale" : "fresh", catalog: items };
  };

  return {
    generation: () => ({ ...generation, snapshot: copySnapshot(generation.snapshot) }),
    record,
    restore,
    toPersisted,
    refresh,
    bootstrapFromDiskOrAuth,
    refreshGeneration,
    resolvePlan: (publicModelId, effort) =>
      resolveModelPlan(publicModelId, effort, generation.snapshot),
    formatList: () =>
      generation.items ? formatModelsList(generation.items) : "No models available.",
  };
}

/**
 * Bootstraps an Antigravity ModelCatalog from disk (`models-store.json`) or `auth.json`.
 */
export async function bootstrapCatalogFromDiskOrAuth(
  options?: BootstrapCatalogOptions & { catalog?: ModelCatalog },
): Promise<BootstrapCatalogResult & { catalog: ModelCatalog }> {
  const catalog =
    options?.catalog ??
    createModelCatalog({ client: options?.client, fetchImpl: options?.fetchImpl });
  const result = await catalog.bootstrapFromDiskOrAuth(options);
  return { ...result, catalog };
}
