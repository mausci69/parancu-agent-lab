// /apps/mobile/src/lib/api.ts

import { postJSON, getJSON, apiUrl } from "./client";
import { prepareCorpusLocal } from "../local/prepareCorpus";
import { loadActiveCorpus, savePreparedCorpus } from "../local/corpusStore";
import {
  retrieveCandidatesFromPrepared,
  retrieveFromPrepared,
  type RetrieveResult,
} from "../local/retrieval";
import { generateAnswerFromChunk } from "../local/localGen";
import {
  enrichPreparedCorpusWithOpenAI,
  type CorpusLanguage,
} from "./gen/openaiPrepare";

// Types

export type OCRResponse = {
  text: string;
  lang_used?: string;
  error?: string;
};

export type QueryResponse = {
  question: string;
  guiding_question: string;
  answer_focus?: string;
  chunk: string;
  summary: string;
  score: number;
  cosine_score: number;
  sentence_ids: number[];
  chunk_index: number;
  candidates?: RetrieveResult[];
  low_confidence?: boolean;
  confidence?: "low" | "medium" | "high";
  error?: string;
  ready?: boolean;
};

export type FallbackResponse = {
  chunk: string;
  score: number;
  start_idx: number;
  error?: string;
};

export type AnswerFromChunkResponse = {
  answer: string;
  note?: string;
  fallback_chunk?: string;
  similarity?: number;
  error?: string;
};

export type HealthResponse = {
  status: "ok";
  llm_enabled: boolean;
  ocr_lang: string;
  ocr_ready: boolean;
};

export type OCRPagesResponse = {
  text: string;
  pages: string[];
  page_count: number;
  lang_used: string;
};

export type PrepareCorpusOptions = {
  corpusLanguage?: CorpusLanguage;
};

// === OCR endpoints ===

export async function ocrExtract(
  _form: FormData,
  _optsOrReturnPdf?: boolean | { lang?: string; returnPdf?: boolean }
): Promise<never> {
  throw new Error("Server OCR is disabled in mobile-only mode.");
}

export async function ocrExtractPages(
  _form: FormData,
  _opts?: { lang?: string; returnPdf?: boolean }
): Promise<never> {
  throw new Error("Server OCR is disabled in mobile-only mode.");
}

/**
 * Mobile-only OCR:
 * local ML Kit only.
 * If native OCR is unavailable in the current runtime, fail explicitly.
 */
export async function ocrExtractPagesSmart(
  images: { uri: string; name?: string }[],
  _serverForm: FormData,
  opts?: { lang?: "en" | "it"; returnPdf?: boolean }
): Promise<OCRPagesResponse & { engine: "mlkit" }> {
  const { mlkitExtractPages } = await import("./ocrLocal");

  const res = await mlkitExtractPages(
    images.map((i) => i.uri),
    opts?.lang as any
  );

  const text = String(res?.text ?? "").trim();

  const pages = Array.isArray(res?.pages)
    ? res.pages.map((p: any) => (p?.ok ? String(p.text ?? "") : ""))
    : [];

  if (!text) {
    throw new Error(
      "Local OCR is unavailable or returned no usable text in this build."
    );
  }

  return {
    text,
    pages,
    page_count: images.length,
    lang_used: (opts?.lang as any) || "en",
    engine: "mlkit",
  };
}

// === Query endpoints ===

export async function query(question: string): Promise<QueryResponse> {
  const q = (question || "").trim();

  const corpus = await loadActiveCorpus();

  if (!corpus) {
    return {
      question: q,
      guiding_question: "",
      answer_focus: "",
      chunk: "",
      summary: "",
      score: 0,
      cosine_score: 0,
      sentence_ids: [],
      chunk_index: -1,
      candidates: [],
      error: "No active corpus",
      ready: false,
    };
  }

  const res = await retrieveFromPrepared(q, corpus);
  const candidates = await retrieveCandidatesFromPrepared(q, corpus, 5);
  const low = typeof res.score === "number" && res.score < 0.08;

  return {
    question: q,
    guiding_question: res.guiding_question,
    answer_focus: res.answer_focus,
    chunk: res.chunk,
    summary: res.summary,
    score: res.score,
    cosine_score: res.cosine_score,
    sentence_ids: res.sentence_ids,
    chunk_index: res.chunk_index,
    candidates,
    low_confidence: low,
    ready: true,
  };
}

export async function fallback(_question: string): Promise<FallbackResponse> {
  return {
    chunk: "",
    score: 0,
    start_idx: -1,
    error: "Server fallback is disabled in mobile-only mode.",
  };
}

export async function answerFromChunk(
  question: string,
  chunk: string
): Promise<AnswerFromChunkResponse> {
  const q = (question || "").trim();
  const c = String(chunk || "");

  if (!c) {
    return {
      answer: "",
      error: "Empty chunk",
    };
  }

  const res = generateAnswerFromChunk(q, c);
  return {
    answer: res.answer,
    note: res.note,
    similarity: res.similarity,
  };
}

export async function answerFromFallbackChunk(
  _question: string,
  _chunk: string
): Promise<AnswerFromChunkResponse> {
  return {
    answer: "",
    error: "Server fallback answer is disabled in mobile-only mode.",
  };
}

export async function health(): Promise<HealthResponse> {
  return {
    status: "ok",
    llm_enabled: true,
    ocr_lang: "en",
    ocr_ready: true,
  };
}

// === Prepare corpus ===

export type PrepareCorpusResponse = {
  ready: boolean;
  status?: string;
  message?: string;
  chunks?: number;
  index_size?: number;
};

function cleanOcrText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/([a-z0-9,;:])\n([a-z0-9])/gi, "$1 $2")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Mobile-only corpus preparation.
 *
 * The selected app language is also used as the corpus enrichment language.
 * Query language remains independent and can still be cross-lingual.
 */
export async function prepareCorpusFromText(
  text: string,
  useRerankOrTimeout: boolean | number = 300000,
  maybeTimeout?: number,
  options: PrepareCorpusOptions = {}
): Promise<PrepareCorpusResponse> {
  const bodyText = (text || "").trim();
  let _timeout = 300000;

  if (typeof useRerankOrTimeout === "number") {
    _timeout = useRerankOrTimeout;
  } else if (typeof maybeTimeout === "number") {
    _timeout = maybeTimeout;
  }

  if (!bodyText) {
    return {
      ready: false,
      status: "error",
      message: "Empty text. Provide non-empty text to prepare corpus.",
      chunks: 0,
      index_size: 0,
    };
  }

  const cleanedText = cleanOcrText(bodyText);

  const sentenceCount = cleanedText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean).length;

  if (sentenceCount < 4) {
    return {
      ready: false,
      status: "error",
      message: `Corpus too short. ParancU needs at least 4 sentences to prepare a reliable corpus. Found ${sentenceCount}.`,
      chunks: 0,
      index_size: 0,
    };
  }

  const corpusLanguage = options.corpusLanguage ?? "en";

  console.log("[PREPARE CORPUS FROM TEXT]", {
    corpusLanguage,
    sentenceCount,
  });

  const prepared = prepareCorpusLocal(cleanedText, {
    sentencesPerChunk: 3,
    overlap: 2,
  });

  const enriched = await enrichPreparedCorpusWithOpenAI(prepared, {
    corpusLanguage,
  });

  await savePreparedCorpus(enriched);

  return {
    ready: true,
    status: "ok-local",
    message: "Local corpus prepared and enriched with guiding questions.",
    chunks: enriched.chunks.length,
    index_size: enriched.chunks.length,
  };
}

// Kept only for compatibility with existing imports.
export { apiUrl, getJSON, postJSON };