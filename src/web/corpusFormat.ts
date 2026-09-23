import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import { assertNoCredentials } from "../../services/parancu-api/src/local/openaiKeyStore";

export const EMBEDDING_MODEL = "multilingual-e5-small";
export const EMBEDDING_DIMENSIONS = 384;
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
export type CorpusExport = {
  formatVersion: 1;
  sourceFilename: string;
  language: "en" | "it";
  createdAt: string;
  embedding: { model: typeof EMBEDDING_MODEL; dimensions: 384 };
  corpus: PrepareResult;
};

function fail(): never {
  throw new Error("Incompatible prepared corpus. Expected complete ParancU metadata, sentence units, and 384-dimensional E5 embeddings.");
}
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== fields.length || !fields.every(key => Object.hasOwn(object, key))) return fail();
  return object;
}
function string(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail();
}
function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail();
}
export function sourceFilename(value: unknown): string {
  string(value);
  if (value.length > 255 || /[\\/\x00-\x1f\x7f]/.test(value) || !value.toLowerCase().endsWith(".txt")) fail();
  return value;
}
function language(value: unknown): "en" | "it" {
  if (value !== "en" && value !== "it") return fail();
  return value;
}
function vector(value: unknown) {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS ||
      !value.every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1.001) ||
      !value.some(n => n !== 0)) fail();
}

export function validatePreparedCorpus(value: unknown): PrepareResult {
  const corpus = record(value, ["docId", "sentences", "chunks"]);
  string(corpus.docId);
  if (corpus.docId.length > 255 || !Array.isArray(corpus.sentences) || !corpus.sentences.length ||
      !Array.isArray(corpus.chunks) || !corpus.chunks.length ||
      corpus.sentences.length > 100000 || corpus.chunks.length > 10000) return fail();
  let previousEnd = 0;
  const sentences = corpus.sentences.map((value, index) => {
    const s = record(value, ["id", "text", "start", "end"]);
    integer(s.id); integer(s.start); integer(s.end); string(s.text);
    if (s.id !== index || s.start < previousEnd || s.end <= s.start || s.text.length > s.end - s.start) fail();
    previousEnd = s.end;
    return s;
  });
  for (const [index, value] of corpus.chunks.entries()) {
    const c = record(value, ["id", "startSentence", "endSentence", "sentence_ids", "text",
      "summary", "guiding_question", "answer_focus", "guiding_question_embedding", "answer_focus_embedding"]);
    integer(c.id); integer(c.startSentence); integer(c.endSentence);
    if (c.id !== index || c.endSentence <= c.startSentence || c.endSentence > sentences.length ||
        !Array.isArray(c.sentence_ids) || c.sentence_ids.length !== c.endSentence - c.startSentence ||
        !c.sentence_ids.every((id, offset) => id === Number(c.startSentence) + offset)) fail();
    for (const field of ["text", "summary", "guiding_question", "answer_focus"]) string(c[field]);
    if (c.text !== sentences.slice(c.startSentence, c.endSentence).map(s => s.text).join(" ")) fail();
    vector(c.guiding_question_embedding);
    vector(c.answer_focus_embedding);
  }
  assertNoCredentials(JSON.stringify(value));
  // All properties were allowlisted. Clone to avoid caller mutations after validation.
  return JSON.parse(JSON.stringify(value)) as PrepareResult;
}

export function importCorpus(value: unknown, fallback: { name: unknown; language: unknown }): CorpusExport {
  let payload: CorpusExport;
  if (value && typeof value === "object" && Object.hasOwn(value, "formatVersion")) {
    const envelope = record(value, ["formatVersion", "sourceFilename", "language", "createdAt", "embedding", "corpus"]);
    if (envelope.formatVersion !== 1) fail();
    const embedding = record(envelope.embedding, ["model", "dimensions"]);
    if (embedding.model !== EMBEDDING_MODEL || embedding.dimensions !== EMBEDDING_DIMENSIONS) fail();
    string(envelope.createdAt);
    if (!Number.isFinite(Date.parse(envelope.createdAt)) ||
        new Date(envelope.createdAt).toISOString() !== envelope.createdAt) fail();
    payload = { formatVersion: 1, sourceFilename: sourceFilename(envelope.sourceFilename),
      language: language(envelope.language), createdAt: envelope.createdAt,
      embedding: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS },
      corpus: validatePreparedCorpus(envelope.corpus) };
  } else {
    // Legacy PrepareResult files have no source metadata. The user supplies language;
    // filename and creation date describe the imported local copy.
    string(fallback.name);
    const name = fallback.name.replace(/(?:\.prepared)?\.json$/i, "") + ".txt";
    payload = { formatVersion: 1, sourceFilename: sourceFilename(name), language: language(fallback.language),
      createdAt: new Date().toISOString(),
      embedding: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS },
      corpus: validatePreparedCorpus(value) };
  }
  assertNoCredentials(JSON.stringify(payload));
  return payload;
}

export function exportFilename(name: string): string {
  const base = name.replace(/\.txt$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? "document-" + base : base;
  return (safe || "document") + ".prepared.json";
}
