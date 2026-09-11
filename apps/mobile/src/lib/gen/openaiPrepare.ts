// /apps/mobile/src/lib/gen/openaiPrepare.ts

// British English comments.
// Direct mobile-side OpenAI metadata enrichment for EcoSearch v1 preparation.
// The API key is loaded from local device storage, after the user provides it.
// Flow:
// chunk -> grounded summary + grounded guiding question + answer focus
// -> local guiding question embedding + local answer focus embedding

import type { Chunk, PrepareResult } from "../../local/prepareCorpus";
import { loadOpenAIKey } from "../../local/openaiKeyStore";
import { embedMany } from "../embeddings";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const OPENAI_MODEL =
  process.env.EXPO_PUBLIC_OPENAI_MODEL ?? "gpt-5.4-mini";

export type CorpusLanguage = "en" | "it";

const CORPUS_LANGUAGE_LABELS: Record<CorpusLanguage, string> = {
  en: "English",
  it: "Italian",
};

type EnrichPreparedCorpusOptions = {
  corpusLanguage?: CorpusLanguage;
};

type ChunkMetadata = {
  summary: string;
  guidingQuestion: string;
  answerFocus: string;
};

console.log("OPENAI MODEL:", OPENAI_MODEL);

async function getOpenAIKey(): Promise<string> {
  const key = await loadOpenAIKey();

  if (!key) {
    throw new Error(
      "Missing OpenAI API key. Add your key in Manage corpus before preparing a corpus."
    );
  }

  return key;
}

function extractTextFromResponse(payload: any): string {
  if (
    typeof payload?.output_text === "string" &&
    payload.output_text.trim()
  ) {
    return payload.output_text.trim();
  }

  const parts: string[] = [];

  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      if (!Array.isArray(item?.content)) {
        continue;
      }

      for (const content of item.content) {
        if (
          typeof content?.text === "string" &&
          content.text.trim()
        ) {
          parts.push(content.text.trim());
        }
      }
    }
  }

  return parts.join("\n").trim();
}

function cleanOneLine(value: string): string {
  return String(value || "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\s*[-•*\d.)]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function limitGuidingQuestionWords(
  value: string,
  maxWords = 10
): string {
  const clean = cleanOneLine(value);
  const words = clean.split(/\s+/).filter(Boolean);

  if (words.length <= maxWords) {
    return clean;
  }

  return (
    words
      .slice(0, maxWords)
      .join(" ")
      .replace(/[,.!?;:]+$/, "") + "?"
  );
}

function limitAnswerFocus(
  value: string,
  maxCharacters = 120
): string {
  const clean = cleanOneLine(value).replace(/[.?!;:]+$/, "");

  if (clean.length <= maxCharacters) {
    return clean;
  }

  return clean
    .slice(0, maxCharacters)
    .replace(/\s+\S*$/, "")
    .trim();
}

function buildLanguageInstruction(
  corpusLanguage: CorpusLanguage
): string {
  const languageLabel =
    CORPUS_LANGUAGE_LABELS[corpusLanguage];

  return [
    `The selected corpus language is ${languageLabel}.`,
    `Write strictly in ${languageLabel}.`,
    "Do not switch language.",
    "Return only the requested text, with no explanation.",
  ].join("\n");
}

function buildFallbackQuestion(
  corpusLanguage: CorpusLanguage
): string {
  if (corpusLanguage === "it") {
    return "Qual è l'informazione principale del passaggio?";
  }

  return "What is the main information in the passage?";
}

function buildFallbackAnswerFocus(
  corpusLanguage: CorpusLanguage
): string {
  if (corpusLanguage === "it") {
    return "informazione principale del passaggio";
  }

  return "main information in the passage";
}

function parseChunkMetadata(
  raw: string,
  corpusLanguage: CorpusLanguage
): ChunkMetadata {
  const fallbackSummary = cleanOneLine(raw).slice(0, 240);

  const fallback: ChunkMetadata = {
    summary: fallbackSummary,
    guidingQuestion:
      buildFallbackQuestion(corpusLanguage),
    answerFocus:
      fallbackSummary ||
      buildFallbackAnswerFocus(corpusLanguage),
  };

  try {
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    const summary = cleanOneLine(parsed?.summary);

    const guidingQuestion =
      limitGuidingQuestionWords(
        cleanOneLine(parsed?.guiding_question)
      );

    const answerFocus = limitAnswerFocus(
      cleanOneLine(parsed?.answer_focus)
    );

    if (
      !summary ||
      !guidingQuestion ||
      !answerFocus
    ) {
      return fallback;
    }

    return {
      summary,
      guidingQuestion,
      answerFocus,
    };
  } catch {
    return fallback;
  }
}

async function callOpenAIText(
  system: string,
  user: string,
  errorLabel: string
): Promise<string> {
  const apiKey = await getOpenAIKey();

  const response = await fetch(
    OPENAI_RESPONSES_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: system,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: user,
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `${errorLabel}: HTTP ${response.status} ${errorText}`
    );
  }

  const payload = await response.json();

  return extractTextFromResponse(payload);
}

