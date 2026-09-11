// apps/mobile/src/local/localGen.ts
// British English comments.
// Heuristic "local generator" to craft a short answer from a retrieved chunk,
// without using an LLM. It selects the sentence with the strongest lexical
// overlap with the question and optionally appends a second supporting sentence.

export type LocalGenOptions = {
  minTokenLength?: number;   // ignore very short tokens; default 2
  maxAnswerChars?: number;   // clamp final answer length; default 280
  addSupportSentence?: boolean; // include a second sentence if helpful; default true
};

export type LocalGenResult = {
  answer: string;
  similarity: number;  // 0..1 proxy based on token overlap
  note?: string;       // brief explanation for transparency
};

const DEFAULT_OPTS: Required<LocalGenOptions> = {
  minTokenLength: 2,
  maxAnswerChars: 280,
  addSupportSentence: true,
};

const STOPWORDS = new Set<string>([
  // EN
  "the","a","an","and","or","but","if","then","else","when","while","to","of","in",
  "on","for","with","as","by","at","from","that","this","these","those","is","are",
  "was","were","be","been","being","it","its","into","about","than","so","not",
  "no","yes","can","could","should","would","do","does","did","done","over","under",
  // IT
  "il","lo","la","i","gli","le","un","uno","una","e","o","ma","se","allora","mentre",
  "di","a","da","in","con","su","per","tra","fra","è","era","sono","sei","siamo",
  "siete","stato","stata","stati","state","non","sì","che","questo","questa","queste",
  "quello","quella","quelli","quelle","nel","nella","della","delle","degli","dei"
]);

/** Lowercase tokeniser with diacritic strip and stopword removal. */
function tokenise(s: string, minLen: number): string[] {
  const norm = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  return norm
    .split(/[^a-z0-9àèéìíòóùú]+/i)
    .filter(t => t.length >= minLen && !STOPWORDS.has(t));
}

/** Split into simple sentences based on punctuation. */
function splitSentences(text: string): string[] {
  // Keep it robust but simple; later we can share splitter with prepareCorpus if needed.
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Jaccard similarity on token sets as a cheap semantic proxy. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return inter / uni;
}

/** Score each sentence by overlap with the question tokens. */
function scoreSentences(questionTokens: Set<string>, sentences: string[], minLen: number) {
  return sentences.map((s, idx) => {
    const toks = new Set(tokenise(s, minLen));
    const sim = jaccard(questionTokens, toks);
    return { idx, text: s, sim };
  });
}

/** Clamp to a maximum number of characters, attempting to cut at word boundary. */
function clampText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + "…";
}

/**
 * Produce a short answer by selecting the highest-overlap sentence and,
 * optionally, a supporting neighbour if it adds signal.
 */
export function generateAnswerFromChunk(
  question: string,
  chunk: string,
  options: LocalGenOptions = {}
): LocalGenResult {
  const opts = { ...DEFAULT_OPTS, ...options };
  const qTokens = new Set(tokenise(question, opts.minTokenLength));
  const sentences = splitSentences(chunk);

  if (sentences.length === 0) {
    return { answer: "", similarity: 0, note: "No sentences in chunk." };
  }

  const scored = scoreSentences(qTokens, sentences, opts.minTokenLength)
    .sort((a, b) => b.sim - a.sim);

  const best = scored[0];
  let answer = best.text;
  let sim = best.sim;

  if (opts.addSupportSentence) {
    // Consider immediate neighbours; pick the one with higher similarity.
    const neighbours: { text: string; sim: number }[] = [];
    const leftIdx = best.idx - 1;
    const rightIdx = best.idx + 1;

    if (leftIdx >= 0) {
      const lSim = jaccard(qTokens, new Set(tokenise(sentences[leftIdx], opts.minTokenLength)));
      neighbours.push({ text: sentences[leftIdx], sim: lSim });
    }
    if (rightIdx < sentences.length) {
      const rSim = jaccard(qTokens, new Set(tokenise(sentences[rightIdx], opts.minTokenLength)));
      neighbours.push({ text: sentences[rightIdx], sim: rSim });
    }

    if (neighbours.length > 0) {
      neighbours.sort((a, b) => b.sim - a.sim);
      const bestNeighbour = neighbours[0];
      if (bestNeighbour.sim > 0 && (answer + " " + bestNeighbour.text).length <= opts.maxAnswerChars) {
        answer = `${answer} ${bestNeighbour.text}`;
        // take the max as a rough proxy for combined signal
        sim = Math.max(sim, bestNeighbour.sim);
      }
    }
  }

  answer = clampText(answer, opts.maxAnswerChars);

  const note =
    sim < 0.08
      ? "Low lexical overlap; consider online fallback."
      : sim < 0.18
      ? "Moderate overlap; answer may be approximate."
      : "High overlap; answer likely relevant.";

  return { answer, similarity: sim, note };
}

