import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AntigravityAuthError,
  type CredentialSource,
  NOT_LOGGED_IN,
  requireCredentials,
} from "./auth.ts";
import { notifyCommandOutput } from "./config.ts";
import { ANTIGRAVITY_USER_AGENT_TAG } from "./constants.ts";
import type { ModelCatalog } from "./model-catalog.ts";
import {
  resolveSearchSystemInstruction,
  resolveWebSearchToolPrompts,
  type PromptsFileConfig,
} from "./prompts.ts";
import { type AntigravityClient, defaultAntigravityClient } from "./protocol.ts";

export const WEB_SEARCH_TOOL_NAME = "antigravity_websearch";
// Compatibility fallback for catalogs from before webSearchModelIds was available.
export const SEARCH_MODEL = "gemini-3.5-flash-lite";

interface SearchConfig {
  catalog?: Pick<ModelCatalog, "getWebSearchModelId">;
  promptsConfig?: PromptsFileConfig;
  promptsFile?: string;
}

export interface WebSearchOptions extends SearchConfig {
  query: string;
  domain?: string;
  signal?: AbortSignal;
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GroundingSupport {
  segment?: { partIndex?: number; endIndex?: number };
  groundingChunkIndices?: number[];
}

interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
}

interface SearchPart {
  text?: string;
  thought?: boolean;
}

interface SearchCandidate {
  content?: { role?: string; parts?: SearchPart[] };
  groundingMetadata?: GroundingMetadata;
}

interface SearchApiResponse {
  response?: { candidates?: SearchCandidate[] };
}

export interface SearchSource {
  index: number;
  title: string;
  url: string;
}

export interface SearchResult {
  query: string;
  rawText: string;
  formattedOutput: string;
  sources: SearchSource[];
  queries: string[];
  createdAt: string;
  completedAt: string;
}

function insertPartCitations(text: string, citations?: ReadonlyMap<number, Set<number>>): string {
  if (!citations?.size) return text;
  let byteOffset = 0;
  let stringOffset = 0;
  let lastCut = 0;
  let annotated = "";
  // Check only actual code-point boundaries. Out-of-range or mid-code-point offsets are ignored.
  for (const codePoint of text) {
    byteOffset += Buffer.byteLength(codePoint);
    stringOffset += codePoint.length;
    const indices = citations.get(byteOffset);
    if (!indices) continue;
    const markers = [...indices].map((index) => `[${index}]`).join("");
    annotated += text.slice(lastCut, stringOffset) + markers;
    lastCut = stringOffset;
  }
  return annotated + text.slice(lastCut);
}

/**
 * Builds inline citations from UTF-8 byte offsets within the original response parts.
 */
export function formatSearchResults(
  response: string | readonly SearchPart[],
  metadata: GroundingMetadata | undefined,
  query: string,
  createdAt: string,
  completedAt: string,
): SearchResult {
  const parts = typeof response === "string" ? [{ text: response }] : response;
  const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
  const sources = chunks.flatMap((chunk, i): SearchSource[] => {
    const web = chunk?.web;
    const url = typeof web?.uri === "string" ? web.uri.trim() : "";
    if (!/^https?:\/\/[^\s<>]+$/i.test(url) || !URL.canParse(url)) return [];
    const title = typeof web?.title === "string" ? web.title.replace(/\s+/g, " ").trim() : "";
    return [{ index: i + 1, title: title || "Web Source", url }];
  });
  const validIndices = new Set(sources.map(({ index }) => index));

  const citationsByPart = new Map<number, Map<number, Set<number>>>();
  const supports = Array.isArray(metadata?.groundingSupports) ? metadata.groundingSupports : [];
  for (const support of supports) {
    const partIndex = support?.segment?.partIndex ?? 0;
    const endIndex = support?.segment?.endIndex;
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= parts.length) continue;
    if (endIndex === undefined || !Number.isInteger(endIndex) || endIndex <= 0) continue;
    if (!Array.isArray(support?.groundingChunkIndices)) continue;
    for (const chunkIndex of support.groundingChunkIndices) {
      if (!Number.isInteger(chunkIndex) || !validIndices.has(chunkIndex + 1)) continue;
      let byOffset = citationsByPart.get(partIndex);
      if (!byOffset) citationsByPart.set(partIndex, (byOffset = new Map()));
      let indices = byOffset.get(endIndex);
      if (!indices) byOffset.set(endIndex, (indices = new Set()));
      indices.add(chunkIndex + 1);
    }
  }

  // Keep original part indices even for thoughts and non-text parts not shown to the caller.
  const visibleParts = parts.map((part) =>
    !part?.thought && typeof part?.text === "string" ? part.text : "",
  );
  const rawText = visibleParts.join("");
  const annotatedText = visibleParts
    .map((text, i) => insertPartCitations(text, citationsByPart.get(i)))
    .join("");
  const queries = Array.isArray(metadata?.webSearchQueries) ? metadata.webSearchQueries : [];
  const sourceLines = sources.map(({ index, title, url }) => {
    const label = title.replace(/[\\[\]]/g, "\\$&");
    const destination = url.replace(/[()\\]/g, "\\$&");
    return `[${index}] [${label}](${destination})`;
  });
  let formattedOutput =
    `Created At: ${createdAt}\n` +
    `Completed At: ${completedAt}\n` +
    `The search for "${query}" returned the following summary:\n` +
    `${annotatedText.trim() || "No content returned."}`;

  if (sourceLines.length > 0) {
    formattedOutput += `\n\nSources:\n${sourceLines.join("\n")}`;
  }

  return {
    query,
    rawText,
    formattedOutput,
    sources,
    queries,
    createdAt,
    completedAt,
  };
}

