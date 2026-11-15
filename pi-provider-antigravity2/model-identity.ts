/**
 * Pure domain module encapsulating model identity, family classification,
 * quota pool mapping, defaults, and replay compatibility across requests.
 */

export type ModelFamily = "gemini" | "claude" | "gpt" | "unknown";
export type QuotaPoolKind = "gemini" | "argon" | "3p";

export interface ModelProfile {
  readonly id?: string;
  readonly family: ModelFamily;
  readonly isGemini: boolean;
  readonly isClaude: boolean;
  readonly isGpt: boolean;
  /** Gemini 4 Argon uses its own weekly quota pool on paid Pro plans. */
  readonly isArgon: boolean;
  readonly isNonGemini: boolean;
  readonly quotaPoolKind: QuotaPoolKind;
  readonly replaysReasoningHistory: boolean;
  readonly defaultContextWindow: number;
  readonly defaultMaxOutputTokens: number;
  readonly promptCache: { short: number; long?: number };
  isReplayCompatible(candidateModel?: string): boolean;
}

/**
 * Derives a ModelProfile for either a public or runtime model ID,
 * stripping any leading `provider/` prefix before matching.
 */
export function getModelProfile(modelId?: string): ModelProfile {
  const bare = ((modelId || "").split("/").pop() || "").toLowerCase();
  let family: ModelFamily = "unknown";
  if (bare.startsWith("gemini-")) family = "gemini";
  else if (bare.startsWith("claude-")) family = "claude";
  else if (bare.startsWith("gpt-")) family = "gpt";

  const isGemini = family === "gemini";
  const isClaude = family === "claude";
  const isGpt = family === "gpt";
  const isArgon = isGemini && bare.includes("-argon");
  const isNonGemini = family !== "gemini";

  const quotaPoolKind: QuotaPoolKind = isClaude || isGpt ? "3p" : isArgon ? "argon" : "gemini";
  const replaysReasoningHistory = family !== "gpt";

  const isFlash = bare.includes("flash");
  const defaultContextWindow = isFlash ? 1048576 : isClaude ? 250000 : isGpt ? 128000 : 1048576;
  const defaultMaxOutputTokens = isClaude ? 64000 : isGpt ? 32768 : 65536;
  const promptCache = isClaude ? { short: 300, long: 3600 } : { short: 300 };

  return {
    id: modelId,
    family,
    isGemini,
    isClaude,
    isGpt,
    isArgon,
    isNonGemini,
    quotaPoolKind,
    replaysReasoningHistory,
    defaultContextWindow,
    defaultMaxOutputTokens,
    promptCache,
    isReplayCompatible(candidateModel?: string): boolean {
      if (!candidateModel || !modelId) return true;
      if (candidateModel === modelId) return true;
      const other = getModelProfile(candidateModel);
      return other.family !== "unknown" && other.family === family;
    },
  };
}
