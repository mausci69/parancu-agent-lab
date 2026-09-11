// Local persistence for offline corpus embeddings.
// Uses AsyncStorage; later we can swap to SQLite if needed.
// British English comments.

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "ecosearch.local.corpus.v1";

export type LocalCorpus = {
  texts: string[];          // raw passages/chunks
  embeddings: number[][];   // parallel array of vectors
  savedAt: string;          // ISO timestamp
};

/** Save corpus texts and embeddings locally. */
export async function saveLocalCorpus(texts: string[], embeddings: number[][]): Promise<void> {
  const payload: LocalCorpus = {
    texts,
    embeddings,
    savedAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(KEY, JSON.stringify(payload));
}

/** Load corpus from device; returns null if absent or invalid. */
export async function loadLocalCorpus(): Promise<LocalCorpus | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as LocalCorpus;
    if (!Array.isArray(obj.texts) || !Array.isArray(obj.embeddings)) return null;
    return obj;
  } catch {
    return null;
  }
}

/** Remove stored corpus completely. */
export async function clearLocalCorpus(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

