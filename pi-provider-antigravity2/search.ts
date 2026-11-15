import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AntigravityAuthError,
  type CredentialSource,
  NOT_LOGGED_IN,
  requireCredentials,
} from "./auth.ts";
import { notifyCommandOutput } from "./config.ts";
import { ANTIGRAVITY_USER_AGENT_TAG } from "./constants.ts";
import {
  resolveSearchSystemInstruction,
  resolveWebSearchToolPrompts,
  type PromptsFileConfig,
} from "./prompts.ts";
import { type AntigravityClient, defaultAntigravityClient } from "./protocol.ts";

export const WEB_SEARCH_TOOL_NAME = "antigravity_websearch";
export const SEARCH_MODEL = "gemini-3.5-flash-lite";

export interface WebSearchOptions {
  query: string;
  domain?: string;
  signal?: AbortSignal;
  promptsConfig?: PromptsFileConfig;
  promptsFile?: string;
}

interface GroundingChunk {
  web?: { uri: string; title: string };
}

interface GroundingSupport {
  segment?: { startIndex?: number; endIndex?: number; text?: string };
  groundingChunkIndices?: number[];
}

interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
}

interface SearchCandidate {
  content?: { role: string; parts?: Array<{ text?: string }> };
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

/**
 * Formats search response text with inline numeric citations and a markdown Sources section.
 */
export function formatSearchResults(
  rawText: string,
  metadata: GroundingMetadata | undefined,
  query: string,
  createdAt: string,
  completedAt: string,
): SearchResult {
  const sources: SearchSource[] = (metadata?.groundingChunks || [])
    .map((chunk, i) => ({
      index: i + 1,
      title: chunk.web?.title || "Web Source",
      url: chunk.web?.uri || "",
    }))
    .filter((s) => Boolean(s.url));

  const queries = metadata?.webSearchQueries || [];
  let annotatedText = rawText;

  const supports = (metadata?.groundingSupports || [])
    .filter(
      (s): s is GroundingSupport & { segment: { endIndex: number } } =>
        typeof s.segment?.endIndex === "number" &&
        Array.isArray(s.groundingChunkIndices) &&
        s.groundingChunkIndices.length > 0,
    )
    .slice()
    .sort((a, b) => (b.segment.endIndex ?? 0) - (a.segment.endIndex ?? 0));

  for (const sup of supports) {
    const end = sup.segment.endIndex;
    if (end >= 0 && end <= annotatedText.length) {
      const citations = sup.groundingChunkIndices!.map((idx) => `[${idx + 1}]`).join("");
      annotatedText = annotatedText.slice(0, end) + citations + annotatedText.slice(end);
    }
  }

  const sourceLines = sources.map((s) => `[${s.index}] [${s.title}](${s.url})`);
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
    model: SEARCH_MODEL,
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
  const rawText =
    candidate?.content?.parts
      ?.filter((p) => typeof p.text === "string")
      .map((p) => p.text)
      .join("") || "";

  return formatSearchResults(
    rawText,
    candidate?.groundingMetadata,
    effectiveQuery,
    createdAt,
    completedAt,
  );
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
  options?: {
    client?: AntigravityClient;
    typeBuilder?: SearchTypeBuilder;
    promptsConfig?: PromptsFileConfig;
    promptsFile?: string;
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
      { query: trimmedQuery, signal: ctx.signal },
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
