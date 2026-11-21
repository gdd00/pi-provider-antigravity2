import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { resolveCredentials } from "./auth.ts";
import {
  ANSI_FG_RESET,
  defaultConfigFile,
  loadProviderConfig,
  loadSubsystemState,
  saveSubsystemState,
} from "./config.ts";
import { getModelProfile, type QuotaPoolKind } from "./model-identity.ts";
import {
  type AntigravityClient,
  defaultAntigravityClient,
  PROVIDER_ID,
} from "./protocol.ts";
import {
  normalizeQuotaFooter,
  QUOTA_FOOTER_NOTES,
  type QuotaFooterMode,
  resolveQuotaFooter,
} from "./settings.ts";

export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window?: string;
  resetTime?: string;
  description?: string;
  remainingFraction: number;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface QuotaSummary {
  groups: QuotaGroup[];
  description?: string;
}

type QuotaWindowKind = "5h" | "weekly" | "other";

const QUOTA_WINDOW_RANK: Record<QuotaWindowKind, number> = {
  "5h": 0,
  weekly: 1,
  other: 2,
};

const DEFAULT_WEEKLY_TO_5H_RATIO = 6.0;
const QUOTA_WARN_PCT = 30;
const QUOTA_ALERT_PCT = 10;
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_DIM = "\x1b[90m";

export const QUOTA_STATUS_KEY = "pi-provider-antigravity-footer-usage";
const QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 60 * 60 * 1000;

interface WindowFractionPair {
  "5h": number;
  weekly: number;
}

type QuotaColorTone = "error" | "warning" | "dim";
type QuotaColorizer = (tone: QuotaColorTone, text: string) => string;
export type QuotaColorStyle =
  | { fg: (tone: QuotaColorTone, text: string) => string }
  | QuotaColorizer;

export interface QuotaState {
  [key: string]: unknown;
}

export interface QuotaStatusStore {
  loadMode: () => QuotaFooterMode;
  loadQuotaState: () => QuotaState | undefined;
  saveQuotaState: (state: {
    weeklyTo5hRatio: number;
    previousObservation: Record<string, WindowFractionPair>;
    updatedAt: number;
  }) => boolean;
}

export interface RefreshOptions {
  force?: boolean;
  ignoreMode?: boolean;
  signal?: AbortSignal;
}

export type QuotaStatusCtx = Pick<ExtensionContext, "ui" | "modelRegistry" | "model">;

export interface QuotaStatusDeps {
  store?: QuotaStatusStore;
  configFile?: string;
  fetchQuotaSummary?: (token: string, signal?: AbortSignal) => Promise<any>;
  client?: AntigravityClient;
  now?: () => number;
}

export interface QuotaStatus {
  bind(pi: ExtensionAPI, allowRefresh?: () => boolean): void;
  formatUsage(ctx: ExtensionCommandContext & { signal?: AbortSignal }): Promise<string>;
  inspectUsage(ctx: QuotaStatusCtx & { signal?: AbortSignal }): Promise<string>;
  mode(): QuotaFooterMode;
  refresh(ctx: QuotaStatusCtx, opts?: RefreshOptions): Promise<QuotaSummary | undefined>;
  paint(ctx: QuotaStatusCtx): void;
  ensurePreview(ctx: QuotaStatusCtx): Promise<QuotaSummary | undefined>;
  previewFooter(
    modelId: string | undefined,
    mode: string,
    style?: QuotaColorStyle,
  ): string | undefined;
}

function classifyQuotaWindow(bucket: QuotaBucket): QuotaWindowKind {
  const w = (bucket.window || "").trim().toLowerCase();
  if (w === "5h") return "5h";
  if (w === "weekly") return "weekly";
  return "other";
}

function sortQuotaBuckets(buckets: QuotaBucket[]): QuotaBucket[] {
  return buckets
    .slice()
    .sort(
      (a, b) => QUOTA_WINDOW_RANK[classifyQuotaWindow(a)] - QUOTA_WINDOW_RANK[classifyQuotaWindow(b)],
    );
}

