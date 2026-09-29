import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CorpusStore, WebError } from "./corpusStore";
import type { WebWorkflowResult } from "./workflowService";
import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import { KeyManager } from "./keyManager";
import { SessionManager } from "./sessionManager";
import { exportFilename, MAX_IMPORT_BYTES } from "./corpusFormat";
import { parsePublicOrigin, readWebRuntimeConfig } from "./runtimeConfig";

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

async function readJson(request: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw new WebError(415, "A JSON request body is required.");
  }
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
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

export function createWebServer(options: ServerOptions): http.Server {
  const publicOrigin = parsePublicOrigin(options.publicOrigin);
  const publicHost = publicOrigin ? new URL(publicOrigin).host : undefined;
  const reportError = options.reportError ?? console.error;
  const busyCorpora = new Set<string>();
  const sessions = options.sessions ?? new SessionManager();
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
      const { keys, setCookie, requireActive, claimCorpus, requireCorpus } = sessions.resolve(request.headers.cookie, secure);
      if (setCookie) response.setHeader("Set-Cookie", setCookie);
      await keys.context(async () => {
        const url = new URL(request.url ?? "/", origin);
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
        if (request.method === "GET" && Object.hasOwn(staticFiles, url.pathname)) {
          const [file, type] = staticFiles[url.pathname];
          const content = await readFile(path.isAbsolute(file) ? file : path.join(options.webDirectory, file));
          response.writeHead(200, { "Content-Type": type });
          response.end(content);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/corpora") {
          const body = await readJson(request);
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
          const body = await readJson(request, MAX_IMPORT_BYTES);
          requireActive();
          keys.checkContent(body);
          const info = await options.store.import(body.corpus, body.name, body.language);
          // Import may outlive the initiating session; never revive its ownership.
          claimCorpus(info.id);
          send(201, info);
          return;
        }
        const exportMatch = /^\/api\/corpora\/([^/]+)\/export$/.exec(url.pathname);
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
        const corpusMatch = /^\/api\/corpora\/([^/]+)$/.exec(url.pathname);
        if (request.method === "GET" && corpusMatch) {
          requireCorpus(corpusMatch[1]);
          const info = await options.store.getInfo(corpusMatch[1]);
          requireCorpus(corpusMatch[1]);
          keys.checkContent(info);
          send(200, info);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/questions") {
          const body = await readJson(request);
          keys.checkContent(body);
          if (typeof body.corpusId !== "string" || typeof body.question !== "string" ||
              !body.question.trim() || body.question.length > 4000) {
            throw new WebError(400, "Provide a corpus and a question between 1 and 4,000 characters.");
          }
          requireCorpus(body.corpusId);
          const { info, corpus } = await options.store.getReady(body.corpusId);
          requireCorpus(body.corpusId);
          keys.checkContent({ info, corpus });
          if (busyCorpora.has(info.id)) throw new WebError(409, "A question is already being processed for this document.");
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
    })().catch(error => {
      if (!(error instanceof WebError)) reportError(new Error("Web operation failed."));
      if (!response.headersSent && !response.destroyed) {
        send(error instanceof WebError ? error.status : 500, {
          error: error instanceof WebError ? error.message : "Operational error. Check the server terminal; no answer has been verified."
        });
      }
    });
  });
  server.once("close", () => sessions.close());
  return server;
}

async function main(): Promise<void> {
  const { port, host, publicOrigin } = readWebRuntimeConfig();
  // The shared facade loads an SDK only with explicit observability opt-in.
  const { langfuseSdk } = await import("../observability/langfuse.js");
  let primaryFailure = false;
  let store: CorpusStore | undefined;
  let server: http.Server | undefined;
  const sessions = new SessionManager();
  try {
    const { prepareCorpusLocal } = await import("../../services/parancu-api/src/local/prepareCorpus.js");
    const { enrichPreparedCorpusWithOpenAI } = await import("../../services/parancu-api/src/lib/gen/openaiPrepare.js");
    const { createWorkflowService } = await import("./workflowService.js");
    const root = path.resolve(__dirname, "../..");
    store = new CorpusStore(path.join(root, "data/web/corpora"), {
      prepare: prepareCorpusLocal, enrich: enrichPreparedCorpusWithOpenAI
    }, console.error, KeyManager.checkContent);
    server = createWebServer({ store, sessions, publicOrigin, ask: createWorkflowService(), webDirectory: path.join(root, "apps/web") });
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
      const stop = () => { sessions.close(); cleanup(); resolve(); };
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
    sessions.close();
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
  }
}

if (require.main === module) {
  void main().catch(() => { console.error("Web server startup or operation failed. Check runtime configuration."); process.exitCode = 1; });
}
