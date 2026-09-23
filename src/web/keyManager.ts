import { assertNoCredentials, withOpenAIKey } from "../../services/parancu-api/src/local/openaiKeyStore";
import { WebError } from "./corpusStore";

/** One local workspace, one user-provided key held only in memory. */
export class KeyManager {
  #key: string | null = null;
  #closed = false;
  private current = (): string | null => this.#closed ? null : this.#key;

  status() {
    return { ready: Boolean(this.current()), source: this.current() ? "session" : "none" };
  }

  set(value: unknown) {
    if (this.#closed) throw new WebError(503, "The server is shutting down.");
    if (typeof value !== "string" || !/^sk-[A-Za-z0-9_-]{16,509}$/.test(value.trim())) {
      throw new WebError(400, "Enter a valid OpenAI API key.");
    }
    this.#key = value.trim();
  }

  remove() { this.#key = null; }
  close() { this.remove(); this.#closed = true; }
  require() {
    if (!this.current()) throw new WebError(409, "Add an OpenAI API key in Settings before preparing a document or asking a question.");
  }
  run<T>(work: () => T): T { this.require(); return withOpenAIKey(this.current, work); }
  checkContent(value: unknown) {
    // Environment secrets are still excluded from content, but never used for authentication.
    try { assertNoCredentials(JSON.stringify(value), [this.#key, process.env.OPENAI_API_KEY?.trim()]); }
    catch { throw new WebError(400, "Remove credentials from the document, corpus, or question before continuing."); }
  }
}
