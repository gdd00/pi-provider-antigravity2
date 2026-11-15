import { applySystemInstructionRewrites, loadDefaultPromptsBundle } from "./prompts.ts";

export const WAF_SAFE_FALLBACK_SYSTEM_PROMPT = "You are a coding assistant.";
export const MAX_WAF_ISOLATION_PROBES = 20;
export const MAX_CACHED_WAF_SNIPPETS = 128;

const EMERGENCY_PI_BOILERPLATE_RULES = [
  {
    pattern: "\\bYou can inspect PI_\\* environment variables[^\\n]*\\n?",
    replacement: "",
  },
  {
    pattern: "\\bAdditional tools may be available\\.\\n?",
    replacement: "",
  },
  {
    pattern: "\\bIn addition to the tools above, you can use custom tools if provided\\.\\n?",
    replacement: "",
  },
] as const;

const cachedBlockedSnippets = new Set<string>();
const warnedBlockedSnippets = new Set<string>();

export type ProbeOutcome =
  | { kind: "clean" }
  | { kind: "blocked" }
  | { kind: "inconclusive"; error: unknown };

export type WafRecoveryResult =
  | {
      status:
        | "not-applicable"
        | "system-clean"
        | "global-429"
        | "inconclusive"
        | "budget-exceeded";
      error?: unknown;
    }
  | {
      status: "recovered";
      sanitizedText: string;
      blockedSnippets: string[];
      probeCount: number;
    };

class ProbeBudgetExceededError extends Error {
  constructor() {
    super("WAF isolation probe budget exceeded");
  }
}

class ProbeInconclusiveError extends Error {
  readonly causeError: unknown;
  constructor(causeError: unknown) {
    super("WAF isolation probe returned inconclusive error");
    this.causeError = causeError;
  }
}

/**
 * Returns all systemInstruction snippets/lines discovered as WAF triggers in this process.
 */
export function getCachedWafBlockedSnippets(): string[] {
  return [...cachedBlockedSnippets];
}

/**
 * Records a discovered offending systemInstruction snippet in the bounded process cache.
 */
export function recordWafBlockedSnippet(snippet: string): void {
  const normalized = snippet.trim();
  if (!normalized) return;
  if (cachedBlockedSnippets.has(normalized)) return;
  if (cachedBlockedSnippets.size >= MAX_CACHED_WAF_SNIPPETS) {
    const oldest = cachedBlockedSnippets.values().next().value;
    if (oldest !== undefined) cachedBlockedSnippets.delete(oldest);
  }
  cachedBlockedSnippets.add(normalized);
}

/**
 * Clears cached WAF snippets and warning dedupe state. Exposed for tests.
 */
export function clearWafBlockedSnippets(): void {
  cachedBlockedSnippets.clear();
  warnedBlockedSnippets.clear();
}

/**
 * Emits a one-time diagnostic warning identifying the auto-removed WAF trigger line(s).
 */
export function warnWafAutoRemediationOnce(snippets: readonly string[]): void {
  const fresh = snippets.filter((s) => s.trim() && !warnedBlockedSnippets.has(s.trim()));
  if (fresh.length === 0) return;
  for (const s of fresh) {
    warnedBlockedSnippets.add(s.trim());
  }
  const previews = fresh.map((s) => {
    const singleLine = s.trim().replace(/\s+/g, " ");
    return singleLine.length > 100 ? `${singleLine.slice(0, 97)}...` : singleLine;
  });
  console.warn(
    `[pi-provider-antigravity2] Auto-remediated Antigravity WAF 429 by removing blocked systemInstruction line(s): ${JSON.stringify(previews)}`,
  );
}

/**
 * Extracts concatenated text from `request.systemInstruction.parts`.
 */