function formatResetRemaining(resetTime?: string, nowFn: () => number = Date.now): string | null {
  if (!resetTime) return null;
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return null;
  const delta = ts - nowFn();
  if (delta <= 0) return "ready";
  const totalMin = Math.ceil(delta / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

function renderProgressBar(fraction: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

/**
 * Parses a raw `v1internal:retrieveUserQuotaSummary` JSON response into QuotaSummary.
 */
export function parseQuotaSummary(data: any): QuotaSummary {
  const groups: QuotaGroup[] = [];
  for (const g of data?.groups || []) {
    const buckets: QuotaBucket[] = [];
    for (const b of g?.buckets || []) {
      buckets.push({
        bucketId: b.bucketId || "unknown",
        displayName: b.displayName || b.bucketId || "Limit",
        window: b.window,
        resetTime: b.resetTime,
        description: b.description,
        remainingFraction: typeof b.remainingFraction === "number" ? b.remainingFraction : 1,
      });
    }
    groups.push({
      displayName: g?.displayName || "Quota Group",
      description: g?.description,
      buckets,
    });
  }
  return { groups, description: data?.description };
}

/**
 * Formats a QuotaSummary into a multi-line progress bar report.
 */
export function formatQuotaSummary(summary: QuotaSummary, nowFn: () => number = Date.now): string {
  const lines: string[] = [];
  for (const group of summary.groups) {
    if (lines.length > 0) lines.push("");
    lines.push(`${group.displayName}`);
    for (const b of sortQuotaBuckets(group.buckets)) {
      const kind = classifyQuotaWindow(b);
      const shortLabel =
        kind === "5h" ? "5h" : kind === "weekly" ? "Wk" : b.displayName || b.bucketId || "Quota";
      const pct = Math.round(b.remainingFraction * 100);
      const reset = formatResetRemaining(b.resetTime, nowFn);
      const suffix = reset && pct < 100 ? ` (${reset})` : "";
      lines.push(
        `  ${shortLabel.padEnd(3)} ${renderProgressBar(b.remainingFraction)} ${String(pct).padStart(3)}% left${suffix}`,
      );
    }
  }
  return lines.join("\n");
}

function bucketPool(bucket: QuotaBucket): QuotaPoolKind {
  const id = (bucket.bucketId || "").toLowerCase();
  return id.includes("argon") ? "argon" : id.includes("gemini") ? "gemini" : "3p";
}

function selectQuotaGroup(groups: QuotaGroup[], modelId?: string): QuotaGroup | undefined {
  const byPool = (kind: QuotaPoolKind) =>
    groups.find((g) => (g.buckets || []).some((b) => bucketPool(b) === kind));
  return byPool(getModelProfile(modelId).quotaPoolKind) ?? byPool("gemini") ?? groups[0];
}

function windowBucket(buckets: QuotaBucket[], kind: QuotaWindowKind): QuotaBucket | undefined {
  return buckets.find((b) => classifyQuotaWindow(b) === kind);
}

function poolKey(bucket: QuotaBucket): string {
  const id = bucket.bucketId || "unknown";
  return id.replace(/[-_](5h|five-?hour|weekly)$/i, "") || id;
}

function extractWindowFractionPairs(
  summary?: QuotaSummary,
): Record<string, WindowFractionPair> {
  const pairs: Record<string, WindowFractionPair> = {};
  for (const g of summary?.groups || []) {
    const bucket5h = windowBucket(g.buckets, "5h");
    const bucketWeekly = windowBucket(g.buckets, "weekly");
    if (bucket5h && bucketWeekly) {
      pairs[poolKey(bucket5h)] = {
        "5h": bucket5h.remainingFraction,
        weekly: bucketWeekly.remainingFraction,
      };
    }
  }
  return pairs;
}

function calibrateWeeklyTo5hRatio(
  previous: Record<string, WindowFractionPair> | undefined,
  current: Record<string, WindowFractionPair> | undefined,
  currentRatio = DEFAULT_WEEKLY_TO_5H_RATIO,
): number {
  if (!previous || !current) return currentRatio;
  for (const key of Object.keys(current)) {
    const prev = previous[key];
    const curr = current[key];
    if (!prev || !curr) continue;
    const dFiveHour = prev["5h"] - curr["5h"];
    const dWeekly = prev.weekly - curr.weekly;
    if (dFiveHour > 0.0001 && dWeekly > 0.00001) {
      const observedRatio = dFiveHour / dWeekly;
      if (observedRatio >= 1.0 && observedRatio <= 20.0) {
        return Math.round(observedRatio * 100) / 100;
      }
    }
  }
  return currentRatio;
}

function selectUrgentBucket(group: QuotaGroup, weeklyTo5hRatio: number): QuotaBucket | undefined {
  const buckets = group.buckets;
  if (buckets.length === 0) return undefined;
  const bucket5h = windowBucket(buckets, "5h");
  const bucketWeekly = windowBucket(buckets, "weekly");
  if (bucket5h && bucketWeekly) {
    return bucketWeekly.remainingFraction * weeklyTo5hRatio < bucket5h.remainingFraction
      ? bucketWeekly
      : bucket5h;
  }
  let worst = buckets[0];
  for (const b of buckets) {
    if (b.remainingFraction < worst.remainingFraction) worst = b;
  }
  return worst;
}

function formatQuotaWindowPart(bucket: QuotaBucket, nowFn: () => number = Date.now): string {
  const kind = classifyQuotaWindow(bucket);
  const prefix =
    kind === "5h" ? "5h" : kind === "weekly" ? "Wk" : bucket.displayName || bucket.bucketId;
  const pct = Math.round(bucket.remainingFraction * 100);
  const short = formatResetRemaining(bucket.resetTime, nowFn)?.replace(/^in /, "");
  return short && pct < 100 ? `${prefix} ${pct}% (${short})` : `${prefix} ${pct}%`;
}

function resolveColorizer(style?: QuotaColorStyle): QuotaColorizer {
  if (typeof style === "function") return style;
  if (style && typeof style.fg === "function") return (tone, text) => style.fg(tone, text);
  return (tone, text) => {
    const code = tone === "error" ? ANSI_RED : tone === "warning" ? ANSI_YELLOW : ANSI_DIM;
    return `${code}${text}${ANSI_FG_RESET}`;
  };
}

function colorizeQuotaFooter(footer: string | undefined, style?: QuotaColorStyle): string | undefined {
  if (!footer) return undefined;
  const color = resolveColorizer(style);
  const match = footer.match(/(\d+)%/);
  if (!match) return color("dim", footer);
  const pct = parseInt(match[1], 10);
  if (pct <= QUOTA_ALERT_PCT) return color("error", footer);
  if (pct <= QUOTA_WARN_PCT) return color("warning", footer);
  return color("dim", footer);
}

function colorizeQuotaFooterBoth(
  footer: string | undefined,
  style?: QuotaColorStyle,
): string | undefined {
  if (!footer) return undefined;
  const color = resolveColorizer(style);
  const sep = color("dim", " · ");
  return footer
    .split(" · ")
    .map((part) => colorizeQuotaFooter(part, style) ?? part)
    .join(sep);
}

/**
 * Creates a QuotaStatusStore backed by the provider JSON config file.
 */
export function fileQuotaStatusStore(file = defaultConfigFile()): QuotaStatusStore {
  return {
    loadMode: () => resolveQuotaFooter(loadProviderConfig(file)),
    loadQuotaState: () => loadSubsystemState<QuotaState>("quota", file),
    saveQuotaState: (state) => saveSubsystemState("quota", state, file),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validPairs(raw: unknown): Record<string, WindowFractionPair> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const pairs: Record<string, WindowFractionPair> = {};
  for (const [key, value] of Object.entries(raw)) {
    const rec = value as { "5h"?: unknown; weekly?: unknown };
    if (isFiniteNumber(rec?.["5h"]) && isFiniteNumber(rec?.weekly)) {
      pairs[key] = { "5h": rec["5h"], weekly: rec.weekly };
    }
  }
  return Object.keys(pairs).length > 0 ? pairs : undefined;
}

function isLiveCtx(ctx: QuotaStatusCtx): boolean {
  try {
    void ctx.ui;
    return true;
  } catch {
    return false;
  }
}

export interface FooterModeDef {
  key: QuotaFooterMode;
  note?: string;
  render: (
    summary: QuotaSummary | undefined,
    modelId?: string,
    ratio?: number,
    style?: QuotaColorStyle,
    nowFn?: () => number,
  ) => { plain?: string; colored?: string };
}

export const FOOTER_MODES: Record<QuotaFooterMode, FooterModeDef> = Object.freeze({
  off: {
    key: "off",
    render: () => ({}),
  },
  smart: {
    key: "smart",
    note: QUOTA_FOOTER_NOTES.smart,
    render: (summary, modelId, ratio = DEFAULT_WEEKLY_TO_5H_RATIO, style, nowFn = Date.now) => {
      if (!summary) return {};
      const group = selectQuotaGroup(summary.groups, modelId);
      const urgent = group ? selectUrgentBucket(group, ratio) : undefined;
      const plain = urgent ? formatQuotaWindowPart(urgent, nowFn) : undefined;
      return { plain, colored: colorizeQuotaFooter(plain, style) };
    },
  },
  all: {
    key: "all",
    note: QUOTA_FOOTER_NOTES.all,
    render: (summary, modelId, _ratio, style, nowFn = Date.now) => {
      if (!summary) return {};
      const group = selectQuotaGroup(summary.groups, modelId);
      if (!group || group.buckets.length === 0) return {};
      const plain = sortQuotaBuckets(group.buckets)
        .map((b) => formatQuotaWindowPart(b, nowFn))
        .join(" · ");
      return { plain, colored: colorizeQuotaFooterBoth(plain, style) };
    },
  },
});

export function isAntigravityModel(model?: { provider?: string }): boolean {
  return model?.provider === PROVIDER_ID;
}

/**
 * Coordinates Antigravity quota polling, 5h/weekly ratio calibration, and footer updates.
 */
export class QuotaStatusCoordinator implements QuotaStatus {
  private summary: QuotaSummary | undefined;
  private fetchedAt = 0;
  private inflight: Promise<QuotaSummary | undefined> | null = null;
  private weeklyTo5hRatio: number;
  private lastPairs: Record<string, WindowFractionPair> | undefined;
  private readonly store: QuotaStatusStore;
  private readonly fetchSummaryOverride?: (token: string, signal?: AbortSignal) => Promise<any>;
  private readonly client: AntigravityClient;
  private readonly nowFn: () => number;

  constructor(depsOrStoreOrFile?: QuotaStatusDeps | string | QuotaStatusStore) {
    if (typeof depsOrStoreOrFile === "string" || !depsOrStoreOrFile) {
      this.store = fileQuotaStatusStore(depsOrStoreOrFile || defaultConfigFile());
      this.client = defaultAntigravityClient;
      this.nowFn = Date.now;
    } else if ("loadMode" in depsOrStoreOrFile) {
      this.store = depsOrStoreOrFile;
      this.client = defaultAntigravityClient;
      this.nowFn = Date.now;
    } else {
      this.store =
        depsOrStoreOrFile.store ??
        fileQuotaStatusStore(depsOrStoreOrFile.configFile || defaultConfigFile());
      this.fetchSummaryOverride = depsOrStoreOrFile.fetchQuotaSummary;
      this.client = depsOrStoreOrFile.client ?? defaultAntigravityClient;
      this.nowFn = depsOrStoreOrFile.now ?? Date.now;
    }
    this.weeklyTo5hRatio = DEFAULT_WEEKLY_TO_5H_RATIO;
    this.loadPersisted();
  }

  get ratio(): number {
    return this.weeklyTo5hRatio;
  }

  mode(): QuotaFooterMode {
    return this.store.loadMode();
  }

  bind(pi: ExtensionAPI, allowRefresh = () => true): void {
    if (typeof pi?.on !== "function") return;
    const update = (ctx: QuotaStatusCtx) =>
      allowRefresh() ? this.refreshAndPaint(ctx) : this.paint(ctx);
    pi.on("session_start", (_event, ctx) => update(ctx));
    pi.on("model_select", async (event, ctx) => {
      await update({
        ui: ctx.ui,
        modelRegistry: ctx.modelRegistry,
        model: event.model || ctx.model,
      });
    });
    pi.on("agent_settled", (_event, ctx) => update(ctx));
  }

  formatUsage(ctx: ExtensionCommandContext & { signal?: AbortSignal }): Promise<string> {
    return this.inspectUsage(ctx);
  }

  renderFooter(
    modelId?: string,
    mode: QuotaFooterMode = "smart",
    style?: QuotaColorStyle,
  ): { plain?: string; colored?: string } {
    return (
      FOOTER_MODES[mode]?.render(this.summary, modelId, this.weeklyTo5hRatio, style, this.nowFn) ??
      {}
    );
  }

  get isFresh(): boolean {
    return !!this.summary && this.nowFn() - this.fetchedAt < QUOTA_REFRESH_INTERVAL_MS;
  }

  refresh(ctx: QuotaStatusCtx, opts: RefreshOptions = {}): Promise<QuotaSummary | undefined> {
    if (!isLiveCtx(ctx)) return Promise.resolve(undefined);
    if (!opts.ignoreMode && (this.mode() === "off" || !isAntigravityModel(ctx.model))) {
      return Promise.resolve(undefined);
    }
    if (this.inflight) return this.inflight;
    if (!opts.force && this.isFresh) return Promise.resolve(this.summary);
    return this.fetchOnce(ctx, opts.signal);
  }

  async refreshAndPaint(ctx: QuotaStatusCtx): Promise<void> {
    this.paint(ctx);
    await this.refresh(ctx);
    this.paint(ctx);
  }

  paint(ctx: QuotaStatusCtx): void {
    if (!isLiveCtx(ctx)) return;
    const mode = this.mode();
    if (mode === "off" || !isAntigravityModel(ctx.model)) {
      ctx.ui.setStatus(QUOTA_STATUS_KEY, undefined);
      return;
    }
    const theme = (ctx.ui as { theme?: Theme })?.theme;
    const { colored } = this.renderFooter(ctx.model?.id, mode, theme);
    ctx.ui.setStatus(QUOTA_STATUS_KEY, colored);
  }

  async inspectUsage(ctx: QuotaStatusCtx & { signal?: AbortSignal }): Promise<string> {
    const summary = await this.refresh(ctx, { force: true, ignoreMode: true, signal: ctx.signal });
    if (!summary) {
      throw new Error("Failed to fetch usage.");
    }
    this.paint(ctx);
    return formatQuotaSummary(summary, this.nowFn);
  }

  previewFooter(
    modelId: string | undefined,
    mode: string,
    style?: QuotaColorStyle,
  ): string | undefined {
    const normalized = normalizeQuotaFooter(mode);
    if (!normalized || normalized === "off") return undefined;
    const { colored } = this.renderFooter(modelId, normalized, style);
    return colored ? ANSI_FG_RESET + colored : undefined;
  }

  ensurePreview(ctx: QuotaStatusCtx): Promise<QuotaSummary | undefined> {
    if (this.summary) return Promise.resolve(this.summary);
    if (this.inflight) return this.inflight;
    return this.fetchOnce(ctx);
  }

  private fetchOnce(ctx: QuotaStatusCtx, signal?: AbortSignal): Promise<QuotaSummary | undefined> {
    this.inflight = this.fetch(ctx, signal).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(
    ctx: QuotaStatusCtx,
    signal?: AbortSignal,
  ): Promise<QuotaSummary | undefined> {
    try {
      let rawSummary: any;
      if (this.fetchSummaryOverride) {
        const creds = await resolveCredentials(ctx);
        if (!creds) return undefined;
        rawSummary = await this.fetchSummaryOverride(creds.token, signal);
      } else {
        rawSummary = await this.client.retrieveQuotaSummary(ctx, signal);
      }
      if (!rawSummary) return undefined;
      const summary = rawSummary.groups ? parseQuotaSummary(rawSummary) : rawSummary;
      this.ingest(summary);
      return summary;
    } catch {
      return undefined;
    }
  }

  ingest(summaryOrRaw: any): void {
    const summary: QuotaSummary =
      summaryOrRaw &&
      summaryOrRaw.groups &&
      typeof summaryOrRaw.groups[0]?.buckets?.[0]?.remainingFraction === "number"
        ? parseQuotaSummary(summaryOrRaw)
        : summaryOrRaw;

    this.weeklyTo5hRatio = calibrateWeeklyTo5hRatio(
      this.lastPairs,
      extractWindowFractionPairs(summary),
      this.weeklyTo5hRatio,
    );
    this.lastPairs = extractWindowFractionPairs(summary);
    this.summary = summary;
    this.fetchedAt = this.nowFn();
    this.saveState();
  }

  private loadPersisted(): void {
    const entry = this.store.loadQuotaState();
    const ratio = entry?.weeklyTo5hRatio;
    if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) {
      this.weeklyTo5hRatio = ratio;
    }
    const at = entry?.updatedAt;
    this.lastPairs =
      typeof at === "number" && this.nowFn() - at <= MAX_OBSERVATION_AGE_MS
        ? validPairs(entry?.previousObservation)
        : undefined;
  }

  private saveState(): void {
    try {
      this.store.saveQuotaState({
        weeklyTo5hRatio: this.weeklyTo5hRatio,
        previousObservation: this.lastPairs ?? {},
        updatedAt: this.nowFn(),
      });
    } catch {
      // Cache persistence is best-effort.
    }
  }
}

/**
 * Creates a QuotaStatus coordinator instance.
 */
export function createQuotaStatus(
  deps?: QuotaStatusDeps | string | QuotaStatusStore,
): QuotaStatus {
  return new QuotaStatusCoordinator(deps);
}
