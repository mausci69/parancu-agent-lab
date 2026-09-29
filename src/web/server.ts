import http from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { CorpusStore, WebError } from "./corpusStore";
import type { WebWorkflowResult } from "./workflowService";
import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import { KeyManager } from "./keyManager";
import { SessionManager } from "./sessionManager";
import { exportFilename } from "./corpusFormat";
import { parsePublicOrigin, readWebRuntimeConfig, readWebShutdownTimeout } from "./runtimeConfig";
import { readWebLimits, WebResources, QUESTION_REQUEST_BYTES, TXT_ENVELOPE_BYTES } from "./resourceLimits";

type ServerOptions = {
  store: CorpusStore;
  ask: (question: string, corpus: PrepareResult, retrievalOnly?: boolean) => Promise<WebWorkflowResult>;
  webDirectory: string;
  reportError?: (error: unknown) => void;
  sessions?: SessionManager;
  publicOrigin?: string;
};
const staticFiles: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  // Keep the official ParancU asset independent of the caller's web root.
  "/icon.png": [path.resolve(__dirname, "../../apps/mobile/assets/icon.png"), "image/png"]
};

async function readJson(request: http.IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > limit) throw new WebError(413, "The request is too large.");
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw new WebError(415, "A JSON request body is required.");
  }
  const buffers: Buffer[] = [];
  let bytes = 0;
  // Do not destroy the socket on overflow: the caller must still send HTTP 413.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw new WebError(413, "The request is too large.");
    buffers.push(Buffer.from(chunk));
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(buffers).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new WebError(400, "Invalid JSON."); }
}