export function readSystemInstructionText(body: Record<string, any> | undefined): string {
  const parts = body?.request?.systemInstruction?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Clones `body` with an updated `request.systemInstruction` text (or removes it when empty).
 */
export function withSystemInstructionText(
  body: Record<string, any>,
  nextText: string,
): Record<string, any> {
  const trimmed = nextText.trim();
  const nextRequest = { ...(body.request ?? {}) };
  if (!trimmed) {
    delete nextRequest.systemInstruction;
  } else {
    nextRequest.systemInstruction = {
      ...(body.request?.systemInstruction ?? {}),
      role: body.request?.systemInstruction?.role ?? "user",
      parts: [{ text: nextText }],
    };
  }
  return {
    ...body,
    request: nextRequest,
  };
}

function cleanupEmptyXmlSections(text: string): string {
  let prev = text;
  while (true) {
    const next = prev
      .replace(/\n{0,2}<([a-z][a-z0-9_-]*)>[ \t]*(?:\n[ \t]*)?<\/\1>(?=\n|$)/gi, "")
      .replace(/\n+\n(<\/[a-z][a-z0-9_-]*>)/gi, "\n$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (next === prev) return next;
    prev = next;
  }
}

/**
 * Applies built-in Pi prompt sanitization plus emergency Pi boilerplate cleanup.
 * Used as a fast recovery step when an initial request triggers a synthetic WAF 429
 * (for example due to stale user config or `adaptSystemInstruction: false`).
 */
export function applyEmergencyPiSanitization(text: string): string {
  if (!text) return text;
  const bundle = loadDefaultPromptsBundle();
  const afterBuiltIn = applySystemInstructionRewrites(
    text,
    [...bundle.systemInstructionRewrites, ...EMERGENCY_PI_BOILERPLATE_RULES],
    bundle.defaultRewriteFlags,
  );
  if (afterBuiltIn === text) return text;
  return cleanupEmptyXmlSections(afterBuiltIn) || WAF_SAFE_FALLBACK_SYSTEM_PROMPT;
}

/**
 * Removes exact line or block snippets known to trigger Antigravity WAF 429s from `text`.
 * Leaves `text` byte-identical if none of `snippets` match.
 */
export function removeBlockedSnippetsFromText(
  text: string,
  snippets: Iterable<string>,
): string {
  const snippetList = [...snippets].map((s) => s.trim()).filter(Boolean);
  if (!text || snippetList.length === 0) return text;

  const exactSet = new Set(snippetList);
  const multiLineSnippets = snippetList.filter((s) => s.includes("\n"));

  let working = text;
  let changed = false;

  for (const block of multiLineSnippets) {
    if (working.includes(block)) {
      working = working.split(block).join("");
      changed = true;
    }
  }

  const lines = working.split("\n");
  const keptLines = lines.filter((line) => !exactSet.has(line.trim()));
  if (keptLines.length !== lines.length) {
    working = keptLines.join("\n");
    changed = true;
  }

  if (!changed) return text;
  return cleanupEmptyXmlSections(working);
}

/**
 * Builds a minimal 1-output-token request payload to probe whether `systemText`
 * triggers Antigravity's proxy WAF. Omits tools, thinkingConfig, and `requestType`.
 */
export function buildWafProbeBody(
  sourceBody: Record<string, any>,
  systemText: string,
): Record<string, any> {
  const request: Record<string, any> = {
    contents: [{ role: "user", parts: [{ text: "." }] }],
    generationConfig: { maxOutputTokens: 1 },
  };
  if (systemText.trim()) {
    request.systemInstruction = {
      role: "user",
      parts: [{ text: systemText }],
    };
  }
  return {
    ...(sourceBody.project !== undefined ? { project: sourceBody.project } : {}),
    model: sourceBody.model,
    request,
    ...(sourceBody.userAgent ? { userAgent: sourceBody.userAgent } : {}),
    requestId: `agent-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function joinUnitSlice(units: readonly string[], indices: readonly number[], joiner: string): string {
  return indices.map((idx) => units[idx]).join(joiner);
}

/**
 * Automatically isolates offending block(s)/line(s) inside `body.request.systemInstruction`
 * when a synthetic WAF 429 occurs despite prior sanitization.
 */
export async function isolateBlockedSystemInstruction(params: {
  body: Record<string, any>;
  runProbe: (probeBody: Record<string, any>) => Promise<ProbeOutcome>;
  maxProbes?: number;
}): Promise<WafRecoveryResult> {
  const rawText = readSystemInstructionText(params.body);
  if (!rawText.trim() || rawText.trim() === WAF_SAFE_FALLBACK_SYSTEM_PROMPT) {
    return { status: "not-applicable" };
  }

  const maxProbes = Math.max(4, params.maxProbes ?? MAX_WAF_ISOLATION_PROBES);
  const probeCache = new Map<string, boolean>();
  let probeCount = 0;

  async function isBlockedText(candidateText: string): Promise<boolean> {
    const key = candidateText;
    const cached = probeCache.get(key);
    if (cached !== undefined) return cached;

    if (probeCount >= maxProbes) {
      throw new ProbeBudgetExceededError();
    }
    probeCount += 1;

    const outcome = await params.runProbe(buildWafProbeBody(params.body, candidateText));
    if (outcome.kind === "inconclusive") {
      throw new ProbeInconclusiveError(outcome.error);
    }
    const blocked = outcome.kind === "blocked";
    probeCache.set(key, blocked);
    return blocked;
  }

  async function findBlockedIndices(
    units: readonly string[],
    joiner: string,
    indices: readonly number[],
  ): Promise<number[]> {
    if (indices.length === 0) return [];
    if (indices.length === 1) return [indices[0]];

    const mid = Math.floor(indices.length / 2);
    const left = indices.slice(0, mid);
    const right = indices.slice(mid);

    const leftBlocked = await isBlockedText(joinUnitSlice(units, left, joiner));
    if (leftBlocked) {
      const badLeft = await findBlockedIndices(units, joiner, left);
      const badLeftSet = new Set(badLeft);
      const remaining = indices.filter((idx) => !badLeftSet.has(idx));
      if (remaining.length === 0) return badLeft;
      if (!(await isBlockedText(joinUnitSlice(units, remaining, joiner)))) {
        return badLeft;
      }
      if (await isBlockedText(joinUnitSlice(units, right, joiner))) {
        const badRight = await findBlockedIndices(units, joiner, right);
        return [...badLeft, ...badRight];
      }
      return [...badLeft, right[0]];
    }

    if (await isBlockedText(joinUnitSlice(units, right, joiner))) {
      return findBlockedIndices(units, joiner, right);
    }

    return [right[0]];
  }

  try {
    // Seed cache if caller already saw `rawText` fail with synthetic 429 vs check with minimal payload.
    const fullBlocked = await isBlockedText(rawText);
    if (!fullBlocked) {
      return { status: "system-clean" };
    }

    const baselineBlocked = await isBlockedText(WAF_SAFE_FALLBACK_SYSTEM_PROMPT);
    if (baselineBlocked) {
      return { status: "global-429" };
    }

    const blocks = rawText.split(/\n{2,}/);
    const allBlockIndices = blocks.map((_, i) => i);
    const badBlockIndices =
      blocks.length > 1 ? await findBlockedIndices(blocks, "\n\n", allBlockIndices) : [0];

    const blockedSnippets: string[] = [];
    for (const blockIdx of badBlockIndices) {
      const block = blocks[blockIdx];
      const lines = block.split("\n");
      if (lines.length > 1 && (await isBlockedText(block))) {
        const allLineIndices = lines.map((_, i) => i);
        const badLineIndices = await findBlockedIndices(lines, "\n", allLineIndices);
        for (const lineIdx of badLineIndices) {
          if (lines[lineIdx].trim()) blockedSnippets.push(lines[lineIdx].trim());
        }
      } else if (block.trim()) {
        blockedSnippets.push(block.trim());
      }
    }

    if (blockedSnippets.length === 0) {
      return { status: "inconclusive" };
    }

    const cleaned = removeBlockedSnippetsFromText(rawText, blockedSnippets);
    const sanitizedText = cleaned || WAF_SAFE_FALLBACK_SYSTEM_PROMPT;

    return {
      status: "recovered",
      sanitizedText,
      blockedSnippets,
      probeCount,
    };
  } catch (err) {
    if (err instanceof ProbeBudgetExceededError) {
      return { status: "budget-exceeded", error: err };
    }
    if (err instanceof ProbeInconclusiveError) {
      return { status: "inconclusive", error: err.causeError };
    }
    throw err;
  }
}
