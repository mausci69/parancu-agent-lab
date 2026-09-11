export type Sentence = {
  id: number;   // stable, 0-based within the document
  text: string; // exact slice from input (trimmed of outer spaces)
  start: number; // char offset in original text (inclusive)
  end: number;   // char offset in original text (exclusive)
};

export type SplitResult = {
  docId: string;
  sentences: Sentence[];
};

/**
 * Deterministic sentence splitter:
 * - Normalises Windows newlines to "\n".
 * - Collapses runs of whitespace to single spaces for boundary detection,
 *   but preserves original offsets by scanning the original string.
 * - Splits on terminal punctuation . ! ? followed by space or end of text.
 * - Keeps abbreviations like "e.g.", "i.e.", "Mr.", "Dr." by not splitting
 *   when the token before the dot is <= 3 letters and next char is lowercase.
 */
export function splitDeterministic(docId: string, raw: string): SplitResult {
  const text = raw.replace(/\r\n?/g, "\n");
  const sentences: Sentence[] = [];

  // Walk the original text and decide boundaries.
  let start = 0;
  let i = 0;

  const isLetter = (c: string) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(c);
  const isLower = (c: string) => /[a-zà-öø-ÿ]/.test(c);

  const pushSentence = (s: number, e: number) => {
    // Trim outer spaces but map back to original offsets.
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) {
      const id = sentences.length;
      sentences.push({ id, text: text.slice(s, e), start: s, end: e });
    }
  };

  const isAbbrevBeforeDot = (idx: number) => {
    // Look backward from idx-1 to find the token before period.
    let j = idx - 1;
    while (j >= 0 && isLetter(text[j])) j--;
    const token = text.slice(j + 1, idx);
    // Common heuristic: 1–3 letters tokens are likely abbreviations.
    return token.length > 0 && token.length <= 3;
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "." || ch === "!" || ch === "?") {
      // Peek next non-space character.
      const next = i + 1 < text.length ? text[i + 1] : "";
      const nextAfterSpaces = (() => {
        let k = i + 1;
        while (k < text.length && /\s/.test(text[k])) k++;
        return k < text.length ? text[k] : "";
      })();

      // Abbreviation guard for dot.
      if (ch === "." && isAbbrevBeforeDot(i) && isLower(nextAfterSpaces)) {
        i++;
        continue;
      }

      // Boundary if followed by space/newline or end of text.
      if (next === " " || next === "\n" || next === "") {
        pushSentence(start, i + 1);
        // Move start to first non-space after punctuation.
        let k = i + 1;
        while (k < text.length && /\s/.test(text[k])) k++;
        start = k;
        i = k;
        continue;
      }
    }

    i++;
  }

  // Tail
  if (start < text.length) {
    pushSentence(start, text.length);
  }

  return { docId, sentences };
}

export type Chunk = {
  id: string;        // {docId}:{startSentence}-{endSentence}
  docId: string;
  sentStart: number; // inclusive
  sentEnd: number;   // inclusive
  text: string;
};

export type ChunkParams = {
  windowSize: number; // e.g. 6
  stride: number;     // e.g. 2
  maxChars?: number;  // optional hard cap per chunk
};

export function makeChunks(split: SplitResult, params: ChunkParams): Chunk[] {
  const { windowSize, stride, maxChars } = params;
  const chunks: Chunk[] = [];
  const total = split.sentences.length;
  const docId = split.docId;

  if (total === 0 || windowSize <= 0 || stride <= 0) return chunks;

  for (let s = 0; s < total; s += stride) {
    const e = Math.min(s + windowSize, total);
    const subset = split.sentences.slice(s, e);
    if (subset.length === 0) continue;

    const joined = subset.map(x => x.text).join(" ").trim();
    if (!joined) continue;
    if (maxChars && joined.length > maxChars) continue;

    const startId = subset[0].id;
    const endId = subset[subset.length - 1].id;
    chunks.push({
      id: `${docId}:${startId}-${endId}`,
      docId,
      sentStart: startId,
      sentEnd: endId,
      text: joined,
    });

    if (e >= total) break;
  }

  return chunks;
}