import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import { assertNoCredentials } from "../../services/parancu-api/src/local/openaiKeyStore";
import { importCorpus, validatePreparedCorpus, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, type CorpusExport } from "./corpusFormat";
import { DEFAULT_WEB_LIMITS, WebResources } from "./resourceLimits";
import { WebError } from "./webError";
export { WebError } from "./webError";

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
export const MAX_TEXT_BYTES = DEFAULT_WEB_LIMITS.maxTextBytes;
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Local store for trusted, server-generated corpora. Never uses uploaded names as paths. */
export class CorpusStore {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<void>>();
  private readonly reservations = new Set<string>();
  private readonly loading = new Map<string, Promise<Entry>>();
  private readonly persistedBytes = new Map<string, number>();
  // Includes in-flight reservations; startup supplies an empty directory.
  private diskBytes = 0;

  constructor(
    private readonly directory: string,
    private readonly dependencies: PreparationDependencies,
    private readonly reportError: (error: unknown) => void = console.error,
    private readonly checkContent: (value: unknown) => void = value =>
      assertNoCredentials(JSON.stringify(value), [process.env.OPENAI_API_KEY?.trim()]),
    readonly resources = new WebResources()
  ) {}

  assertCorpusCapacity(): void {
    if (this.entries.size + this.reservations.size >= this.resources.limits.maxCorpora) {
      throw new WebError(429, "Corpus capacity reached for this process.");
    }
  }

  private reserveCorpus(id: string): () => void {
    this.assertCorpusCapacity();
    this.reservations.add(id);
    return () => { this.reservations.delete(id); };
  }

  create(input: { name: string; text: string; language: Language }): CorpusInfo {
    const release = this.resources.preparations.acquire();
    let transferred = false;
    try {
      this.assertCorpusCapacity();
      this.resources.checkText(input.text);
      if (typeof input.name !== "string" || !input.name.toLowerCase().endsWith(".txt") ||
          input.name.length > 255 || /[\\/\x00-\x1f]/.test(input.name)) {
        throw new WebError(400, "Select a .txt file with a valid name.");
      }
      if (typeof input.text !== "string" || !input.text.trim() || input.text.includes("\0")) {
        throw new WebError(400, "The file must contain non-empty text with no NUL characters.");
      }
      if (input.language !== "en" && input.language !== "it") {
        throw new WebError(400, "Document language must be Italian or English.");
      }
      this.checkContent(input);
      const info: CorpusInfo = {
        id: randomUUID(), name: input.name, language: input.language, status: "preparing", origin: "txt",
        createdAt: new Date().toISOString(),
        sourceHash: createHash("sha256").update(input.text).digest("hex")
      };
      // Bounded local splitting is necessary to know the exact chunk count. Reuse
      // this result so preparation behavior is unchanged and never runs twice.
      const prepared = this.dependencies.prepare(input.text, { docId: info.id });
      this.resources.checkChunks(prepared);
      if (!prepared.chunks.length) throw new WebError(400, "Preparation returned no chunks.");
      const entry: Entry = { info };
      this.entries.set(info.id, entry);
      // Delay work until after the preparing entry exists and the HTTP handler can respond.
      const task = Promise.resolve().then(() => this.prepare(entry, prepared)).finally(() => {
        this.pending.delete(task);
        release();
      });
      this.pending.add(task);
      transferred = true;
      return { ...info };
    } finally { if (!transferred) release(); }
  }

  private async prepare(entry: Entry, prepared: PrepareResult): Promise<void> {
    try {
      const corpus = await this.dependencies.enrich(prepared, { corpusLanguage: entry.info.language });
      if (this.entries.get(entry.info.id) !== entry) return;
      this.resources.checkChunks(corpus);
      const info: CorpusInfo = {
        ...entry.info, status: "ready", sentences: corpus.sentences.length, chunks: corpus.chunks.length
      };
      await this.persist(info, corpus);
      entry.corpus = corpus;
      entry.info = info;
    } catch (error) {
      entry.info = { ...entry.info, status: "failed", error: "Preparation failed. Check the server terminal, then start preparation again." };
      try { this.reportError(new Error("Corpus preparation failed.")); } catch { /* Reporting cannot strand a job. */ }
    } finally {
      // Removal may also have happened while persistence was awaiting I/O.
      if (this.entries.get(entry.info.id) !== entry) await this.remove(entry.info.id);
    }
  }

  private async persist(info: CorpusInfo, corpus: PrepareResult): Promise<void> {
    this.checkContent({ info, corpus });
    const payload = JSON.stringify({ info, corpus });
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > this.resources.limits.maxCorpusDiskBytes - this.diskBytes) {
      throw new WebError(429, "Corpus storage capacity reached. Try again later.");
    }
    this.diskBytes += bytes;
    const destination = path.join(this.directory, `${info.id}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let persisted = false;
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(temporary, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
      this.persistedBytes.set(info.id, bytes);
      persisted = true;
    } catch {
      throw new WebError(500, "Could not save the corpus.");
    } finally {
      if (!persisted) this.diskBytes -= bytes;
      try { await unlink(temporary); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          try { this.reportError(new Error("Temporary corpus cleanup failed.")); }
          catch { /* Reporting cannot change persistence accounting. */ }
        }
      }
    }
  }

  async import(value: unknown, name: unknown, language: unknown): Promise<CorpusInfo> {
    const id = randomUUID();
    const release = this.reserveCorpus(id);
    try {
      if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > this.resources.limits.maxImportBytes) {
        throw new WebError(413, "The corpus exceeds the configured import byte limit.");
      }
      this.resources.checkChunks(value);
      this.checkContent(value);
      let payload: CorpusExport;
      try { payload = importCorpus(value, { name, language }); }
      catch { throw new WebError(400, "Invalid or incompatible prepared corpus. Use ParancU JSON with complete metadata, sentence units, and 384-dimensional E5 embeddings."); }
      const info: CorpusInfo = {
        id, name: payload.sourceFilename, language: payload.language,
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
    } finally { release(); }
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
    const existing = this.loading.get(id);
    if (existing) return existing;
    const release = this.reserveCorpus(id);
    const work = this.loadEntry(id).finally(() => { this.loading.delete(id); release(); });
    this.loading.set(id, work);
    return work;
  }

  private async loadEntry(id: string): Promise<Entry> {
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
    this.resources.checkChunks(saved.corpus);
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

  async remove(id: string): Promise<void> {
    if (!validId.test(id)) return;
    this.entries.delete(id);
    const bytes = this.persistedBytes.get(id);
    try { await unlink(path.join(this.directory, `${id}.json`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try { this.reportError(new Error("Corpus removal failed.")); }
        catch { /* Reporting must not expose filesystem errors or reject cleanup. */ }
        return;
      }
    }
    // Do not release an in-flight write, or release twice for concurrent removals.
    if (bytes !== undefined && this.persistedBytes.get(id) === bytes) {
      this.persistedBytes.delete(id);
      this.diskBytes -= bytes;
    }
  }

  async drain(): Promise<void> { await Promise.all(this.pending); }
}
