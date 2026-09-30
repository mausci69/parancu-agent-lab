import { importCorpus, exportFilename, MAX_IMPORT_BYTES, type CorpusExport } from "../corpusFormat";
import { retrieveCandidatesFromPrepared } from "../../../services/parancu-api/src/local/retrieval.js";

export { exportFilename };
export function importPrepared(text: string, name: string, language: string): CorpusExport {
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) throw new Error("The corpus exceeds the 32 MiB import limit.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Invalid JSON. Choose a complete ParancU prepared-corpus file."); }
  const chunks = (value as any)?.corpus?.chunks ?? (value as any)?.chunks;
  if (Array.isArray(chunks) && chunks.length > 256) throw new Error("The corpus exceeds the 256 chunk browser limit.");
  return importCorpus(value, { name, language });
}

export async function retrieve(question: string, payload: CorpusExport) {
  if (!question.trim() || question.length > 4000) throw new Error("Provide a question between 1 and 4,000 characters.");
  const candidates = await retrieveCandidatesFromPrepared(question.trim(), payload.corpus, 5);
  return {
    result: { action: "retrieval_only", question: question.trim() },
    retrievedEvidence: candidates.map((candidate, index) => ({
      chunkIndex: candidate.chunk_index, text: candidate.chunk, summary: candidate.summary,
      candidateRank: index + 1, score: candidate.score, status: "not_evaluated"
    }))
  };
}
