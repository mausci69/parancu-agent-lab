import { WebError } from "./webError";

export type WebLimits = Readonly<{
  maxTextBytes: number; maxImportBytes: number; maxChunks: number; maxCorpora: number;
  maxPreparations: number; maxQuestions: number; maxRetrievals: number;
}>;
export const DEFAULT_WEB_LIMITS: WebLimits = Object.freeze({
  maxTextBytes: 1024 * 1024,
  maxImportBytes: 8 * 1024 * 1024,
  maxChunks: 256,
  maxCorpora: 32,
  maxPreparations: 1,
  maxQuestions: 2,
  maxRetrievals: 2
});
export const QUESTION_REQUEST_BYTES = 32 * 1024;
export const TXT_ENVELOPE_BYTES = 4096;
const variables: Record<keyof WebLimits, string> = {
  maxTextBytes: "WEB_MAX_TEXT_BYTES", maxImportBytes: "WEB_MAX_IMPORT_BYTES",
  maxChunks: "WEB_MAX_CHUNKS", maxCorpora: "WEB_MAX_CORPORA",
  maxPreparations: "WEB_MAX_PREPARATIONS", maxQuestions: "WEB_MAX_QUESTIONS",
  maxRetrievals: "WEB_MAX_RETRIEVALS"
};

export function readWebLimits(env: NodeJS.ProcessEnv = process.env): WebLimits {
  const limits = { ...DEFAULT_WEB_LIMITS };
  for (const key of Object.keys(variables) as Array<keyof WebLimits>) {
    const raw = env[variables[key]];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${variables[key]} must be a positive safe integer.`);
    }
    limits[key] = value;
  }
  // Leave room for JSON escaping and the small upload envelope without overflow.
  if (limits.maxTextBytes > Math.floor((Number.MAX_SAFE_INTEGER - TXT_ENVELOPE_BYTES) / 6)) {
    throw new Error("WEB_MAX_TEXT_BYTES is too large.");
  }
  return Object.freeze(limits);
}

/** No waiting list. A lease is idempotent and belongs to exactly one operation. */
export class AdmissionGate {
  private active = 0;
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid admission limit.");
  }
  assertAvailable() {
    if (this.active >= this.limit) throw new WebError(429, "Operation capacity reached. Try again later.");
  }
  acquire(): () => void {
    this.assertAvailable();
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
  async run<T>(work: () => T | Promise<T>): Promise<T> {
    const release = this.acquire();
    try { return await work(); }
    finally { release(); }
  }
}

/** One instance is shared by every production web-runtime component. */
export class WebResources {
  readonly preparations: AdmissionGate;
  readonly questions: AdmissionGate;
  readonly retrievals: AdmissionGate;
  readonly ingestion: AdmissionGate;
  readonly limits: WebLimits;
  constructor(limits: WebLimits = DEFAULT_WEB_LIMITS) {
    for (const key of Object.keys(DEFAULT_WEB_LIMITS) as Array<keyof WebLimits>) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new Error("Invalid web resource limits.");
    }
    if (limits.maxTextBytes > Math.floor((Number.MAX_SAFE_INTEGER - TXT_ENVELOPE_BYTES) / 6)) throw new Error("Invalid TXT limit.");
    this.limits = Object.freeze({ ...limits });
    this.preparations = new AdmissionGate(limits.maxPreparations);
    this.questions = new AdmissionGate(limits.maxQuestions);
    this.retrievals = new AdmissionGate(limits.maxRetrievals);
    // Bound upload/import body buffering and import persistence as well as jobs.
    this.ingestion = new AdmissionGate(limits.maxPreparations);
  }
  checkText(value: unknown): void {
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > this.limits.maxTextBytes) {
      throw new WebError(413, "The document exceeds the configured TXT byte limit.");
    }
  }
  checkChunks(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const corpus = Object.hasOwn(record, "formatVersion") ? record.corpus : record;
    if (corpus && typeof corpus === "object" && "chunks" in corpus &&
        Array.isArray(corpus.chunks) && corpus.chunks.length > this.limits.maxChunks) {
      throw new WebError(413, "The corpus exceeds the configured chunk limit.");
    }
  }
}
