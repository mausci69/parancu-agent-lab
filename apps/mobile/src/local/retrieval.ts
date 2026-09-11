// /apps/mobile/src/local/retrieval.ts

// Local semantic-anchor retrieval for v1-shaped prepared corpora.
// Retrieval path:
// user query -> local E5 query embedding -> guiding question embeddings
// -> semantic score
// plus lexical anchor evidence:
// 1. exact anchors, e.g. MS, BASEBALL, LUNAR, GPT-4, 1130
// 2. rare lowercase keyword evidence, e.g. cytomegalovirus
//
// Final score:
// finalScore = semanticWeight * semanticScore + anchorWeight * anchorScore
// anchorWeight = 1 - semanticWeight
//
// The answer_focus field is no longer used for ranking or lexical matching.
// It is kept only as an empty compatibility field until the UI is cleaned up.

import type { PrepareResult, Chunk } from "./prepareCorpus";
import { embedOne } from "../lib/embeddings";

const DEFAULT_MIN_EXACT_ANCHOR_LENGTH = 2;
const DEFAULT_MIN_SOFT_KEYWORD_LENGTH = 4;
const SOFT_KEYWORD_MAX_DF_RATIO = 0.2;

const DEFAULT_RETRIEVE_K = 5;

const DEFAULT_SEMANTIC_WEIGHT = 0.65;
const MIN_SEMANTIC_WEIGHT = 0.4;
const MAX_SEMANTIC_WEIGHT = 1.0;

const EXACT_ANCHOR_COMPONENT_WEIGHT = 2 / 3;
const SOFT_KEYWORD_COMPONENT_WEIGHT = 1 / 3;

export type SemanticIndex = {
  docId: string;
  chunks: Chunk[];
  sentences?: Array<{ id: number; text: string }>;
};

export type RetrieveOptions = {
  semanticWeight?: number;
  minTokenLength?: number;
  stopwords?: Set<string>;
};

export type RetrieveResult = {
  chunk_index: number;
  guiding_question: string;
  answer_focus: string;
  chunk: string;
  summary: string;
  sentence_ids: number[];
  score: number;
  cosine_score: number;
};

type RankedChunk = {
  idx: number;
  chunk: Chunk;
  sentenceIds: number[];
  score: number;
  semanticScore: number;
  anchorScore: number;
  exactAnchorScore: number;
  softKeywordScore: number;
};

type RankingContext = {
  queryKeywords: string[];
  rareQueryKeywords: string[];
  keywordDf: Map<string, number>;
};

async function embedText(text: string): Promise<number[]> {
  const cleanText = String(text || "").trim();

  if (!cleanText) {
    return [];
  }

  try {
    const embedding = await embedOne(cleanText);

    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("Local E5 returned an empty query embedding.");
    }

    const numericEmbedding = embedding.map((value) => Number(value));

    if (numericEmbedding.some((value) => !Number.isFinite(value))) {
      throw new Error(
        "Local E5 returned a query embedding containing invalid values."
      );
    }

    return numericEmbedding;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown local embedding error.";

    throw new Error(`Unable to create local E5 query embedding. ${message}`);
  }
}

export function cosineArray(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);

  if (n === 0) {
    return 0;
  }

  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];

    dot += x * y;
    na += x * x;
    nb += y * y;
  }

  if (na === 0 || nb === 0) {
    return 0;
  }

  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function getSemanticWeight(options?: RetrieveOptions): number {
  const rawWeight = Number(options?.semanticWeight);

  if (!Number.isFinite(rawWeight)) {
    return DEFAULT_SEMANTIC_WEIGHT;
  }

  return Math.min(
    Math.max(rawWeight, MIN_SEMANTIC_WEIGHT),
    MAX_SEMANTIC_WEIGHT
  );
}