/**
 * Executes a native HTTP Google Search Grounding query via Antigravity `v1internal:generateContent`.
 */
export async function performWebSearch(
  source: CredentialSource,
  options: WebSearchOptions,
  client: AntigravityClient = defaultAntigravityClient,
): Promise<SearchResult> {
  await requireCredentials(source);
  const createdAt = new Date().toISOString();
  let effectiveQuery = options.query.trim();
  if (options.domain && options.domain.trim()) {
    const d = options.domain.trim();
    if (!effectiveQuery.toLowerCase().includes(`site:${d.toLowerCase()}`)) {
      effectiveQuery = `${effectiveQuery} site:${d}`;
    }
  }

  const searchSystemInstruction = resolveSearchSystemInstruction(
    options.promptsConfig ?? options.promptsFile,
  );

  const reqBody = {
    request: {
      contents: [{ role: "user", parts: [{ text: effectiveQuery }] }],
      systemInstruction: { role: "user", parts: [{ text: searchSystemInstruction }] },
      tools: [
        {
          googleSearch: {
            enhancedContent: { imageSearch: { maxResultCount: 5 } },
          },
        },
      ],
      generationConfig: { candidateCount: 1 },
    },
    model: options.catalog?.getWebSearchModelId() ?? SEARCH_MODEL,
    userAgent: ANTIGRAVITY_USER_AGENT_TAG,
    requestType: "web_search",
  };

  const resp = await client.postJson<SearchApiResponse>(
    source,
    "v1internal:generateContent",
    reqBody,
    options.signal,
  );

  const completedAt = new Date().toISOString();
  const candidate = resp.response?.candidates?.[0];
  const result = formatSearchResults(
    candidate?.content?.parts ?? [],
    candidate?.groundingMetadata,
    effectiveQuery,
    createdAt,
    completedAt,
  );
  if (result.sources.length === 0) {
    throw new Error("Google Search Grounding returned no web sources.");
  }
  return result;
}

export interface SearchTypeBuilder {
  Object: (props: Record<string, any>) => any;
  String: (opts?: Record<string, any>) => any;
  Optional: (schema: any) => any;
}

const FALLBACK_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query string to look up on the web." },
    domain: {
      type: "string",
      description:
        "Optional domain to recommend the search prioritize (e.g. 'github.com', 'developer.mozilla.org').",
    },
  },
  required: ["query"],
};

/**
 * Registers the `antigravity_websearch` Pi tool backed by native HTTP Cloud Code search grounding.
 */
export function registerWebSearchTool(
  pi: ExtensionAPI,
  options?: SearchConfig & {
    client?: AntigravityClient;
    typeBuilder?: SearchTypeBuilder;
  },
): void {
  if (typeof pi.registerTool !== "function") return;
  const Type = options?.typeBuilder;
  const parameters = Type
    ? Type.Object({
        query: Type.String({ description: "The search query string to look up on the web." }),
        domain: Type.Optional(
          Type.String({
            description:
              "Optional domain to recommend the search prioritize (e.g. 'github.com', 'developer.mozilla.org').",
          }),
        ),
      })
    : FALLBACK_SEARCH_SCHEMA;

  const toolPrompts = resolveWebSearchToolPrompts(options?.promptsConfig ?? options?.promptsFile);

  pi.registerTool({
    name: WEB_SEARCH_TOOL_NAME,
    label: "Antigravity Web Search",
    description: toolPrompts.description,
    promptSnippet: toolPrompts.promptSnippet,
    promptGuidelines: toolPrompts.promptGuidelines,
    parameters,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      try {
        const result = await performWebSearch(
          ctx,
          {
            query: params.query,
            domain: params.domain,
            signal,
            catalog: options?.catalog,
            promptsConfig: options?.promptsConfig,
            promptsFile: options?.promptsFile,
          },
          options?.client,
        );
        return {
          content: [{ type: "text", text: result.formattedOutput }],
          details: { sources: result.sources, queries: result.queries },
        };
      } catch (err: any) {
        if (err instanceof AntigravityAuthError) {
          return {
            content: [{ type: "text", text: `Error: ${NOT_LOGGED_IN}` }],
            details: { error: "not_logged_in" },
          };
        }
        return {
          content: [{ type: "text", text: `Search failed: ${err?.message ?? String(err)}` }],
          details: { error: err?.message ?? String(err) },
        };
      }
    },
  });
}

/**
 * Executes `/antigravity websearch <query>` from the Pi CLI or TUI.
 */
export async function executeWebSearchCommand(
  ctx: ExtensionCommandContext,
  query?: string,
  client?: AntigravityClient,
  catalog?: SearchConfig["catalog"],
): Promise<void> {
  const trimmedQuery = (query || "").trim();
  if (!trimmedQuery) {
    notifyCommandOutput(ctx, "Usage: /antigravity websearch <query>", "warning");
    return;
  }

  try {
    if (ctx.hasUI) ctx.ui.notify(`Searching: "${trimmedQuery}"…`, "info");
    const result = await performWebSearch(
      ctx,
      { query: trimmedQuery, signal: ctx.signal, catalog },
      client,
    );
    notifyCommandOutput(ctx, result.formattedOutput);
  } catch (err: any) {
    if (err instanceof AntigravityAuthError) {
      notifyCommandOutput(ctx, NOT_LOGGED_IN, "warning");
      return;
    }
    notifyCommandOutput(ctx, `Search failed: ${err?.message ?? String(err)}`, "error");
  }
}