export function createWebServer(options: ServerOptions): http.Server & { closeSessions(): void; beginDraining(): void } {
  let draining = false;
  const resources = options.store.resources;
  const limits = resources.limits;
  const publicOrigin = parsePublicOrigin(options.publicOrigin);
  const publicHost = publicOrigin ? new URL(publicOrigin).host : undefined;
  const reportError = options.reportError ?? console.error;
  const busyCorpora = new Set<string>();
  const sessions = options.sessions ?? new SessionManager();
  sessions.addCorpusReleaseHandler(ids => {
    for (const id of ids) void options.store.remove(id);
  });
  const server = http.createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(data));
    };
    void (async () => {
      const port = request.socket.localPort;
      const host = request.headers.host;
      // Public TLS terminates at the trusted deployment proxy. Never derive trust
      // from Forwarded or X-Forwarded-* request headers.
      const secure = Boolean(publicOrigin) || ("encrypted" in request.socket && request.socket.encrypted === true);
      const protocol = secure ? "https" : "http";
      if (publicHost ? host !== publicHost : host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        throw new WebError(403, "Host not allowed.");
      }
      const origin = publicOrigin ?? `${protocol}://${host}`;
      if ((request.headers.origin && request.headers.origin !== origin) ||
          request.headers["sec-fetch-site"] === "cross-site") throw new WebError(403, "Origin not allowed.");
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "GET" && Object.hasOwn(staticFiles, url.pathname)) {
        const [file, type] = staticFiles[url.pathname];
        const content = await readFile(path.isAbsolute(file) ? file : path.join(options.webDirectory, file));
        response.writeHead(200, { "Content-Type": type });
        response.end(content);
        return;
      }
      if (draining) throw new WebError(503, "Service temporarily unavailable.");
      const exportMatch = /^\/api\/corpora\/([^/]+)\/export$/.exec(url.pathname);
      const corpusMatch = /^\/api\/corpora\/([^/]+)$/.exec(url.pathname);
      const isUpload = request.method === "POST" && url.pathname === "/api/corpora";
      const isImport = request.method === "POST" && url.pathname === "/api/corpora/import";
      const isQuestion = request.method === "POST" && url.pathname === "/api/questions";
      const isSettings = url.pathname === "/api/settings/openai" && ["GET", "PUT", "DELETE"].includes(request.method ?? "");
      if (!isSettings && !isUpload && !isImport && !isQuestion &&
          !(request.method === "GET" && (exportMatch || corpusMatch))) {
        throw new WebError(404, "Resource not found.");
      }
      // Fail fast before session allocation, body buffering, parsing or disk reads.
      if (isUpload) resources.preparations.assertAvailable();
      if (isUpload || isImport) options.store.assertCorpusCapacity();
      const release = isQuestion ? resources.questions.acquire()
        : isUpload || isImport ? resources.ingestion.acquire() : () => {};
      try {
        const { keys, setCookie, requireActive, claimCorpus, requireCorpus } = sessions.resolve(
          request.headers.cookie, secure, isSettings || isUpload || isImport);
        if (setCookie) response.setHeader("Set-Cookie", setCookie);
        await keys.context(async () => {
          if (url.pathname === "/api/settings/openai") {
            if (request.method === "GET") { send(200, keys.status()); return; }
            if (request.method === "PUT") {
              const body = await readJson(request, 2048);
              try { keys.set(body.key); }
              finally { delete body.key; }
              send(200, keys.status()); return;
            }
            if (request.method === "DELETE") { keys.remove(); send(200, keys.status()); return; }
          }
          if (request.method === "POST" && url.pathname === "/api/corpora") {
            // Six bytes per UTF-8 byte covers JSON escaping; reserve a small envelope.
            const body = await readJson(request, limits.maxTextBytes * 6 + TXT_ENVELOPE_BYTES);
            resources.checkText(body.text);
            requireActive();
            keys.require();
            keys.checkContent(body);
            // CorpusStore owns runtime validation; browser input is never trusted.
            const info = keys.run(() => options.store.create(body as unknown as Parameters<CorpusStore["create"]>[0]));
            claimCorpus(info.id);
            send(202, info);
            return;
          }
          if (request.method === "POST" && url.pathname === "/api/corpora/import") {
            const body = await readJson(request, limits.maxImportBytes);
            resources.checkChunks(body.corpus);
            requireActive();
            keys.checkContent(body);
            const info = await options.store.import(body.corpus, body.name, body.language);
            // Import may outlive the initiating session; never revive its ownership.
            try { claimCorpus(info.id); }
            catch (error) {
              await options.store.remove(info.id);
              throw error;
            }
            send(201, info);
            return;
          }
          if (request.method === "GET" && exportMatch) {
            requireCorpus(exportMatch[1]);
            const payload = await options.store.export(exportMatch[1]);
            requireCorpus(exportMatch[1]);
            keys.checkContent(payload);
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8",
              "Content-Disposition": `attachment; filename="${exportFilename(payload.sourceFilename)}"` });
            response.end(JSON.stringify(payload, null, 2));
            return;
          }
          if (request.method === "GET" && corpusMatch) {
            requireCorpus(corpusMatch[1]);
            const info = await options.store.getInfo(corpusMatch[1]);
            requireCorpus(corpusMatch[1]);
            keys.checkContent(info);
            send(200, info);
            return;
          }
          if (request.method === "POST" && url.pathname === "/api/questions") {
            const body = await readJson(request, QUESTION_REQUEST_BYTES);
            keys.checkContent(body);
            if (typeof body.corpusId !== "string" || typeof body.question !== "string" ||
                !body.question.trim() || body.question.length > 4000) {
              throw new WebError(400, "Provide a corpus and a question between 1 and 4,000 characters.");
            }
            requireCorpus(body.corpusId);
            const { info, corpus } = await options.store.getReady(body.corpusId);
            requireCorpus(body.corpusId);
            keys.checkContent({ info, corpus });
            if (busyCorpora.has(info.id)) throw new WebError(429, "A question is already being processed for this document.");
            busyCorpora.add(info.id);
            try {
              const question = body.question.trim();
              const result = keys.status().ready
                ? await keys.run(() => options.ask(question, corpus))
                : await options.ask(question, corpus, true);
              requireCorpus(body.corpusId);
              keys.checkContent(result);
              send(200, { corpus: info, ...result });
            } finally { busyCorpora.delete(info.id); }
            return;
          }
          throw new WebError(404, "Resource not found.");
        });
      } finally { release(); }
    })().catch(error => {
      if (!(error instanceof WebError)) reportError(new Error("Web operation failed."));
      if (!response.headersSent && !response.destroyed) {
        // Unread/rejected bodies are not drained into memory or kept alive.
        if (!request.complete || (error instanceof WebError && error.status === 413)) {
          response.shouldKeepAlive = false;
          response.setHeader("Connection", "close");
        }
        send(error instanceof WebError ? error.status : 500, {
          error: error instanceof WebError ? error.message : "Operational error. Check the server terminal; no answer has been verified."
        });
      }
    });
  });
  server.once("close", () => sessions.close());
  return Object.assign(server, {
    closeSessions: () => sessions.close(),
    beginDraining: () => { draining = true; }
  });
}

