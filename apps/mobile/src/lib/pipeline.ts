import { splitDeterministic, makeChunks, type ChunkParams } from "./splitter";
import { saveCorpusSnapshot, type CorpusSnapshot } from "./snapshot";

/** Deterministic non-crypto doc ID from text (FNV-1a 32-bit, hex). */
export function makeDocId(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `doc_${h.toString(16).padStart(8, "0")}`;
}

/**
 * Build local corpus (split → chunk → snapshot) and persist it.
 * Returns the saved file path and the snapshot object.
 */
export async function buildLocalCorpus(
  docId: string,
  text: string,
  params: ChunkParams
): Promise<{ path: string; snapshot: CorpusSnapshot }> {
  const split = splitDeterministic(docId, text);
  const chunks = makeChunks(split, params);
  const snapshot: CorpusSnapshot = {
    version: 1,
    docId,
    createdAt: Date.now(),
    sentences: split.sentences,
    chunks,
  };
  const path = await saveCorpusSnapshot(snapshot);
  return { path, snapshot };
}