function semanticScore(
  queryEmbedding: number[],
  chunk: Chunk
): number {
  const guidingQuestionEmbedding = Array.isArray(
    chunk.guiding_question_embedding
  )
    ? chunk.guiding_question_embedding
    : [];

  return clamp01(
    cosineArray(queryEmbedding, guidingQuestionEmbedding)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSentenceIds(chunk: Chunk): number[] {
  return Array.isArray(chunk.sentence_ids)
    ? chunk.sentence_ids
        .map((value) => Number(value))
        .filter((value) => !Number.isNaN(value))
    : [];
}

function searchableChunkText(chunk: Chunk): string {
  return [
    chunk.guiding_question,
    chunk.summary,
    chunk.text,
  ]
    .map((value) => String(value || ""))
    .join("\n");
}

function tokenizeWords(text: string): string[] {
  return (
    String(text || "").match(
      /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu
    ) ?? []
  );
}

function extractExactAnchorTokens(
  text: string,
  options?: RetrieveOptions
): string[] {
  const minTokenLength =
    options?.minTokenLength ??
    DEFAULT_MIN_EXACT_ANCHOR_LENGTH;

  const stopwords =
    options?.stopwords ?? new Set<string>();

  const unique = new Set<string>();

  for (const token of tokenizeWords(text)) {
    if (token.length < minTokenLength) {
      continue;
    }

    if (stopwords.has(token.toLocaleLowerCase())) {
      continue;
    }

    const isUppercaseAnchor =
      /[A-Z]/.test(token) &&
      token === token.toUpperCase();

    const hasDigit = /\d/.test(token);
    const hasSymbol = /[_-]/.test(token);

    if (
      !isUppercaseAnchor &&
      !hasDigit &&
      !hasSymbol
    ) {
      continue;
    }

    unique.add(token);
  }

  return Array.from(unique);
}

function extractSoftKeywords(
  text: string,
  options?: RetrieveOptions
): string[] {
  const minTokenLength =
    options?.minTokenLength ??
    DEFAULT_MIN_SOFT_KEYWORD_LENGTH;

  const stopwords =
    options?.stopwords ?? new Set<string>();

  const unique = new Set<string>();

  for (const rawToken of tokenizeWords(text)) {
    const token = rawToken.toLocaleLowerCase();

    if (token.length < minTokenLength) {
      continue;
    }

    if (stopwords.has(token)) {
      continue;
    }

    unique.add(token);
  }

  return Array.from(unique);
}

function buildSoftKeywordDocumentFrequency(
  queryKeywords: string[],
  chunks: Chunk[]
): Map<string, number> {
  const documentFrequency = new Map<string, number>();

  for (const keyword of queryKeywords) {
    documentFrequency.set(keyword, 0);
  }

  for (const chunk of chunks) {
    const chunkKeywords = new Set(
      extractSoftKeywords(searchableChunkText(chunk))
    );

    for (const keyword of documentFrequency.keys()) {
      if (chunkKeywords.has(keyword)) {
        documentFrequency.set(
          keyword,
          (documentFrequency.get(keyword) ?? 0) + 1
        );
      }
    }
  }

  return documentFrequency;
}

function filterRareQueryKeywords(
  queryKeywords: string[],
  documentFrequency: Map<string, number>,
  chunkCount: number
): string[] {
  const maxDocumentFrequency = Math.max(
    1,
    Math.ceil(chunkCount * SOFT_KEYWORD_MAX_DF_RATIO)
  );

  return queryKeywords.filter((keyword) => {
    const count = documentFrequency.get(keyword) ?? 0;

    return (
      count > 0 &&
      count <= maxDocumentFrequency
    );
  });
}

function countExactTokenMatches(
  text: string,
  token: string
): number {
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_-])${escapeRegExp(
      token
    )}(?=$|[^A-Za-z0-9_-])`,
    "g"
  );

  return String(text || "").match(pattern)?.length ?? 0;
}

function exactAnchorScore(
  question: string,
  chunk: Chunk,
  options?: RetrieveOptions
): number {
  const anchors = extractExactAnchorTokens(
    question,
    options
  );

  if (anchors.length === 0) {
    return 0;
  }

  const searchableText = searchableChunkText(chunk);

  let matchedAnchors = 0;
  let totalMatches = 0;

  for (const anchor of anchors) {
    const matches = countExactTokenMatches(
      searchableText,
      anchor
    );

    if (matches > 0) {
      matchedAnchors += 1;
      totalMatches += matches;
    }
  }

  if (matchedAnchors === 0) {
    return 0;
  }

  const coverage =
    matchedAnchors / anchors.length;

  const repetition =
    Math.min(totalMatches, 3) / 3;

  return clamp01(
    coverage * 0.8 +
      repetition * 0.2
  );
}

function softKeywordScore(
  chunk: Chunk,
  rareQueryKeywords: string[]
): number {
  if (rareQueryKeywords.length === 0) {
    return 0;
  }

  const chunkKeywords = new Set(
    extractSoftKeywords(searchableChunkText(chunk))
  );

  let matched = 0;

  for (const keyword of rareQueryKeywords) {
    if (chunkKeywords.has(keyword)) {
      matched += 1;
    }
  }

  if (matched === 0) {
    return 0;
  }

  return clamp01(
    matched / rareQueryKeywords.length
  );
}

function anchorScore(
  exactScore: number,
  softScore: number
): number {
  return clamp01(
    EXACT_ANCHOR_COMPONENT_WEIGHT * exactScore +
      SOFT_KEYWORD_COMPONENT_WEIGHT * softScore
  );
}

function emptyRetrieveResult(): RetrieveResult {
  return {
    chunk_index: -1,
    guiding_question: "",
    answer_focus: "",
    chunk: "",
    summary: "",
    sentence_ids: [],
    score: 0,
    cosine_score: 0,
  };
}

function rankedChunkToResult(
  item: RankedChunk,
  chunkText?: string
): RetrieveResult {
  const safeScore = Math.min(
    Math.max(item.score, 0),
    0.999
  );

  const safeSemanticScore = Math.min(
    Math.max(item.semanticScore, 0),
    0.999
  );

  return {
    chunk_index: item.idx,
    guiding_question: String(
      item.chunk.guiding_question || ""
    ).trim(),
    answer_focus: "",
    chunk: String(
      chunkText ?? item.chunk.text ?? ""
    ),
    summary: String(
      item.chunk.summary || ""
    ).trim(),
    sentence_ids: item.sentenceIds,
    score: safeScore,
    cosine_score: safeSemanticScore,
  };
}

function buildRankingContext(
  question: string,
  chunks: Chunk[],
  options?: RetrieveOptions
): RankingContext {
  const queryKeywords = extractSoftKeywords(
    question,
    options
  );

  const keywordDf =
    buildSoftKeywordDocumentFrequency(
      queryKeywords,
      chunks
    );

  const rareQueryKeywords =
    filterRareQueryKeywords(
      queryKeywords,
      keywordDf,
      chunks.length
    );

  return {
    queryKeywords,
    rareQueryKeywords,
    keywordDf,
  };
}

function logRankingContext(
  context: RankingContext
): void {
  console.log(
    "[SEMANTIC ANCHOR QUERY KEYWORDS]",
    JSON.stringify(
      {
        queryKeywords: context.queryKeywords,
        rareQueryKeywords:
          context.rareQueryKeywords,
        keywordDf: Object.fromEntries(
          context.keywordDf.entries()
        ),
      },
      null,
      2
    )
  );
}

function rankChunks(
  question: string,
  queryEmbedding: number[],
  index: SemanticIndex,
  context: RankingContext,
  options?: RetrieveOptions
): RankedChunk[] {
  const semanticWeight =
    getSemanticWeight(options);

  const anchorWeight =
    1 - semanticWeight;

  return index.chunks
    .map((chunk, idx): RankedChunk => {
      const semantic = semanticScore(
        queryEmbedding,
        chunk
      );

      const exact = exactAnchorScore(
        question,
        chunk,
        options
      );

      const soft = softKeywordScore(
        chunk,
        context.rareQueryKeywords
      );

      const anchor = anchorScore(
        exact,
        soft
      );

      const score =
        semanticWeight * semantic +
        anchorWeight * anchor;

      return {
        idx,
        chunk,
        sentenceIds: getSentenceIds(chunk),
        score,
        semanticScore: semantic,
        anchorScore: anchor,
        exactAnchorScore: exact,
        softKeywordScore: soft,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function logTopCandidates(
  ranked: RankedChunk[],
  limit: number
): void {
  const topItems = ranked.slice(0, limit);

  console.log(
    "[SEMANTIC ANCHOR RETRIEVE TOP 5]",
    JSON.stringify(
      topItems.map((item) => ({
        idx: item.idx,
        score: item.score,
        semanticScore: item.semanticScore,
        anchorScore: item.anchorScore,
        exactAnchorScore:
          item.exactAnchorScore,
        softKeywordScore:
          item.softKeywordScore,
        sentenceIds: item.sentenceIds,
        guidingQuestion: String(
          item.chunk.guiding_question || ""
        ).slice(0, 180),
        summary: String(
          item.chunk.summary || ""
        ).slice(0, 180),
        chunkText: String(
          item.chunk.text || ""
        ).slice(0, 180),
        hasGuidingQuestionEmbedding:
          Array.isArray(
            item.chunk.guiding_question_embedding
          )
            ? item.chunk
                .guiding_question_embedding
                .length > 0
            : false,
      })),
      null,
      2
    )
  );
}

export function buildSemanticIndex(
  corpus: PrepareResult
): SemanticIndex {
  return {
    docId: corpus.docId,
    chunks: corpus.chunks,
    sentences: Array.isArray(
      (corpus as any).sentences
    )
      ? (corpus as any).sentences
      : undefined,
  };
}

export async function retrieveTopK(
  question: string,
  index: SemanticIndex,
  k = DEFAULT_RETRIEVE_K,
  options?: RetrieveOptions
): Promise<RetrieveResult[]> {
  const queryEmbedding = await embedText(question);

  const context = buildRankingContext(
    question,
    index.chunks,
    options
  );

  logRankingContext(context);

  const ranked = rankChunks(
    question,
    queryEmbedding,
    index,
    context,
    options
  );

  const safeK = Math.max(1, k);

  logTopCandidates(
    ranked,
    Math.max(DEFAULT_RETRIEVE_K, safeK)
  );

  return ranked
    .slice(0, safeK)
    .map((item) =>
      rankedChunkToResult(item)
    );
}

export async function retrieveTop(
  question: string,
  index: SemanticIndex,
  options?: RetrieveOptions
): Promise<RetrieveResult> {
  const queryEmbedding = await embedText(question);

  const context = buildRankingContext(
    question,
    index.chunks,
    options
  );

  logRankingContext(context);

  const ranked = rankChunks(
    question,
    queryEmbedding,
    index,
    context,
    options
  );

  logTopCandidates(
    ranked,
    DEFAULT_RETRIEVE_K
  );

  const top = ranked[0];

  if (!top) {
    return emptyRetrieveResult();
  }

  const result = rankedChunkToResult(top);

  console.log(
    "[SEMANTIC ANCHOR RETRIEVE RAW SCORE]",
    top.score,
    "=>",
    result.score
  );

  console.log(
    "[SEMANTIC ANCHOR RETRIEVE RAW SEMANTIC]",
    top.semanticScore,
    "=>",
    result.cosine_score
  );

  return result;
}

export async function retrieveFromPrepared(
  question: string,
  corpus: PrepareResult,
  options?: RetrieveOptions
): Promise<RetrieveResult> {
  const index = buildSemanticIndex(corpus);

  return retrieveTop(
    question,
    index,
    options
  );
}

export async function retrieveCandidatesFromPrepared(
  question: string,
  corpus: PrepareResult,
  k = DEFAULT_RETRIEVE_K,
  options?: RetrieveOptions
): Promise<RetrieveResult[]> {
  const index = buildSemanticIndex(corpus);

  return retrieveTopK(
    question,
    index,
    k,
    options
  );
}