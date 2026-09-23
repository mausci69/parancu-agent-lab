import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import { assertNoCredentials } from "../../services/parancu-api/src/local/openaiKeyStore";
import { importCorpus, validatePreparedCorpus, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, type CorpusExport } from "./corpusFormat";

export type Language = "en" | "it";
export type CorpusInfo = {
  id: string;
  name: string;
  language: Language;
  status: "preparing" | "ready" | "failed";
  createdAt: string;
  sourceHash: string;
  origin?: "txt" | "imported";
  sentences?: number;
  chunks?: number;
  error?: string;
};
export type PreparationDependencies = {
  prepare: (text: string, options: { docId: string }) => PrepareResult;
  enrich: (corpus: PrepareResult, options: { corpusLanguage: Language }) => Promise<PrepareResult>;
};
type Entry = { info: CorpusInfo; corpus?: PrepareResult };
export const MAX_TEXT_BYTES = 1024 * 1024;
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class WebError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Local store for trusted, server-generated corpora. Never uses uploaded names as paths. */
export class CorpusStore {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly dependencies: PreparationDependencies,
    private readonly reportError: (error: unknown) => void = console.error,
    private readonly checkContent: (value: unknown) => void = value =>
      assertNoCredentials(JSON.stringify(value), [process.env.OPENAI_API_KEY?.trim()])
  ) {}

  create(input: { name: string; text: string; language: Language }): CorpusInfo {
    this.checkContent(input);
    if (typeof input.name !== "string" || !input.name.toLowerCase().endsWith(".txt") ||
        input.name.length > 255 || /[\\/\x00-\x1f]/.test(input.name)) {
      throw new WebError(400, "Select a .txt file with a valid name.");
    }
    if (typeof input.text !== "string" || !input.text.trim() || input.text.includes("\0")) {
      throw new WebError(400, "The file must contain non-empty text with no NUL characters.");
    }
    if (Buffer.byteLength(input.text, "utf8") > MAX_TEXT_BYTES) {
      throw new WebError(413, "The document size limit is 1 MiB.");
    }
    if (input.language !== "en" && input.language !== "it") {
      throw new WebError(400, "Document language must be Italian or English.");
    }
    if (this.pending.size) throw new WebError(409, "A document is already being prepared. Wait for it to finish.");
    const info: CorpusInfo = {
      id: randomUUID(), name: input.name, language: input.language, status: "preparing", origin: "txt",
      createdAt: new Date().toISOString(),
      sourceHash: createHash("sha256").update(input.text).digest("hex")
    };
    const entry: Entry = { info };
    this.entries.set(info.id, entry);
    // Delay work until after the preparing entry exists and the HTTP handler can respond.
    const task = Promise.resolve().then(() => this.prepare(entry, input.text));
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return { ...info };
  }

  private async prepare(entry: Entry, text: string): Promise<void> {
    try {
      const prepared = this.dependencies.prepare(text, { docId: entry.info.id });
      if (!prepared.chunks.length) throw new Error("Preparation returned no chunks.");
      const corpus = await this.dependencies.enrich(prepared, { corpusLanguage: entry.info.language });
      const info: CorpusInfo = {
        ...entry.info, status: "ready", sentences: corpus.sentences.length, chunks: corpus.chunks.length
      };
      await this.persist(info, corpus);
      entry.corpus = corpus;
      entry.info = info;
    } catch (error) {
      this.reportError(new Error("Corpus preparation failed."));
      entry.info = { ...entry.info, status: "failed", error: "Preparation failed. Check the server terminal, then start preparation again." };
    }
  }

  private async persist(info: CorpusInfo, corpus: PrepareResult): Promise<void> {
    this.checkContent({ info, corpus });
    await mkdir(this.directory, { recursive: true });
    const destination = path.join(this.directory, `${info.id}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ info, corpus }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      try { await unlink(temporary); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.reportError(new Error("Temporary corpus cleanup failed."));
      }
    }
  }

  async import(value: unknown, name: unknown, language: unknown): Promise<CorpusInfo> {
    this.checkContent(value);
    let payload: CorpusExport;
    try { payload = importCorpus(value, { name, language }); }
    catch { throw new WebError(400, "Invalid or incompatible prepared corpus. Use ParancU JSON with complete metadata, sentence units, and 384-dimensional E5 embeddings."); }
    const info: CorpusInfo = {
      id: randomUUID(), name: payload.sourceFilename, language: payload.language,
      createdAt: payload.createdAt, status: "ready", origin: "imported",
      sourceHash: createHash("sha256").update(JSON.stringify(payload.corpus)).digest("hex"),
      chunks: payload.corpus.chunks.length, sentences: payload.corpus.sentences.length
    };
    // Imported docId and all vectors remain unchanged; the local storage ID is separate.
    const work = this.persist(info, payload.corpus);
    this.pending.add(work);
    try { await work; }
    finally { this.pending.delete(work); }
    this.entries.set(info.id, { info, corpus: payload.corpus });
    return { ...info };
  }

  async export(id: string): Promise<CorpusExport> {
    const { info, corpus } = await this.getReady(id);
    this.checkContent({ info, corpus });
    try {
      return importCorpus({
        formatVersion: 1, sourceFilename: info.name, language: info.language, createdAt: info.createdAt,
        embedding: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS }, corpus
      }, { name: info.name, language: info.language });
    } catch { throw new WebError(409, "This saved corpus is incomplete or incompatible and cannot be exported."); }
  }

  private async entry(id: string): Promise<Entry> {
    if (!validId.test(id)) throw new WebError(404, "Corpus not found.");
    const cached = this.entries.get(id);
    if (cached) return cached;
    let saved: Entry;
    try {
      saved = JSON.parse(await readFile(path.join(this.directory, `${id}.json`), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WebError(404, "Corpus not found. Upload the document again.");
      throw new WebError(500, "Could not read the saved corpus.");
    }
    if (!saved?.info || saved.info.id !== id || saved.info.status !== "ready" ||
        !saved.corpus || (saved.info.origin !== "imported" && saved.corpus.docId !== id) || !Array.isArray(saved.corpus.sentences) ||
        !Array.isArray(saved.corpus.chunks) || !saved.corpus.chunks.length) {
      throw new WebError(500, "The saved corpus is invalid.");
    }
    this.checkContent(saved);
    if (saved.info.origin === "imported") {
      try { validatePreparedCorpus(saved.corpus); }
      catch { throw new WebError(500, "The saved corpus is invalid."); }
    }
    this.entries.set(id, saved);
    return saved;
  }

  async getInfo(id: string): Promise<CorpusInfo> { return { ...(await this.entry(id)).info }; }

  async getReady(id: string): Promise<{ info: CorpusInfo; corpus: PrepareResult }> {
    const entry = await this.entry(id);
    if (entry.info.status !== "ready" || !entry.corpus) throw new WebError(409, "The corpus is not ready.");
    return { info: { ...entry.info }, corpus: entry.corpus };
  }

  async drain(): Promise<void> { await Promise.all(this.pending); }
}
