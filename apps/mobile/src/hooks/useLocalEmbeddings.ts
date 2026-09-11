// /apps/mobile/src/hooks/useLocalEmbeddings.ts

// React hook to manage local embeddings state in EcoSearch Mobile.
// Handles model readiness, embedding computation, query similarity, and persistence.

import { useState, useCallback, useEffect } from "react";
import { embedOne, embedMany } from "../lib/embeddings";
import { cosineMatrixQuery, topKIndices } from "../lib/similarity";
import { loadLocalCorpus, saveLocalCorpus } from "../lib/localStore";

export function useLocalEmbeddings() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [embeddings, setEmbeddings] = useState<number[][]>([]);
  const [texts, setTexts] = useState<string[]>([]);

  // Load any previously saved corpus on mount.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const saved = await loadLocalCorpus();
      if (!mounted || !saved) return;
      setTexts(saved.texts);
      setEmbeddings(saved.embeddings);
      setReady(true);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  /** Embed and store corpus texts locally (and persist). */
  const prepare = useCallback(async (input: string[]) => {
    setBusy(true);
    try {
      const vecs = await embedMany(input);
      setEmbeddings(vecs);
      setTexts(input);
      setReady(true);
      await saveLocalCorpus(input, vecs);
    } finally {
      setBusy(false);
    }
  }, []);

  /** Find the top-k most similar corpus entries for a given query string. */
  const query = useCallback(
    async (q: string, k = 3) => {
      if (!ready) throw new Error("Local embeddings not ready");
      const qv = await embedOne(q);
      const sims = cosineMatrixQuery(qv, embeddings);
      const topIdx = topKIndices(sims, k);
      return topIdx.map((i) => ({
        index: i,
        text: texts[i],
        score: sims[i],
      }));
    },
    [ready, embeddings, texts]
  );

  return { ready, busy, prepare, query, texts, embeddings };
}
