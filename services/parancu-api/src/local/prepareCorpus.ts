// /apps/mobile/src/local/prepareCorpus.ts

// v1-shaped local preparation primitives:
// - Deterministic sentence splitter
// - Overlapping sentence chunker
// - Pure functions only; LLM enrichment arrives later

export type Sentence = {
  id: number;
  text: string;
  start: number;
  end: number;
};

export type Chunk = {
  id: number;
  startSentence: number;
  endSentence: number;
  sentence_ids: number[];
  text: string;
  summary?: string;
  guiding_question?: string;
  guiding_question_embedding?: number[];
  answer_focus?: string;
  answer_focus_embedding?: number[];
};

export type PrepareOptions = {
  docId?: string;
  sentencesPerChunk?: number; // default 3
  overlap?: number; // default 2
};

export type PrepareResult = {
  docId: string;
  sentences: Sentence[];
  chunks: Chunk[];
};

export function splitDeterministic(raw: string): Sentence[] {
  const text = raw.replace(/\r\n?/g, "\n");
  const rough: Sentence[] = [];

  let start = 0;
  let sid = 0;

  const push = (sStart: number, sEnd: number) => {
    const slice = text.slice(sStart, sEnd).trim();
    if (!slice) return;

    const leading = text.slice(sStart, sEnd).match(/^\s*/)?.[0].length ?? 0;
    const trailing = text.slice(sStart, sEnd).match(/\s*$/)?.[0].length ?? 0;
    const absStart = sStart + leading;
    const absEnd = sEnd - trailing;

    rough.push({
      id: sid++,
      text: text.slice(absStart, absEnd),
      start: absStart,
      end: absEnd,
    });
  };

  const isUnsafeDotBoundary = (idx: number): boolean => {
    const before = text.slice(Math.max(0, idx - 12), idx + 1);
    const nextWord = pickTokenAfter(text, idx + 1);

    if (!nextWord) return false;

    const abbreviationBeforeDot = pickAbbreviationBeforeDot(text, idx);

    if (
      [
        "e.g.",
        "i.e.",
        "etc.",
        "fig.",
        "u.c.",
        "dr.",
        "mr.",
        "mrs.",
        "ms.",
        "prof.",
        "st.",
      ].includes(abbreviationBeforeDot)
    ) {
      return true;
    }

    if (/[A-Z]\.[A-Z]\.$/.test(before)) return true;
    if (/[A-Z]\.$/.test(before) && /^[A-Z][a-z]/.test(nextWord)) return true;

    return false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    const next = text[i + 1] ?? "";
    const boundaryFollows = next === " " || next === "\n" || next === "";

    if (!boundaryFollows) continue;

    if (ch === "." && isUnsafeDotBoundary(i)) {
      continue;
    }

    push(start, i + 1);

    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    start = j;
  }

  if (start < text.length) push(start, text.length);

  const merged: Sentence[] = [];
  let buffer: Sentence | null = null;

  const shouldMerge = (prev: Sentence, curr: Sentence): boolean => {
    const prevText = prev.text.trim();
    const currText = curr.text.trim();

    if (!currText) return false;

    const startsLower = /^[a-z]/.test(currText);
    const continuation =
      /^(and|or|but|since|because|which|that|whereas|while)\b/i.test(currText);

    const prevLooksUnfinished =
      /[,;:]$/.test(prevText) ||
      /\b(of|in|at|by|to|from|with|using|including|such as)$/i.test(prevText);

    const currIsKnownFragment =
      /^(alternatively|in \d{4}|berkeley\b|natural language\b)/i.test(currText);

    return (
      startsLower ||
      continuation ||
      prevLooksUnfinished ||
      currIsKnownFragment
    );
  };

  for (const s of rough) {
    if (!buffer) {
      buffer = { ...s };
      continue;
    }

    if (shouldMerge(buffer, s)) {
      buffer = {
        id: buffer.id,
        text: `${buffer.text} ${s.text}`,
        start: buffer.start,
        end: s.end,
      };
    } else {
      merged.push(buffer);
      buffer = { ...s };
    }
  }

  if (buffer) merged.push(buffer);

  return merged.map((s, idx) => ({ ...s, id: idx }));
}

function pickTokenBefore(s: string, idx: number): string {
  let i = idx - 1;
  while (i >= 0 && /\s/.test(s[i])) i--;

  let token = "";
  while (i >= 0 && /[A-Za-z]/.test(s[i])) {
    token = s[i] + token;
    i--;
  }
  return token;
}

function pickAbbreviationBeforeDot(s: string, idx: number): string {
  let i = idx;
  let value = "";

  while (i >= 0 && /[A-Za-z.]/.test(s[i])) {
    value = s[i] + value;
    i--;
  }

  return value.toLowerCase();
}

/**
 * v1-style overlapping chunker.
 * Defaults:
 * - 3 sentences per chunk
 * - overlap of 2 sentences
 * This means stride 1, matching the old laptop behaviour.
 */

function pickTokenAfter(s: string, idx: number): string {
  let i = idx;
  while (i < s.length && /\s/.test(s[i])) i++;

  let token = "";
  while (i < s.length && /[A-Za-z]/.test(s[i])) {
    token += s[i];
    i++;
  }

  return token;
}

export function makeChunks(
  sentences: Sentence[],
  sentencesPerChunk = 3,
  overlap = 2
): Chunk[] {
  const chunks: Chunk[] = [];
  if (sentences.length === 0) return chunks;

  const safeChunkSize = Math.max(1, sentencesPerChunk);
  const safeOverlap = Math.max(0, Math.min(overlap, safeChunkSize - 1));
  const stride = Math.max(1, safeChunkSize - safeOverlap);

  let cid = 0;
  let i = 0;

  while (i < sentences.length) {
    const current = sentences.slice(i, i + safeChunkSize);
    if (current.length === 0) break;

    if (current.length < safeChunkSize && chunks.length > 0) {
      break;
    }

    const startSentence = current[0].id;
    const endSentence = current[current.length - 1].id + 1;
    const sentence_ids = current.map((s) => s.id);
    const text = current.map((s) => s.text).join(" ");

    chunks.push({
      id: cid++,
      startSentence,
      endSentence,
      sentence_ids,
      text,
      summary: "",
      guiding_question: "",
      answer_focus: "",
    });

    i += stride;
  }

  return chunks;
}

export function prepareCorpusLocal(
  raw: string,
  opts: PrepareOptions = {}
): PrepareResult {
  const docId = opts.docId ?? `local-${Date.now()}`;
  const sentences = splitDeterministic(raw);
  const chunks = makeChunks(
    sentences,
    opts.sentencesPerChunk ?? 3,
    opts.overlap ?? 2
  );

  return { docId, sentences, chunks };
}