async function generateChunkMetadata(
  chunkText: string,
  corpusLanguage: CorpusLanguage
): Promise<ChunkMetadata> {
  const languageInstruction =
    buildLanguageInstruction(corpusLanguage);

  const system = [
    "You prepare retrieval metadata for an answerability-first search system.",
    languageInstruction,
    "",
    "Critical grounding rules:",
    "Use only facts explicitly stated in the chunk.",
    "Do not use outside knowledge.",
    "Do not infer missing historical relationships.",
    "Do not repair, complete, or enrich the chunk from memory.",
    "The summary must be supported by the chunk text itself.",
    "The guiding question must be directly answerable from the chunk text itself.",
    "The answer focus must describe the exact searchable fact, event, entity, relationship, or concept explicitly supported by the chunk.",
    "If the chunk does not explicitly say who founded something, do not ask who founded it.",
    "If the chunk does not explicitly say when something happened, do not ask when it happened.",
    "If the chunk only mentions a person in another context, do not turn that into a founder, creator, ruler, inventor, or origin question.",
  ].join("\n");

  const user = [
    languageInstruction,
    "",
    "Create retrieval metadata for this chunk.",
    "",
    "Return strict JSON with exactly these keys:",
    '{ "summary": "...", "guiding_question": "...", "answer_focus": "..." }',
    "",
    "Summary rules:",
    "- Maximum 20 words.",
    "- Mention only the main fact explicitly stated in the chunk.",
    "- Do not add names, dates, causes, founders, titles, or outcomes unless they appear in the chunk.",
    "- Do not generalise from nearby historical context.",
    "",
    "Guiding question rules:",
    "- Maximum 10 words.",
    "- Must be answerable directly from the chunk.",
    "- Must target the strongest explicit fact in the chunk.",
    "- Must not ask about information that appears only in general historical knowledge.",
    "- Must not be broader than the chunk.",
    "",
    "Answer focus rules:",
    "- Must not be a question.",
    "- Must be a concise searchable label.",
    "- Prefer a natural noun phrase over a keyword list.",
    "- Preserve meaningful capitalisation.",
    "- Avoid vague labels such as history, background, events, topic, context, or overview.",
    "- Good examples: nascita del Regno di Sicilia; fondazione di BASEBALL; differenza tra SHRDLU ed ELIZA.",
    "- Bad examples: storia della Sicilia; sistemi; eventi storici; informazioni generali.",
    "",
    "Bad example:",
    "If the chunk says Ruggero and Adelaide supported Greek monasteries, do not ask: Chi fondò il Regno di Sicilia?",
    "",
    "Good behaviour:",
    "Ask about Greek monasteries, Troina, bishops, or whatever is explicitly present in that chunk.",
    "The answer_focus should label that same explicit information without turning it into a question.",
    "",
    "Chunk:",
    chunkText,
  ].join("\n");

  const text = await callOpenAIText(
    system,
    user,
    "OpenAI chunk metadata generation failed"
  );

  return parseChunkMetadata(
    text,
    corpusLanguage
  );
}

export async function enrichPreparedCorpusWithOpenAI(
  prepared: PrepareResult,
  options: EnrichPreparedCorpusOptions = {}
): Promise<PrepareResult> {
  const enrichedChunks: Chunk[] = [];

  const corpusLanguage =
    options.corpusLanguage ?? "en";

  console.log("[CORPUS LANGUAGE SELECTED]", {
    corpusLanguage,
    label:
      CORPUS_LANGUAGE_LABELS[corpusLanguage],
  });

  for (const chunk of prepared.chunks) {
    const metadata =
      await generateChunkMetadata(
        chunk.text,
        corpusLanguage
      );

    const summary = metadata.summary;
    const guidingQuestion =
      metadata.guidingQuestion;
    const answerFocus =
      metadata.answerFocus;

    const [
      guidingQuestionEmbedding,
      answerFocusEmbedding,
    ] = await embedMany([
      guidingQuestion,
      answerFocus,
    ]);

    console.log("[PREPARED CHUNK]", {
      chunkId: chunk.id,
      corpusLanguage,
      summary,
      guidingQuestion,
      answerFocus,
      guidingQuestionWords:
        guidingQuestion
          .split(/\s+/)
          .filter(Boolean)
          .length,
      hasGuidingQuestionEmbedding:
        guidingQuestionEmbedding.length > 0,
      hasAnswerFocusEmbedding:
        answerFocusEmbedding.length > 0,
      embeddingEngine:
        "local-multilingual-e5-small-onnx",
    });

    enrichedChunks.push({
      ...chunk,
      summary,
      guiding_question:
        guidingQuestion,
      guiding_question_embedding:
        guidingQuestionEmbedding,
      answer_focus:
        answerFocus,
      answer_focus_embedding:
        answerFocusEmbedding,
    } as Chunk);
  }

  return {
    ...prepared,
    chunks: enrichedChunks,
  };
}