export async function purgeWebCorpora(corpusDirectory: string): Promise<void> {
  // Remove the configured tree directly; recursive rm does not follow child symlinks.
  await rm(corpusDirectory, { recursive: true, force: true });
  await mkdir(corpusDirectory, { recursive: true, mode: 0o700 });
}

class ShutdownTimeoutError extends Error {
  constructor() { super("Server shutdown timed out."); }
}

export async function withShutdownDeadline(work: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    let remaining = timeoutMs;
    const schedule = () => {
      // Avoid Node's overflow clamping for valid large configuration values.
      const delay = Math.min(remaining, 2_147_483_647);
      timer = setTimeout(() => {
        remaining -= delay;
        if (remaining > 0) schedule();
        else reject(new ShutdownTimeoutError());
      }, delay);
    };
    schedule();
  });
  try { await Promise.race([Promise.resolve().then(work), deadline]); }
  finally { clearTimeout(timer); }
}

async function main(): Promise<void> {
  const { port, host, publicOrigin, corpusDirectory } = readWebRuntimeConfig();
  const shutdownTimeoutMs = readWebShutdownTimeout();
  const resources = new WebResources(readWebLimits());
  // The shared facade loads an SDK only with explicit observability opt-in.
  const { langfuseSdk } = await import("../observability/langfuse.js");
  let primaryFailure = false;
  let store: CorpusStore | undefined;
  let server: ReturnType<typeof createWebServer> | undefined;
  try {
    await purgeWebCorpora(corpusDirectory);
    const { prepareCorpusLocal } = await import("../../services/parancu-api/src/local/prepareCorpus.js");
    const { enrichPreparedCorpusWithOpenAI } = await import("../../services/parancu-api/src/lib/gen/openaiPrepare.js");
    const { createWorkflowService } = await import("./workflowService.js");
    const root = path.resolve(__dirname, "../..");
    store = new CorpusStore(corpusDirectory, {
      prepare: prepareCorpusLocal, enrich: enrichPreparedCorpusWithOpenAI
    }, console.error, KeyManager.checkContent, resources);
    server = createWebServer({ store, publicOrigin, ask: createWorkflowService(undefined, resources), webDirectory: path.join(root, "apps/web") });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, host, () => {
        server!.removeListener("error", reject);
        resolve();
      });
    });
    console.log(`ParancU Agent Lab: ${publicOrigin ?? `http://127.0.0.1:${port}`}`);
    console.log("Document preparation and questions use OpenAI. Press Ctrl+C to shut down after current operations finish.");
    await new Promise<void>((resolve, reject) => {
      const stop = () => { server!.beginDraining(); cleanup(); resolve(); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        server!.removeListener("error", fail);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      server!.once("error", fail);
    });
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    try {
      await withShutdownDeadline(async () => {
        server?.beginDraining();
        server?.closeSessions();
        try {
          if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
          await store?.drain();
        } catch (error) {
          console.error("Server shutdown failed.");
          if (!primaryFailure) process.exitCode = 1;
        } finally {
          try { await langfuseSdk.shutdown(); }
          catch (error) {
            if (!primaryFailure) throw error;
            console.error("Observability shutdown failed.");
          }
        }
      }, shutdownTimeoutMs);
    } catch (error) {
      if (error instanceof ShutdownTimeoutError) {
        console.error("Server shutdown timed out.");
        // Outstanding handles may otherwise keep the process alive indefinitely.
        process.exit(1);
      }
      throw error;
    }
  }
}

if (require.main === module) {
  void main().catch(() => { console.error("Web server startup or operation failed. Check runtime configuration."); process.exitCode = 1; });
}
