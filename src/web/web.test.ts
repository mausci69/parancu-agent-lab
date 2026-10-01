import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import Module from "node:module";
import { register } from "tsx/cjs/api";
import { test, type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { prepareCorpusLocal } from "../../services/parancu-api/src/local/prepareCorpus";
import type { RetrieveResult } from "../../services/parancu-api/src/local/retrieval";
import { CorpusStore, MAX_TEXT_BYTES, WebError } from "./corpusStore";
import { createWebServer, purgeWebCorpora, withShutdownDeadline } from "./server";
import { parsePublicOrigin, readWebRuntimeConfig, readWebOpenAITimeout, readWebShutdownTimeout } from "./runtimeConfig";
import { createWorkflowService } from "./workflowService";
import { KeyManager } from "./keyManager";
import { SessionManager, SESSION_COOKIE } from "./sessionManager";
import { importCorpus, validatePreparedCorpus, exportFilename } from "./corpusFormat";
import { loadOpenAIKey } from "../../services/parancu-api/src/local/openaiKeyStore";
import { requestOpenAI } from "../../services/parancu-api/src/local/openaiRequest";
import { generateResponse } from "../responder/responseAgent";
import { verifyEvidence } from "../verifier/evidenceVerifier";
import { AdmissionGate, DEFAULT_WEB_LIMITS, readWebLimits, WebResources } from "./resourceLimits";
import { build } from "esbuild";
import { browserBuildOptions, browserBundle } from "./browserAssets";

const statusIs = (status: number) => (error: unknown) => error instanceof WebError && error.status === status;

const source = "Atlas is blue. Nova is red. Atlas weighs one kilogram. Nova is lighter.";
const input = { name: "example.txt", text: source, language: "en" as const };
const webDirectory = path.resolve(__dirname, "../../apps/web");
const noLog = () => {};

// Node fetch has no browser cookie jar; existing HTTP/UI fixtures use one per server.
const browserCookies = new Map<string, string>();
async function fetch(url: string, options: RequestInit = {}) {
  const origin = new URL(url).origin;
  const headers = new Headers(options.headers);
  const cookie = browserCookies.get(origin);
  if (cookie && !headers.has("Cookie")) headers.set("Cookie", cookie);
  const response = await globalThis.fetch(url, { ...options, headers });
  const updated = response.headers.get("set-cookie");
  if (updated && browserCookies.has(origin)) browserCookies.set(origin, updated.split(";")[0]);
  return response;
}

async function tempDirectory(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "parancu-web-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function candidate(index: number, text: string): RetrieveResult {
  return { chunk_index: index, chunk: text, summary: text, guiding_question: "What color?", answer_focus: "", sentence_ids: [0], score: 0.9 - index / 10, cosine_score: 0.8 };
}

function service(options: { fail?: boolean; reject?: boolean } = {}) {
  return createWorkflowService({
    retrieveCandidates: async () => [candidate(0, "Atlas has a frame."), candidate(1, "Atlas is blue."), candidate(2, "Nova is red.")],
    generateAnswer: async (_question, evidence) => {
      if (options.fail) throw new Error("PRIVATE_UPSTREAM_ERROR");
      return evidence;
    },
    verifyAnswer: async (_question, _answer, evidence) => ({ supported: !options.reject && evidence === "Atlas is blue.", reason: "Checked against supplied evidence." })
  });
}

async function startServer(t: TestContext, store: CorpusStore, ask = service(), keys = configuredKeys(),
  ownedCorpora: string[] = [], sessions = new SessionManager()) {
  const browser = sessions.resolve(undefined);
  for (const id of ownedCorpora) browser.claimCorpus(id);
  if (keys.status().ready) browser.keys.set(sessionKey);
  const server = createWebServer({ store, ask, sessions, webDirectory, reportError: noLog });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browserCookies.set(base, browser.setCookie!.split(";")[0]);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    browserCookies.delete(base);
    assert.equal(browser.keys.status().ready, false, "server close clears credential access");
    keys.close();
    await store.drain();
  });
  return base;
}

async function post(base: string, endpoint: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("preparation exposes preparing, then persists ready; a new store reuses it without enrichment", async t => {
  const directory = await tempDirectory(t);
  const gate = deferred();
  const calls: unknown[] = [];
  const store = new CorpusStore(directory, {
    prepare: (text, options) => { calls.push(text); return prepareCorpusLocal(text, options); },
    enrich: async (corpus, options) => { calls.push(options); await gate.promise; return corpus; }
  }, noLog);
  const info = store.create({ ...input, language: "it" });
  assert.equal(info.status, "preparing");
  assert.equal((await store.getInfo(info.id)).status, "preparing");
  await assert.rejects(store.getReady(info.id), (error: unknown) => error instanceof WebError && error.status === 409);
  assert.throws(() => store.create(input), (error: unknown) => error instanceof WebError && error.status === 429);
  gate.resolve();
  await store.drain();
  const ready = await store.getReady(info.id);
  assert.equal(ready.info.status, "ready");
  assert.equal(ready.corpus.docId, info.id);
  assert.deepEqual(calls, [source, { corpusLanguage: "it" }]);
  assert.deepEqual(await readdir(directory), [`${info.id}.json`]);
  const fresh = new CorpusStore(directory, { prepare: () => { throw new Error("must not prepare"); }, enrich: async () => { throw new Error("must not enrich"); } }, noLog);
  assert.deepEqual(await fresh.getReady(info.id), ready);
  assert.equal(JSON.parse(await readFile(path.join(directory, `${info.id}.json`), "utf8")).info.sourceHash, ready.info.sourceHash);
});

test("failed enrichment is failed, is not persisted, and requires a new explicit preparation", async t => {
  const directory = await tempDirectory(t);
  const errors: unknown[] = [];
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async () => { throw new Error("SECRET_DETAIL"); } }, error => errors.push(error));
  const info = store.create(input);
  await store.drain();
  const failed = await store.getInfo(info.id);
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_DETAIL/);
  assert.equal(errors.length, 1);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(store.getReady(info.id), WebError);
});

test("storage failure never reports ready", async t => {
  const directory = await tempDirectory(t);
  const blocked = path.join(directory, "not-a-directory");
  await writeFile(blocked, "existing file");
  const store = new CorpusStore(blocked, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const info = store.create(input);
  await store.drain();
  assert.equal((await store.getInfo(info.id)).status, "failed");
  assert.equal(await readFile(blocked, "utf8"), "existing file");
  const retry = store.create(input);
  await store.drain();
  assert.equal((await store.getInfo(retry.id)).status, "failed", "storage failure releases the preparation slot");
});

test("invalid uploads and path IDs fail before preparation", async t => {
  let calls = 0;
  const store = new CorpusStore(await tempDirectory(t), { prepare: () => { calls++; throw new Error(); }, enrich: async c => c }, noLog);
  for (const bad of [
    { ...input, name: "../escape.txt" }, { ...input, name: "file.pdf" },
    { ...input, text: " " }, { ...input, text: "a\0b" },
    { ...input, text: "x".repeat(MAX_TEXT_BYTES + 1) }, { ...input, language: "fr" }
  ]) assert.throws(() => store.create(bad as typeof input), WebError);
  await assert.rejects(store.getInfo("../../outside"), WebError);
  assert.equal(calls, 0);
});

test("workflow adapter runs the real graph once and keeps accepted evidence distinct", async () => {
  let retrievals = 0;
  const calls: string[] = [];
  const ask = createWorkflowService({
    retrieveCandidates: async (_question, _corpus, k) => { retrievals++; assert.equal(k, 5); return [candidate(4, "same text"), candidate(5, "same text"), candidate(6, "other")]; },
    generateAnswer: async (_question, evidence) => { calls.push(evidence); return evidence; },
    verifyAnswer: async () => ({ supported: calls.length === 2, reason: "verdict" })
  });
  const response = await ask("question", prepareCorpusLocal(source));
  assert.equal(retrievals, 1);
  assert.deepEqual(calls, ["same text", "same text"]);
  assert.deepEqual(response.retrievedEvidence.map(c => c.status), ["rejected", "accepted", "not_evaluated"]);
  assert.equal(response.result.action, "answer");
  if (response.result.action === "answer") assert.deepEqual(response.result.evidence, { chunkIndex: 5, text: "same text", candidateRank: 2, score: 0.4 });
});

test("no_evidence retains retrieved candidates without inventing an accepted citation", async () => {
  const response = await service({ reject: true })("question", prepareCorpusLocal(source));
  assert.deepEqual(response.result, { action: "no_evidence", question: "question" });
  assert.deepEqual(response.retrievedEvidence.map(c => c.status), ["rejected", "rejected", "rejected"]);
});

test("parallel workflows do not mix evidence between requests", async () => {
  const ask = createWorkflowService({
    retrieveCandidates: async question => [candidate(0, question)],
    generateAnswer: async (_q, evidence) => { await Promise.resolve(); return evidence; },
    verifyAnswer: async (q, answer, evidence) => ({ supported: q === answer && answer === evidence, reason: q })
  });
  const corpus = prepareCorpusLocal(source);
  const responses = await Promise.all([ask("first", corpus), ask("second", corpus)]);
  assert.deepEqual(responses.map(r => r.retrievedEvidence[0].text), ["first", "second"]);
  assert.ok(responses.every(r => r.result.action === "answer"));
});

test("HTTP upload → async status → question → citation works without external calls", async t => {
  const gate = deferred();
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => { await gate.promise; return c; } }, noLog);
  const base = await startServer(t, store);
  const uploaded = await post(base, "/api/corpora", { ...input, name: "<script>alert(1)</script>.txt" });
  assert.equal(uploaded.status, 400); // slash is not an allowed filename character
  const response = await post(base, "/api/corpora", { ...input, name: "<img onerror=alert(1)>.txt" });
  assert.equal(response.status, 202);
  const info = await response.json();
  assert.equal(info.status, "preparing");
  assert.equal((await post(base, "/api/questions", { corpusId: info.id, question: "What color?" })).status, 409);
  gate.resolve();
  await store.drain();
  assert.equal((await (await fetch(`${base}/api/corpora/${info.id}`)).json()).status, "ready");
  const answer = await post(base, "/api/questions", { corpusId: info.id, question: "What color?" });
  assert.equal(answer.status, 200);
  const data = await answer.json();
  assert.equal(data.corpus.name, "<img onerror=alert(1)>.txt");
  assert.equal(data.result.evidence.text, "Atlas is blue.");
  assert.deepEqual(data.retrievedEvidence.map((item: { status: string }) => item.status), ["rejected", "accepted", "not_evaluated"]);
});

test("HTTP operational errors remain errors, not no_evidence or upstream detail", async t => {
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const info = store.create(input);
  await store.drain();
  const base = await startServer(t, store, service({ fail: true }), configuredKeys(), [info.id]);
  const response = await post(base, "/api/questions", { corpusId: info.id, question: "question" });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.doesNotMatch(body, /PRIVATE_UPSTREAM_ERROR|no_evidence/);
  assert.match(body, /Operational error/);
});

test("HTTP no_evidence is a successful search outcome with rejected candidates", async t => {
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const info = store.create(input);
  await store.drain();
  const base = await startServer(t, store, service({ reject: true }), configuredKeys(), [info.id]);
  const response = await post(base, "/api/questions", { corpusId: info.id, question: "question" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.action, "no_evidence");
  assert.ok(!Object.hasOwn(body.result, "evidence"));
  assert.equal(body.retrievedEvidence.length, 3);
});

test("distinct E5 module identities share initialization and the initialized embedding session", async t => {
  const stateKey = Symbol.for("parancu-agent-lab.e5.state");
  const globals = globalThis as typeof globalThis & { [stateKey]?: unknown };
  const previousState = Object.getOwnPropertyDescriptor(globals, stateKey);
  delete globals[stateKey];
  t.after(() => {
    if (previousState) Object.defineProperty(globals, stateKey, previousState);
    else delete globals[stateKey];
  });
  const filename = path.resolve(__dirname, "../../services/parancu-api/src/lib/embeddings.ts");
  const loader = register({ namespace: "e5-initializer-test" });
  const otherLoader = register({ namespace: "e5-retrieval-test" });
  t.after(() => { otherLoader.unregister(); loader.unregister(); });
  let loads = 0;
  let tokenizers = 0;
  let runs = 0;
  let available = false;
  const gate = deferred();
  const originalRequire = Module.prototype.require;
  const mockedRequire = t.mock.method(Module.prototype, "require", function (this: NodeJS.Module, name: string) {
    if (!this.filename.startsWith(filename)) return originalRequire.call(this, name);
    if (name === "node:fs") return { existsSync: () => available, readFileSync: () => "{}" };
    if (name === "@huggingface/tokenizers") return { Tokenizer: class {
      constructor() { tokenizers++; }
      encode() { return { ids: [0, 2] }; }
    } };
    if (name === "onnxruntime-node") return {
      Tensor: class {},
      InferenceSession: { create: async () => {
        loads++;
        await gate.promise;
        return { inputNames: [], outputNames: [], run: async () => {
          runs++;
          return { sentence_embedding: { dims: [1, 384], data: new Float32Array(384).fill(0.5) } };
        } };
      } }
    };
    return originalRequire.call(this, name);
  });
  let exports: typeof import("../../services/parancu-api/src/lib/embeddings");
  let otherExports: typeof exports;
  try {
    exports = loader.require(filename, __filename);
    otherExports = otherLoader.require(filename, __filename);
  }
  finally { mockedRequire.mock.restore(); }
  assert.notEqual(exports.initializeE5, otherExports.initializeE5, "separate module evaluations are required");
  t.mock.method(console, "log", noLog);
  await assert.rejects(exports.initializeE5(), /E5 model not found/);
  available = true;
  const first = exports.initializeE5();
  const sharedState = globals[stateKey] as { loading: Promise<void> };
  const loading = sharedState.loading;
  const second = otherExports.initializeE5();
  assert.equal(sharedState.loading, loading);
  assert.equal(loads, 1);
  assert.equal(tokenizers, 1);
  gate.resolve();
  await Promise.all([first, second]);
  await otherExports.initializeE5();
  assert.equal(loads, 1);
  assert.equal(runs, 0);
  assert.deepEqual(Array.from(await exports.embedMany([])), []);
  assert.deepEqual(Array.from(await otherExports.embedOne("query")), Array(384).fill(0.5));
  const passages = await exports.embedMany(["passage"]);
  assert.deepEqual(Array.from(passages[0]), Array(384).fill(0.5));
  assert.equal(loads, 1);
  assert.equal(tokenizers, 1);
  assert.equal(runs, 2);
});

test("health and readiness are session-free, reflect draining, and preserve Host/origin protection", async t => {
  for (const publicOrigin of [undefined, "https://lab.example"]) {
    const sessions = new SessionManager();
    const resolveSession = t.mock.method(sessions, "resolve", () => assert.fail("probe allocated a session"));
    const store = new CorpusStore(await tempDirectory(t), {
      prepare: () => assert.fail("probe prepared corpus data"),
      enrich: async () => assert.fail("probe enriched corpus data")
    }, noLog);
    const server = createWebServer({ store, sessions, publicOrigin, webDirectory,
      ask: async () => assert.fail("probe started workflow work"), reportError: noLog });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const port = (server.address() as AddressInfo).port;
    const host = publicOrigin ? "lab.example" : `127.0.0.1:${port}`;
    const origin = publicOrigin ?? `http://${host}`;
    const request = (route: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number | undefined; body: unknown; cookie: string[] | undefined }>((resolve, reject) => {
        http.get({ hostname: "127.0.0.1", port, path: route, headers: { Host: host, ...headers } }, response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("error", reject);
          response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body), cookie: response.headers["set-cookie"] }));
        }).on("error", reject);
      });
    assert.deepEqual(await request("/ready"), { status: 200, body: { ready: true }, cookie: undefined });
    assert.deepEqual(await request("/health"), { status: 200, body: { ok: true }, cookie: undefined });
    for (const draining of [false, true]) {
      if (draining) server.beginDraining();
      assert.deepEqual(await request("/health"), { status: 200, body: { ok: true }, cookie: undefined });
      assert.deepEqual(await request("/ready", { Origin: origin }), {
        status: draining ? 503 : 200, body: { ready: !draining }, cookie: undefined
      });
      for (const route of ["/health", "/ready"]) {
        const invalidHeaders: Record<string, string>[] = [{ Host: "wrong.example" }, { Origin: "https://wrong.example" },
          { "Sec-Fetch-Site": "cross-site" }];
        for (const headers of invalidHeaders) {
          assert.equal((await request(route, headers)).status, 403);
        }
      }
    }
    assert.equal(resolveSession.mock.callCount(), 0);
  }
});

test("draining rejects new API work before admission while an in-flight question finishes", async t => {
  const gate = deferred();
  const started = deferred();
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const info = store.create(input);
  await store.drain();
  const sessions = new SessionManager();
  const browser = sessions.resolve(undefined);
  browser.claimCorpus(info.id);
  browser.keys.set(sessionKey);
  let calls = 0;
  const server = createWebServer({ store, sessions, webDirectory, reportError: noLog,
    ask: async (q, c) => { calls++; started.resolve(); await gate.promise; return service()(q, c); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    gate.resolve();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await store.drain();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Cookie: browser.setCookie!.split(";")[0], "Content-Type": "application/json" };
  const normal = await globalThis.fetch(base + "/api/settings/openai", { headers });
  assert.equal(normal.status, 200);
  assert.equal((await normal.json()).ready, true);
  const first = globalThis.fetch(base + "/api/questions", { method: "POST", headers,
    body: JSON.stringify({ corpusId: info.id, question: "question" }) });
  await started.promise;
  const resolveSession = t.mock.method(sessions, "resolve");
  const ingestion = t.mock.method(store.resources.ingestion, "acquire");
  const questions = t.mock.method(store.resources.questions, "acquire");
  const create = t.mock.method(store, "create");
  const imported = t.mock.method(store, "import");
  server.beginDraining();
  server.beginDraining();
  for (const [route, method] of [["/api/settings/openai", "GET"], ["/api/settings/openai", "PUT"],
    ["/api/settings/openai", "DELETE"], ["/api/corpora", "POST"], ["/api/corpora/import", "POST"],
    ["/api/questions", "POST"], [`/api/corpora/${info.id}`, "GET"], [`/api/corpora/${info.id}/export`, "GET"]]) {
    // No cookie: rejection must happen before allocating a browser session.
    const response = await globalThis.fetch(base + route, { method });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Service temporarily unavailable." });
    assert.equal(response.headers.get("set-cookie"), null);
  }
  for (const mock of [resolveSession, ingestion, questions, create, imported]) {
    assert.equal(mock.mock.callCount(), 0);
  }
  assert.equal(calls, 1);
  gate.resolve();
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).result.action, "answer");
});

test("HTTP rejects duplicate questions while one is running", async t => {
  const gate = deferred();
  const started = deferred();
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const info = store.create(input);
  await store.drain();
  const base = await startServer(t, store, async (q, c) => { started.resolve(); await gate.promise; return service()(q, c); }, configuredKeys(), [info.id]);
  const body = { corpusId: info.id, question: "question" };
  const first = post(base, "/api/questions", body);
  await started.promise;
  const duplicate = await post(base, "/api/questions", body);
  assert.equal(duplicate.status, 429);
  const foreign = await globalThis.fetch(base + "/api/questions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  assert.equal(foreign.status, 404, "another session must not learn that the corpus is busy");
  assert.deepEqual(await foreign.json(), { error: "Corpus not found." });
  gate.resolve();
  assert.equal((await first).status, 200);
});

test("HTTP validates bodies, origins, host and static allowlist before work", async t => {
  let calls = 0;
  const store = new CorpusStore(await tempDirectory(t), { prepare: () => { calls++; throw new Error(); }, enrich: async c => c }, noLog);
  const base = await startServer(t, store);
  assert.equal((await post(base, "/api/corpora", input, { Origin: "https://other.example" })).status, 403);
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    http.get(base, { headers: { Host: "other.example" } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await post(base, "/api/corpora", input, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await fetch(`${base}/api/corpora`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await post(base, "/api/corpora", null)).status, 400);
  assert.equal((await post(base, "/api/corpora", {})).status, 400);
  assert.equal((await post(base, "/api/questions", { corpusId: "id", question: "" })).status, 400);
  for (const route of ["/.env", "/data/web/corpora/file.json", "/../package.json"]) assert.equal((await fetch(base + route)).status, 404);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(await page.text(), /Document/);
  const js = await (await fetch(`${base}/app.js`)).text();
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|OPENAI_API_KEY/);
  assert.equal(calls, 0);
});
test("web runtime defaults, production configuration and port precedence", () => {
  assert.deepEqual(readWebRuntimeConfig({}), { port: 3000, host: "127.0.0.1", publicOrigin: undefined,
    corpusDirectory: path.join(os.tmpdir(), "parancu-agent-lab", "corpora") });
  assert.equal(readWebRuntimeConfig({ WEB_PORT: "3001" }).port, 3001);
  assert.equal(readWebRuntimeConfig({ PORT: "8080", WEB_PORT: "3001" }).port, 8080);
  assert.equal(readWebRuntimeConfig({ PORT: "8080", WEB_PORT: "ignored" }).port, 8080);
  assert.deepEqual(readWebRuntimeConfig({ NODE_ENV: "production", WEB_PUBLIC_ORIGIN: "https://lab.example/",
    WEB_HOST: "0.0.0.0", PORT: "8080" }), { port: 8080, host: "0.0.0.0", publicOrigin: "https://lab.example",
    corpusDirectory: path.join(os.tmpdir(), "parancu-agent-lab", "corpora") });
  assert.throws(() => readWebRuntimeConfig({ NODE_ENV: "production" }), /WEB_PUBLIC_ORIGIN/);
  assert.throws(() => readWebRuntimeConfig({ WEB_HOST: "https://lab.example" }), /WEB_HOST/);
  for (const port of ["", "0", "65536", "1.5", "NaN", " 3000", "3e3"]) {
    assert.throws(() => readWebRuntimeConfig({ PORT: port, WEB_PORT: "3000" }), /PORT/);
    assert.throws(() => readWebRuntimeConfig({ WEB_PORT: port }), /PORT/);
  }
  for (const origin of ["", "http://lab.example", "https://user:pass@lab.example", "https://lab.example/path",
    "https://lab.example?x=1", "https://lab.example#fragment", "https://lab.example?", "https://lab.example/#",
    "https://lab.example/../", " https://lab.example"]) assert.throws(() => parsePublicOrigin(origin), /WEB_PUBLIC_ORIGIN/);
  assert.equal(parsePublicOrigin("https://lab.example:8443"), "https://lab.example:8443");
});

test("web corpus directory overrides resolve to absolute paths and reject blank values", () => {
  for (const value of ["custom/corpora", path.join(os.tmpdir(), "custom", "corpora")]) {
    const { corpusDirectory } = readWebRuntimeConfig({ WEB_CORPUS_DIR: value });
    assert.equal(corpusDirectory, path.resolve(value));
    assert.equal(path.isAbsolute(corpusDirectory), true);
  }
  for (const value of ["", " ", "\t\n"]) {
    assert.throws(() => readWebRuntimeConfig({ WEB_CORPUS_DIR: value }), /WEB_CORPUS_DIR/);
  }
});

test("unsafe corpus directories are rejected before recursive removal", async t => {
  const directory = await tempDirectory(t);
  const alias = path.join(directory, "corpora");
  await symlink(os.homedir(), alias);
  const remove = t.mock.method(fsPromises, "rm", async () => assert.fail("unsafe path reached rm"));
  try {
    for (const value of ["/", os.homedir(), os.tmpdir(), process.cwd(), path.join(directory, "other"), alias]) {
      const fixedError = { message: "WEB_CORPUS_DIR must designate a dedicated corpora directory." };
      assert.throws(() => readWebRuntimeConfig({ WEB_CORPUS_DIR: value }), fixedError);
      await assert.rejects(purgeWebCorpora(value), fixedError);
    }
    assert.equal(remove.mock.callCount(), 0);
  } finally { remove.mock.restore(); }
});

test("missing corpus directory resolves parent symlinks before rejecting a protected target", async t => {
  const directory = await tempDirectory(t);
  const parent = path.join(directory, "parent");
  const link = path.join(directory, "link");
  await mkdir(parent);
  await symlink(parent, link);
  const target = path.join(parent, "corpora");
  const configured = path.join(link, "corpora");
  await assert.rejects(readFile(target), { code: "ENOENT" });
  // Simulate a protected cwd whose final directory is absent, without changing cwd.
  const cwd = t.mock.method(process, "cwd", () => target);
  const remove = t.mock.method(fsPromises, "rm", async () => assert.fail("unsafe path reached rm"));
  try {
    const fixedError = { message: "WEB_CORPUS_DIR must designate a dedicated corpora directory." };
    assert.throws(() => readWebRuntimeConfig({ WEB_CORPUS_DIR: configured }), fixedError);
    await assert.rejects(purgeWebCorpora(configured), fixedError);
    assert.equal(remove.mock.callCount(), 0);
  } finally { remove.mock.restore(); cwd.mock.restore(); }
});

test("startup corpus purge removes stale contents without following symlinks outside the directory", async t => {
  const directory = await tempDirectory(t);
  const corpora = path.join(directory, "corpora");
  const outside = path.join(directory, "outside.json");
  await mkdir(path.join(corpora, "nested"), { recursive: true });
  await writeFile(path.join(corpora, "stale.json"), "private corpus");
  await writeFile(path.join(corpora, "nested", "stale.tmp"), "unfinished corpus");
  await writeFile(outside, "keep");
  await symlink(outside, path.join(corpora, "linked.json"));
  await purgeWebCorpora(corpora);
  assert.deepEqual(await readdir(corpora), []);
  assert.equal(await readFile(outside, "utf8"), "keep");
});

test("startup corpus purge creates a missing directory and leaves it empty", async t => {
  const corpora = path.join(await tempDirectory(t), "missing", "corpora");
  await purgeWebCorpora(corpora);
  assert.deepEqual(await readdir(corpora), []);
});

test("startup corpus purge rejects filesystem failures", async t => {
  const blocked = path.join(await tempDirectory(t), "blocked");
  await writeFile(blocked, "keep");
  await assert.rejects(purgeWebCorpora(path.join(blocked, "corpora")));
  assert.equal(await readFile(blocked, "utf8"), "keep");
});

for (const publicOrigin of [undefined, "https://lab.example", "https://lab.example:8443"]) {
  test(`HTTP origin boundary and cookies: ${publicOrigin ?? "local"}`, async t => {
    const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
    const server = createWebServer({ store, publicOrigin, ask: service(), webDirectory, reportError: noLog });
    t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const host = publicOrigin ? new URL(publicOrigin).host : `127.0.0.1:${port}`;
    const origin = publicOrigin ?? `http://${host}`;
    const request = (headers: Record<string, string> = {}, route = "/api/settings/openai", method = "GET") => new Promise<{
      status: number | undefined; headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      http.request({ hostname: "127.0.0.1", port, path: route, method, headers: { Host: host, ...headers } }, response => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers }));
        response.on("error", reject);
      }).on("error", reject).end();
    });
    // Simulate HTTPS termination at a proxy with a plain HTTP backend connection.
    const accepted = await request({ Origin: origin });
    assert.equal(accepted.status, 200);
    const cookie = accepted.headers["set-cookie"]![0];
    assert.match(cookie, /^parancu_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\//);
    assert.equal(cookie.includes("; Secure"), Boolean(publicOrigin));
    assert.doesNotMatch(cookie, /Domain=|Expires=|Max-Age=/);
    assert.equal(accepted.headers["cache-control"], "no-store");
    assert.match(String(accepted.headers["content-security-policy"]), /frame-ancestors 'none'/);
    const resumed = await request({ Cookie: cookie.split(";")[0] });
    assert.equal(resumed.status, 200, "same-origin GETs and navigation may omit Origin");
    assert.equal(resumed.headers["set-cookie"], undefined);
    const navigation = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    const landing = await request(navigation, "/");
    assert.equal(landing.status, 200);
    assert.equal(landing.headers["set-cookie"], undefined);
    assert.equal((await request({ "Sec-Fetch-Site": "cross-site" }, "/")).status, 403);
    assert.equal((await request({ ...navigation, "Sec-Fetch-Mode": "cors" }, "/")).status, 403);
    assert.equal((await request({ ...navigation, "Sec-Fetch-Dest": "iframe" }, "/")).status, 403);
    assert.equal((await request(navigation, "/", "POST")).status, 403);
    assert.equal((await request(navigation)).status, 403, "navigation metadata cannot bypass API protection");
    assert.equal((await request({ ...navigation, Host: "wrong.example" }, "/")).status, 403);
    assert.equal((await request({ ...navigation, Origin: "https://wrong.example" }, "/")).status, 403);
    const invalid: Record<string, string>[] = [
      { Host: "wrong.example" }, { Origin: "https://wrong.example" }, { Origin: "null" },
      { Origin: origin, "Sec-Fetch-Site": "cross-site" },
      { Host: "wrong.example", "X-Forwarded-Host": host, "X-Forwarded-Proto": "https", Forwarded: `host=${host};proto=https` },
      { Origin: "https://wrong.example", "X-Forwarded-Host": host, "X-Forwarded-Proto": "https" }
    ];
    if (publicOrigin) invalid.push({ Host: `localhost:${port}` }, { Origin: `http://${host}` });
    for (const headers of invalid) {
      const rejected = await request(headers);
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers["set-cookie"], undefined);
    }
    const forwarded = await request({ "X-Forwarded-Proto": publicOrigin ? "http" : "https", "X-Forwarded-Host": "wrong.example" });
    assert.equal(forwarded.status, 200);
    assert.equal(forwarded.headers["set-cookie"]![0].includes("; Secure"), Boolean(publicOrigin));
    if (!publicOrigin) {
      assert.equal((await request({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).status, 200);
      assert.equal((await request({ Host: `localhost:${port}`, Origin: `http://127.0.0.1:${port}` })).status, 403);
    }
  });
}

function enriched() {
  const corpus = prepareCorpusLocal(source, { docId: "legacy-document" });
  for (const chunk of corpus.chunks) Object.assign(chunk, {
    summary: "Colors and weights of prototypes.", guiding_question: "What color is Atlas?",
    answer_focus: "Atlas color", guiding_question_embedding: Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0),
    answer_focus_embedding: Array.from({ length: 384 }, (_, i) => i === 1 ? 1 : 0)
  });
  return corpus;
}
const sessionKey = "sk-test-session-12345678901234567890";
const environmentKey = "sk-test-environment-12345678901234567890";

function configuredKeys() {
  const keys = new KeyManager();
  keys.set(sessionKey);
  return keys;
}

function environmentPresent(t: TestContext) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = environmentKey;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
}

test("sessions validate cookies, bound capacity, expire credentials and close retained contexts", async t => {
  environmentPresent(t);
  let now = 0;
  const sessions = new SessionManager(2, 100, () => now);
  t.after(() => sessions.close());
  const first = sessions.resolve(undefined);
  const cookie = first.setCookie!.split(";")[0];
  assert.match(cookie, /^parancu_session=[A-Za-z0-9_-]{43}$/);
  assert.match(first.setCookie!, /; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.doesNotMatch(first.setCookie!, /Domain|Expires|Max-Age|Secure/);
  first.keys.set(sessionKey);
  first.claimCorpus("owned");
  first.keys.remove();
  assert.doesNotThrow(() => first.requireCorpus("owned"));
  first.keys.set(sessionKey);
  assert.equal(sessions.resolve(cookie).keys, first.keys);
  assert.equal(sessions.resolve(cookie).setCookie, undefined);
  const second = sessions.resolve(undefined, true);
  assert.match(second.setCookie!, /; Secure$/);
  assert.notEqual(second.keys, first.keys);
  assert.throws(() => second.requireCorpus("owned"), WebError);
  assert.equal(await second.keys.context(loadOpenAIKey), null);
  for (const invalid of [SESSION_COOKIE, `${SESSION_COOKIE}=`, `${SESSION_COOKIE}=bad`,
    `${cookie}; ${cookie}`, `${SESSION_COOKIE} =${cookie.split("=")[1]}`, `${SESSION_COOKIE}="${cookie.split("=")[1]}"`]) {
    assert.throws(() => sessions.resolve(invalid), (error: unknown) => error instanceof WebError && error.status === 400);
  }
  assert.throws(() => sessions.resolve(undefined), (error: unknown) => error instanceof WebError && error.status === 429);
  assert.equal(first.keys.status().ready, true, "capacity must not evict an active key");
  await first.keys.context(async () => {
    now = 100;
    const replacement = sessions.resolve(cookie);
    assert.notEqual(replacement.setCookie!.split(";")[0], cookie);
    assert.equal(replacement.keys.status().ready, false);
    assert.throws(() => replacement.requireCorpus("owned"), WebError);
    assert.throws(() => first.requireCorpus("owned"), WebError);
    assert.throws(() => first.claimCorpus("owned"), WebError);
    assert.equal(await loadOpenAIKey(), null, "expiry closes the provider retained by running work");
  });
  assert.throws(() => first.keys.set(sessionKey), WebError);
  const unknown = sessions.resolve(`${SESSION_COOKIE}=${"A".repeat(43)}`);
  assert.notEqual(unknown.setCookie!.split(";")[0], `${SESSION_COOKIE}=${"A".repeat(43)}`);
  unknown.keys.set(sessionKey);
  unknown.claimCorpus("owned");
  await unknown.keys.context(async () => {
    sessions.close();
    assert.equal(await loadOpenAIKey(), null);
  });
  assert.throws(() => sessions.resolve(undefined), WebError);
  assert.throws(() => unknown.keys.set(sessionKey), WebError);
  assert.throws(() => unknown.requireCorpus("owned"), WebError);
  assert.throws(() => unknown.claimCorpus("owned"), WebError);
});

test("server wires cleanup to a supplied SessionManager with existing sessions", async t => {
  const directory = await tempDirectory(t);
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const info = await store.import(enriched(), "owned.json", "en");
  let now = 0;
  const deletions: Promise<void>[] = [];
  const released: string[] = [];
  const sessions = new SessionManager(2, 100, () => now, ids => { released.push(...ids); });
  t.after(() => sessions.close());
  const owner = sessions.resolve(undefined);
  owner.claimCorpus(info.id);
  const remove = store.remove.bind(store);
  t.mock.method(store, "remove", (id: string) => {
    assert.throws(() => owner.requireCorpus(info.id), WebError, "ownership is revoked before deletion starts");
    const deletion = remove(id);
    deletions.push(deletion);
    return deletion;
  });
  createWebServer({ store, sessions, ask: service(), webDirectory, reportError: noLog });
  assert.deepEqual(await readdir(directory), [`${info.id}.json`]);
  now = 100;
  sessions.resolve(undefined);
  await Promise.all(deletions);
  assert.deepEqual(released, [info.id], "existing release callback is preserved");
  assert.equal(deletions.length, 1);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(store.getReady(info.id), (error: unknown) => error instanceof WebError && error.status === 404);
});

test("expiring one session does not delete another session's corpus", async t => {
  const directory = await tempDirectory(t);
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const firstInfo = await store.import(enriched(), "first.json", "en");
  const secondInfo = await store.import(enriched(), "second.json", "en");
  let now = 0;
  const deletions: Promise<void>[] = [];
  const sessions = new SessionManager(2, 100, () => now, ids => {
    for (const id of ids) deletions.push(store.remove(id));
  });
  t.after(async () => { sessions.close(); await Promise.all(deletions); });
  const first = sessions.resolve(undefined);
  first.claimCorpus(firstInfo.id);
  now = 50;
  const second = sessions.resolve(undefined);
  second.claimCorpus(secondInfo.id);
  now = 100;
  sessions.resolve(second.setCookie!.split(";")[0]);
  await Promise.all(deletions);
  assert.throws(() => first.requireCorpus(firstInfo.id), WebError);
  assert.doesNotThrow(() => second.requireCorpus(secondInfo.id));
  assert.equal(deletions.length, 1);
  assert.deepEqual(await readdir(directory), [`${secondInfo.id}.json`]);
  assert.deepEqual((await store.getReady(secondInfo.id)).corpus, enriched());
  await assert.rejects(store.getReady(firstInfo.id), (error: unknown) => error instanceof WebError && error.status === 404);
});

test("browser sessions isolate settings, question credentials and background TXT preparation", async t => {
  environmentPresent(t);
  const preparationStarted = deferred();
  const finishPreparation = deferred();
  const preparationKeys: Array<string | null> = [];
  const store = new CorpusStore(await tempDirectory(t), {
    prepare: prepareCorpusLocal,
    enrich: async corpus => {
      preparationKeys.push(await loadOpenAIKey());
      preparationStarted.resolve();
      await finishPreparation.promise;
      preparationKeys.push(await loadOpenAIKey());
      return corpus;
    }
  }, noLog, KeyManager.checkContent);
  const observed: Array<{ key: string | null; retrievalOnly: boolean }> = [];
  const base = await startServer(t, store, async (question, corpus, retrievalOnly = false) => {
    observed.push({ key: await loadOpenAIKey(), retrievalOnly });
    return service()(question, corpus, retrievalOnly);
  }, new KeyManager());
  // Raw fetch deliberately bypasses the fixture cookie jar to model separate browsers.
  const browser = async () => {
    const page = await globalThis.fetch(base);
    await page.text();
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("set-cookie"), null);
    const settingsResponse = await globalThis.fetch(base + "/api/settings/openai");
    await settingsResponse.text();
    const cookie = settingsResponse.headers.get("set-cookie")!.split(";")[0];
    return (route: string, method = "GET", body?: unknown) => globalThis.fetch(base + route, {
      method, headers: { Cookie: cookie, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  };
  const a = await browser();
  const b = await browser();
  const otherKey = "sk-test-other-browser-12345678901234567890";
  const settings = "/api/settings/openai";
  assert.equal((await a(settings, "PUT", { key: sessionKey })).status, 200);
  assert.deepEqual(await (await b(settings)).json(), { ready: false, source: "none" });
  const imported = await b("/api/corpora/import", "POST", { corpus: enriched(), name: "shared.json", language: "en" });
  assert.equal(imported.status, 201);
  const info = await imported.json();
  const question = { corpusId: info.id, question: "What color?" };
  const ownImport = await a("/api/corpora/import", "POST", { corpus: enriched(), name: "own.json", language: "en" });
  assert.equal(ownImport.status, 201);
  const ownInfo = await ownImport.json();
  const ownQuestion = { ...question, corpusId: ownInfo.id };
  assert.equal((await a("/api/questions", "POST", question)).status, 404);
  assert.equal((await b("/api/questions", "POST", ownQuestion)).status, 404);
  assert.equal((await (await a("/api/questions", "POST", ownQuestion)).json()).result.action, "answer");
  assert.equal((await (await b("/api/questions", "POST", question)).json()).result.action, "retrieval_only");
  assert.equal((await b("/api/corpora", "POST", input)).status, 409);
  const prepared = await a("/api/corpora", "POST", input);
  assert.equal(prepared.status, 202);
  await preparationStarted.promise;
  try {
    assert.equal((await b(settings, "PUT", { key: otherKey })).status, 200);
    assert.equal((await (await b("/api/questions", "POST", question)).json()).result.action, "answer");
  } finally { finishPreparation.resolve(); }
  await store.drain();
  assert.deepEqual(preparationKeys, [sessionKey, sessionKey]);
  assert.equal((await a(settings, "DELETE")).status, 200);
  assert.equal((await (await a("/api/questions", "POST", ownQuestion)).json()).result.action, "retrieval_only");
  assert.deepEqual(await (await b(settings)).json(), { ready: true, source: "session" });
  assert.equal((await (await b("/api/questions", "POST", question)).json()).result.action, "answer");
  assert.deepEqual(observed, [
    { key: sessionKey, retrievalOnly: false }, { key: null, retrievalOnly: true },
    { key: otherKey, retrievalOnly: false }, { key: null, retrievalOnly: true },
    { key: otherKey, retrievalOnly: false }
  ]);
  assert.equal((await a(`/api/corpora/${info.id}/export`)).status, 404);
  assert.equal((await a(`/api/corpora/${ownInfo.id}/export`)).status, 200);
  assert.equal((await b(`/api/corpora/${info.id}/export`)).status, 200);
  const malformed = await globalThis.fetch(base + settings, { headers: { Cookie: `${SESSION_COOKIE}=bad` } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("set-cookie"), null);
});

test("foreign, orphaned and unknown corpora are indistinguishable before store access", async t => {
  const directory = await tempDirectory(t);
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const foreign = await store.import(enriched(), "foreign.json", "en");
  const orphan = await store.import(enriched(), "orphan.json", "en");
  const sessions = new SessionManager();
  const owner = sessions.resolve(undefined);
  owner.claimCorpus(foreign.id);
  const base = await startServer(t, store, service(), new KeyManager(), [], sessions);
  for (const method of ["getInfo", "getReady", "export"] as const) {
    t.mock.method(store, method, async () => { assert.fail("Unowned IDs must not reach CorpusStore"); });
  }
  for (const id of [foreign.id, orphan.id, "00000000-0000-4000-8000-000000000000"]) {
    for (const response of [
      await fetch(`${base}/api/corpora/${id}`),
      await fetch(`${base}/api/corpora/${id}/export`),
      await post(base, "/api/questions", { corpusId: id, question: "What color?" })
    ]) {
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Corpus not found." });
    }
  }
  assert.equal((await fetch(base + "/api/corpora")).status, 404, "there is no corpus listing API");
  assert.equal((await readdir(directory)).length, 2, "ownership denial must not delete files");
});

test("expiry during import cannot claim persisted data or restore ownership", async t => {
  let now = 0;
  const sessions = new SessionManager(8, 100, () => now);
  const directory = await tempDirectory(t);
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const base = await startServer(t, store, service(), new KeyManager(), [], sessions);
  const originalSession = sessions.resolve(browserCookies.get(base));
  const persisted = deferred();
  const release = deferred();
  const originalImport = store.import.bind(store);
  let id = "";
  t.mock.method(store, "import", async (...args: Parameters<CorpusStore["import"]>) => {
    const info = await originalImport(...args);
    id = info.id;
    persisted.resolve();
    await release.promise;
    return info;
  });
  const importing = post(base, "/api/corpora/import", { corpus: enriched(), name: "file.json", language: "en" });
  await persisted.promise;
  now = 100;
  release.resolve();
  const response = await importing;
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Corpus not found." });
  assert.throws(() => originalSession.claimCorpus(id), WebError);
  assert.throws(() => originalSession.requireCorpus(id), WebError);
  assert.equal((await fetch(`${base}/api/corpora/${id}`)).status, 404);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(store.getReady(id), (error: unknown) => error instanceof WebError && error.status === 404);
  const restarted = await startServer(t, new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog));
  assert.equal((await fetch(`${restarted}/api/corpora/${id}/export`)).status, 404, "restart must not infer ownership from disk");
});

test("TXT preparation finishing after expiry cannot restore corpus access", async t => {
  let now = 0;
  const sessions = new SessionManager(8, 100, () => now);
  const release = deferred();
  const directory = await tempDirectory(t);
  const store = new CorpusStore(directory, {
    prepare: prepareCorpusLocal, enrich: async c => { await release.promise; return c; }
  }, noLog);
  const base = await startServer(t, store, service(), configuredKeys(), [], sessions);
  const owner = sessions.resolve(browserCookies.get(base));
  const response = await post(base, "/api/corpora", input);
  assert.equal(response.status, 202);
  const info = await response.json();
  assert.doesNotThrow(() => owner.requireCorpus(info.id));
  try {
    for (const suffix of ["", "/export"]) {
      const denied = await globalThis.fetch(`${base}/api/corpora/${info.id}${suffix}`);
      assert.equal(denied.status, 404, "preparing status must not be visible to another session");
      assert.deepEqual(await denied.json(), { error: "Corpus not found." });
    }
    now = 100;
    assert.throws(() => owner.requireCorpus(info.id), WebError);
  } finally { release.resolve(); }
  await store.drain();
  await assert.rejects(store.getInfo(info.id), (error: unknown) => error instanceof WebError && error.status === 404);
  assert.throws(() => owner.claimCorpus(info.id), WebError);
  assert.equal((await fetch(`${base}/api/corpora/${info.id}`)).status, 404);
  assert.equal((await post(base, "/api/questions", { corpusId: info.id, question: "What color?" })).status, 404);
  assert.deepEqual(await readdir(directory), []);
});

for (const operation of ["status", "export", "question"] as const) {
  test(`expiry during asynchronous ${operation} work prevents returning corpus data`, async t => {
    let now = 0;
    const sessions = new SessionManager(8, 100, () => now);
    const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
    const info = await store.import(enriched(), "file.json", "en");
    const started = deferred();
    const release = deferred();
    const wait = async () => { started.resolve(); await release.promise; };
    const ask = service();
    const base = await startServer(t, store, async (q, c, retrievalOnly) => {
      const result = await ask(q, c, retrievalOnly);
      await wait();
      return result;
    }, new KeyManager(), [info.id], sessions);
    if (operation === "status") {
      const getInfo = store.getInfo.bind(store);
      t.mock.method(store, "getInfo", async (id: string) => { const result = await getInfo(id); await wait(); return result; });
    } else if (operation === "export") {
      const exportCorpus = store.export.bind(store);
      t.mock.method(store, "export", async (id: string) => { const result = await exportCorpus(id); await wait(); return result; });
    }
    const pending = operation === "question"
      ? post(base, "/api/questions", { corpusId: info.id, question: "What color?" })
      : fetch(`${base}/api/corpora/${info.id}${operation === "export" ? "/export" : ""}`);
    await started.promise;
    now = 100;
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Corpus not found." });
  });
}

test("web memory keys ignore the environment before use, after removal, and after shutdown", async t => {
  environmentPresent(t);
  const keys = new KeyManager();
  assert.deepEqual(keys.status(), { ready: false, source: "none" });
  assert.throws(() => keys.run(() => {}), WebError);
  keys.set(sessionKey);
  assert.equal(await keys.run(loadOpenAIKey), sessionKey);
  assert.deepEqual(keys.status(), { ready: true, source: "session" });
  await keys.run(async () => {
    keys.remove();
    assert.equal(await loadOpenAIKey(), null, "an active web context must not fall back to the environment");
  });
  assert.deepEqual(keys.status(), { ready: false, source: "none" });
  assert.throws(() => keys.run(loadOpenAIKey), WebError);
  keys.set(sessionKey); keys.close();
  assert.deepEqual(keys.status(), { ready: false, source: "none" });
  assert.throws(() => keys.set(sessionKey), WebError);
  assert.equal(process.env.OPENAI_API_KEY, environmentKey, "web settings must not mutate the environment");
});

test("removal affects subsequent requests within an existing async context", async () => {
  const keys = new KeyManager();
  keys.set(sessionKey);
  await keys.run(async () => {
    assert.equal(await loadOpenAIKey(), sessionKey);
    keys.remove();
    assert.equal(await loadOpenAIKey(), null);
  });
});

test("HTTP Use key and Remove key switch retrieval-only questions despite environment credentials", async t => {
  environmentPresent(t);
  const directory = await tempDirectory(t);
  let enrichCalls = 0;
  const keys = new KeyManager();
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => { enrichCalls++; return c; } }, noLog);
  const base = await startServer(t, store, service(), keys);
  assert.deepEqual(await (await fetch(base + "/api/settings/openai")).json(), { ready: false, source: "none" });
  assert.equal((await post(base, "/api/corpora", input)).status, 409);
  assert.equal((await post(base, "/api/questions", { corpusId: "x", question: "Question?" })).status, 404);
  const imported = await post(base, "/api/corpora/import", { corpus: enriched(), name: "Atlas.prepared.json", language: "en" });
  assert.equal(imported.status, 201);
  const info = await imported.json();
  assert.equal(info.origin, "imported");
  assert.equal(info.status, "ready");
  const initialLocal = await post(base, "/api/questions", { corpusId: info.id, question: "What color?" });
  assert.equal(initialLocal.status, 200);
  assert.equal((await initialLocal.json()).result.action, "retrieval_only");
  const configured = await fetch(base + "/api/settings/openai", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: sessionKey }) });
  assert.equal(configured.status, 200);
  assert.deepEqual(await configured.json(), { ready: true, source: "session" });
  const question = await post(base, "/api/questions", { corpusId: info.id, question: "What color?" });
  assert.equal(question.status, 200);
  assert.equal((await question.json()).result.action, "answer");
  assert.equal(enrichCalls, 0, "import must not enrich");
  assert.equal((await post(base, "/api/corpora", input)).status, 202);
  await store.drain();
  assert.equal(enrichCalls, 1, "the user key enables TXT preparation");
  assert.deepEqual(await (await fetch(base + "/api/settings/openai", { method: "DELETE" })).json(), { ready: false, source: "none" });
  assert.deepEqual(await (await fetch(base + "/api/settings/openai")).json(), { ready: false, source: "none" });
  assert.equal((await post(base, "/api/corpora", input)).status, 409);
  assert.equal((await post(base, "/api/corpora/import", { corpus: enriched(), name: "second.json", language: "en" })).status, 201);
  const local = await post(base, "/api/questions", { corpusId: info.id, question: "What color?" });
  assert.equal(local.status, 200);
  const localResult = await local.json();
  assert.equal(localResult.result.action, "retrieval_only");
  assert.deepEqual(localResult.retrievedEvidence.map((item: { status: string }) => item.status), ["not_evaluated", "not_evaluated", "not_evaluated"]);
  assert.equal((await fetch(base + "/api/corpora/" + info.id + "/export")).status, 200);
  const disk = await readFile(path.join(directory, info.id + ".json"), "utf8");
  assert.ok(!disk.includes(sessionKey));
});

test("strict import rejects incomplete metadata, invalid units, dimensions, vectors and incompatible schema", () => {
  const good = enriched();
  assert.deepEqual(validatePreparedCorpus(good), good);
  const mutations: Array<(value: any) => void> = [
    v => { v.unknown = "secret"; }, v => { v.chunks[0].apiKey = sessionKey; },
    v => { delete v.chunks[0].summary; }, v => { v.chunks[0].answer_focus = ""; },
    v => { v.sentences[1].id = 0; }, v => { v.sentences[0].start = -1; },
    v => { v.sentences[1].start = 0; }, v => { v.chunks[0].sentence_ids = [999]; },
    v => { v.chunks[0].text = "Different text."; }, v => { v.chunks[0].endSentence = 900; },
    v => { v.chunks[0].id = 4; }, v => { v.chunks[0].guiding_question_embedding.pop(); },
    v => { v.chunks[0].answer_focus_embedding = Array(384).fill(0); },
    v => { v.chunks[0].answer_focus_embedding[0] = Infinity; },
    v => { v.chunks[0].answer_focus_embedding[0] = "1"; },
    v => { v.chunks[0].summary = sessionKey; }
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(good); mutate(bad);
    assert.throws(() => validatePreparedCorpus(bad));
  }
  const exportData = importCorpus(good, { name: "Atlas.prepared.json", language: "it" });
  assert.throws(() => importCorpus({ ...exportData, formatVersion: 2 }, { name: "", language: "" }));
  assert.throws(() => importCorpus({ ...exportData, embedding: { model: "other", dimensions: 384 } }, { name: "", language: "" }));
  assert.throws(() => importCorpus({ ...exportData, sourceFilename: "../escape.txt" }, { name: "", language: "" }));
  assert.throws(() => importCorpus({ ...exportData, createdAt: "yesterday" }, { name: "", language: "" }));
});

test("HTTP malformed JSON and invalid schema are rejected without preparation", async t => {
  const store = new CorpusStore(await tempDirectory(t), {
    prepare: () => { throw new Error("must not prepare"); }, enrich: async () => { throw new Error("must not enrich"); }
  }, noLog);
  const base = await startServer(t, store);
  const malformed = await fetch(base + "/api/corpora/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.match(await malformed.text(), /Invalid JSON/);
  const response = await post(base, "/api/corpora/import", { corpus: { docId: "bad", sentences: [], chunks: [] }, name: "x.json", language: "en" });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Invalid or incompatible/);
});

test("export round-trip preserves exact workflow corpus and metadata across restart without enrichment", async t => {
  const directory = await tempDirectory(t);
  const dependencies = { prepare: () => { throw new Error("must not prepare"); }, enrich: async () => { throw new Error("must not enrich"); } };
  const store = new CorpusStore(directory, dependencies, noLog);
  const original = enriched();
  const info = await store.import(original, "Atlas.prepared.json", "it");
  const base = await startServer(t, store, service(), configuredKeys(), [info.id]);
  const response = await fetch(base + "/api/corpora/" + info.id + "/export");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition")!, /Atlas.prepared.json/);
  const exported = await response.json();
  assert.equal(exported.formatVersion, 1);
  assert.equal(exported.sourceFilename, "Atlas.txt");
  assert.equal(exported.language, "it");
  assert.equal(exported.createdAt, info.createdAt);
  assert.deepEqual(exported.corpus, (await store.getReady(info.id)).corpus);
  const restarted = new CorpusStore(directory, dependencies, noLog);
  assert.deepEqual(await restarted.export(info.id), exported);
  const reimported = await restarted.import(exported, "ignored.json", "en");
  assert.deepEqual(await restarted.export(reimported.id), exported);
  assert.deepEqual((await restarted.getReady(reimported.id)).corpus, original);
  assert.equal(exportFilename('<unsafe "name">.txt'), "unsafe-name.prepared.json");
  assert.equal(exportFilename("CON.txt"), "document-CON.prepared.json");
});

test("TXT preparation exports the exact enriched corpus", async t => {
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal,
    enrich: async c => ({ ...enriched(), docId: c.docId }) }, noLog);
  const info = store.create(input); await store.drain();
  const exported = await store.export(info.id);
  assert.equal(exported.sourceFilename, input.name);
  assert.deepEqual(exported.corpus, (await store.getReady(info.id)).corpus);
});

test("secrets are rejected before persistence, workflow, or logs and cannot be exported", async t => {
  const keys = new KeyManager();
  keys.set(sessionKey);
  const logs: unknown[] = [];
  const directory = await tempDirectory(t);
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async () => { throw new Error(sessionKey); } },
    error => logs.push(error), value => keys.checkContent(value));
  const base = await startServer(t, store, service(), keys);
  for (const key of [sessionKey, environmentKey]) {
    const response = await post(base, "/api/corpora", { ...input, text: key });
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes(key));
    const bad = enriched(); bad.chunks[0].summary = key;
    const rejected = await post(base, "/api/corpora/import", { corpus: bad, name: "file.json", language: "en" });
    assert.equal(rejected.status, 400); assert.ok(!(await rejected.text()).includes(key));
  }
  const prepared = store.create(input); await store.drain();
  assert.equal((await store.getInfo(prepared.id)).status, "failed");
  assert.equal(logs.length, 1);
  assert.ok(!logs.map(String).join("").includes(sessionKey));
  assert.deepEqual(await readdir(directory), []);
  assert.throws(() => keys.checkContent({ question: sessionKey }), WebError);
});

test("real generation and verification use the memory key; upstream failures cannot leak into graph errors", async t => {
  const keys = new KeyManager(); keys.set(sessionKey);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    assert.equal((options.headers as Record<string, string>).Authorization, "Bearer " + sessionKey);
    assert.ok(!String(options.body).includes(sessionKey));
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ output_text: "Atlas is blue." }));
    if (calls === 2) return new Response(JSON.stringify({ output_text: '{"claims":[{"claim":"Atlas is blue.","supported":true,"evidenceQuote":"Atlas is blue."}],"questionCovered":true,"conceptConflation":false,"missingConcepts":[],"reason":"Direct support."}' }));
    return new Response(JSON.stringify({ error: { message: sessionKey } }), { status: 401 });
  });
  const ask = createWorkflowService({ retrieveCandidates: async () => [candidate(0, "Atlas is blue.")],
    generateAnswer: generateResponse, verifyAnswer: verifyEvidence });
  const response = await keys.run(() => ask("What color?", enriched()));
  assert.equal(response.result.action, "answer");
  await assert.rejects(keys.run(() => ask("What color?", enriched())), error => {
    assert.ok(error instanceof Error);
    assert.ok(!String(error).includes(sessionKey));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 3);
});

test("shutdown timeout defaults and strictly validates overrides", () => {
  assert.equal(readWebShutdownTimeout({}), 15_000);
  assert.equal(readWebShutdownTimeout({ WEB_SHUTDOWN_TIMEOUT_MS: "1234" }), 1234);
  for (const value of ["", "0", "-1", "1.5", " 2", "2e2", "Infinity", "9007199254740992"]) {
    assert.throws(() => readWebRuntimeConfig({ WEB_SHUTDOWN_TIMEOUT_MS: value }), /WEB_SHUTDOWN_TIMEOUT_MS/);
  }
});

test("graceful shutdown completes and clears its deadline", async t => {
  const token = {} as ReturnType<typeof setTimeout>;
  const timer = t.mock.method(globalThis, "setTimeout", () => token);
  const clear = t.mock.method(globalThis, "clearTimeout", () => {});
  const steps: string[] = [];
  await withShutdownDeadline(async () => {
    steps.push("draining", "sessions");
    await Promise.resolve();
    steps.push("http", "corpus", "cleanup");
  }, 1234);
  assert.deepEqual(steps, ["draining", "sessions", "http", "corpus", "cleanup"]);
  assert.equal(timer.mock.calls[0].arguments[1], 1234);
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(clear.mock.calls[0].arguments[0], token);
});

test("stalled shutdown stops waiting at its deadline with a fixed error", async t => {
  let expire!: () => void;
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => {
    expire = callback;
    return {} as ReturnType<typeof setTimeout>;
  });
  const clear = t.mock.method(globalThis, "clearTimeout", () => {});
  const started = deferred();
  const pending = deferred();
  const shutdown = withShutdownDeadline(async () => {
    started.resolve();
    await pending.promise;
  }, 15_000);
  const rejected = assert.rejects(shutdown, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Server shutdown timed out.");
    assert.equal(error.cause, undefined);
    return true;
  });
  await started.promise;
  expire();
  await rejected;
  assert.equal(clear.mock.callCount(), 1);
  pending.resolve();
});

test("OpenAI timeout configuration defaults and strictly validates overrides", () => {
  assert.equal(readWebOpenAITimeout({}), 30_000);
  assert.equal(readWebOpenAITimeout({ WEB_OPENAI_TIMEOUT_MS: "1234" }), 1234);
  for (const value of ["", "0", "-1", "1.5", " 2", "2e2", "Infinity", "9007199254740992"]) {
    assert.throws(() => readWebRuntimeConfig({ WEB_OPENAI_TIMEOUT_MS: value }), /WEB_OPENAI_TIMEOUT_MS/);
  }
});

test("OpenAI timeout aborts stalled fetch and response bodies with sanitized errors", async t => {
  const keys = configuredKeys();
  for (const phase of ["fetch", "body"]) {
    let expire!: () => void;
    let signal!: AbortSignal;
    let delay: number | undefined;
    const started = deferred();
    const timer = t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => {
      expire = callback;
      delay = ms;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clear = t.mock.method(globalThis, "clearTimeout", () => {});
    const transport = t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
      signal = options!.signal!;
      const stalled = () => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(sessionKey)), { once: true });
        started.resolve();
      });
      if (phase === "fetch") return stalled();
      return { ok: true, json: stalled } as unknown as Response;
    });
    const request = keys.run(() => requestOpenAI({ input: "private prompt" }));
    const rejected = assert.rejects(request, error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "OpenAI request failed. Check your key, account access, and connection.");
      assert.equal(error.cause, undefined);
      return true;
    });
    await started.promise;
    assert.equal(delay, readWebOpenAITimeout());
    assert.equal(signal.aborted, false);
    expire();
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(clear.mock.callCount(), 1);
    transport.mock.restore(); clear.mock.restore(); timer.mock.restore();
  }
});

test("successful OpenAI requests preserve their payload and clear the deadline", async t => {
  const clear = t.mock.method(globalThis, "clearTimeout", () => {});
  t.mock.method(globalThis, "setTimeout", () => 1 as unknown as ReturnType<typeof setTimeout>);
  let signal!: AbortSignal;
  const payload = { output_text: "Atlas is blue." };
  t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    signal = options!.signal!;
    return new Response(JSON.stringify(payload));
  });
  assert.deepEqual(await configuredKeys().run(() => requestOpenAI({})), payload);
  assert.equal(signal.aborted, false);
  assert.equal(clear.mock.callCount(), 1);
});

test("transport exceptions and successful payloads containing credentials are sanitized", async t => {
  const keys = configuredKeys();
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error(sessionKey); });
  await assert.rejects(keys.run(() => requestOpenAI({})), error => {
    assert.ok(error instanceof Error && !String(error).includes(sessionKey) && !error.cause);
    return true;
  });
  mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: sessionKey })));
  await assert.rejects(keys.run(() => requestOpenAI({})), /OpenAI request failed/);
});

test("JSON-escaped credentials in verifier output never become a returned reason", async t => {
  const keys = configuredKeys();
  // The credential is encoded inside output_text, so it emerges only after verifier JSON parsing.
  const encoded = sessionKey.split("").map(c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    output_text: '{"claims":[{"claim":"Atlas is blue.","supported":true,"evidenceQuote":"Atlas is blue."}],"questionCovered":true,"conceptConflation":false,"missingConcepts":[],"reason":"' + encoded + '"}'
  })));
  await assert.rejects(keys.run(() => verifyEvidence("question", "answer", "evidence")), error => {
    assert.ok(error instanceof Error && !String(error).includes(sessionKey) && !error.cause);
    return true;
  });
});
test("UI imports without a key and preserves the visible corpus across active-tab clicks and key changes", async t => {
  const store = new CorpusStore(await tempDirectory(t), {
    prepare: () => { throw new Error("Import must not prepare"); },
    enrich: async () => { throw new Error("Import must not enrich"); }
  }, noLog);
  const base = await startServer(t, store, service(), new KeyManager());
  const html = await readFile(path.join(webDirectory, "index.html"), "utf8");
  const nodes = new Map<string, any>();
  // Only actual HTML IDs exist: unlike the previous UI stub, missing nodes fail.
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const listeners = new Map<string, (...args: any[]) => unknown>();
    nodes.set(match[1], {
      value: match[1] === "language" ? "en" : "", files: [], textContent: "",
      hidden: /\bhidden\b/.test(match[0]), disabled: /\bdisabled\b/.test(match[0]),
      classList: { toggle() {}, add() {} }, setAttribute() {}, replaceChildren() {}, focus() {},
      showModal() {}, close() { listeners.get("close")?.(); },
      addEventListener(name: string, listener: (...args: any[]) => unknown) { listeners.set(name, listener); },
      fire(name: string) { return listeners.get(name)?.({ preventDefault() {} }); }
    });
  }
  const node = (id: string) => { assert.ok(nodes.has(id), `HTML element ${id} exists`); return nodes.get(id); };
  const storage = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  const requests: string[] = [];
  let delayedStatus: { captured: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; done: ReturnType<typeof deferred> } | undefined;
  const context = vm.createContext({
    document: { getElementById: (id: string) => nodes.get(id) ?? null },
    window: { addEventListener() {} }, TextDecoder, TextEncoder, Blob,
    URL: { createObjectURL: (blob: Blob) => { blobs.set("blob:browser-corpus", blob); return "blob:browser-corpus"; },
      revokeObjectURL: (url: string) => blobs.delete(url) },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    fetch: async (url: string, options?: RequestInit) => {
      requests.push(`${options?.method ?? "GET"} ${url}`);
      const delay = url === "/api/settings/openai" && !options?.method ? delayedStatus : undefined;
      const response = await fetch(base + url, options);
      if (!delay) return response;
      const data = await response.json();
      delay.captured.resolve();
      await delay.release.promise;
      return { ok: response.ok, json: async () => { delay.done.resolve(); return data; } };
    }
  });
  vm.runInContext(new TextDecoder().decode(await browserBundle()), context);
  vm.runInContext(await readFile(path.join(webDirectory, "app.js"), "utf8"), context);
  await vm.runInContext("refreshKeyStatus()", context);
  assert.equal(node("key-status").textContent, "OpenAI key missing");
  assert.equal(node("ask").disabled, true);
  node("document-file").files = [{ name: "example.txt", size: 10 }];
  node("document-file").fire("change");
  assert.equal(node("prepare").disabled, true, "TXT preparation needs a key");
  assert.equal(node("mode-import").disabled, false);
  node("mode-import").fire("click");
  const bytes = Buffer.from(JSON.stringify(enriched()));
  node("document-file").files = [{ name: "Atlas.prepared.json", size: bytes.length,
    arrayBuffer: async () => bytes }];
  node("document-file").fire("change");
  assert.equal(node("prepare").disabled, false, "local import needs no key");
  await node("prepare").fire("click");
  const assertLoaded = () => {
    assert.equal(vm.runInContext("corpus.owner", context), "browser");
    assert.equal(storage.size, 0, "browser corpus never enters storage");
    assert.equal(node("selected-file").hidden, false);
    assert.equal(node("file-name").textContent, "Atlas.txt");
    assert.equal(node("document-badge").textContent, "Document ready");
    assert.equal(node("corpus-stats").hidden, false);
    assert.equal(node("chunk-count").textContent, String(enriched().chunks.length));
    assert.equal(node("sentence-count").textContent, String(enriched().sentences.length));
    assert.equal(node("corpus-origin").hidden, false);
    assert.match(node("corpus-origin").textContent, /Imported/);
    assert.equal(node("export-corpus").hidden, false);
    assert.equal(node("export-corpus").href, "blob:browser-corpus");
    assert.equal(node("error").hidden, true);
  };
  assertLoaded();
  node("mode-import").fire("click");
  assertLoaded();
  assert.match(node("document-status").textContent, /loaded.*Retrieval-only/);
  assert.equal(node("question").disabled, false);
  assert.equal(node("ask").disabled, false);
  assert.deepEqual(JSON.parse(await blobs.get(node("export-corpus").href)!.text()).corpus, enriched());
  const finishSettings = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!vm.runInContext("settingsBusy", context)) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("Settings request did not finish");
  };
  // Opening Settings starts a GET. Hold its old 'missing' response until PUT succeeds.
  delayedStatus = { captured: deferred(), release: deferred(), done: deferred() };
  node("settings").fire("click");
  await delayedStatus.captured.promise;
  node("openai-key").value = sessionKey;
  node("key-form").fire("submit");
  await finishSettings();
  delayedStatus.release.resolve();
  await delayedStatus.done.promise;
  await new Promise(resolve => setImmediate(resolve));
  delayedStatus = undefined;
  assertLoaded();
  assert.equal(node("question").value, "", "readiness must not require prefilled text");
  assert.equal(node("key-status").textContent, "OpenAI ready");
  assert.equal(node("question").disabled, false);
  assert.equal(node("ask").disabled, false);
  node("settings").fire("click");
  node("remove-key").fire("click");
  await finishSettings();
  assertLoaded();
  assert.equal(node("key-status").textContent, "OpenAI key missing");
  assert.equal(node("question").disabled, false);
  assert.equal(node("ask").disabled, false);
  assert.match(node("document-status").textContent, /loaded.*Retrieval-only/);
  node("openai-key").value = sessionKey;
  node("key-form").fire("submit");
  await finishSettings();
  assertLoaded();
  assert.equal(node("question").disabled, false);
  assert.equal(node("ask").disabled, false);
  assert.equal(requests.filter(r => r === "POST /api/corpora/import").length, 0);
  assert.ok(requests.every(r => r.includes("/api/settings/openai")), "only independent Settings calls reach the server");
  assert.ok(!requests.includes("POST /api/corpora"));
  assert.ok(!requests.includes("POST /api/questions"));
  // Switching explicitly to a new TXT verifies its independent credential gate.
  node("mode-txt").fire("click");
  assert.equal(blobs.size, 0, "switching corpus releases the export Blob");
  node("document-file").files = [{ name: "example.txt", size: 10 }];
  node("document-file").fire("change");
  assert.equal(node("prepare").disabled, false);
  node("remove-key").fire("click");
  await finishSettings();
  assert.equal(node("prepare").disabled, true);
});

test("browser corpus validation preserves the server format and rejects malformed imports", async () => {
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(new TextDecoder().decode(await browserBundle()), context);
  const browser = context.ParancUBrowser;
  const legacy = enriched();
  const payload = browser.importPrepared(JSON.stringify(legacy), "Atlas.prepared.json", "it");
  assert.deepEqual(JSON.parse(JSON.stringify(payload.corpus)), legacy);
  assert.equal(payload.language, "it");
  assert.equal(payload.sourceFilename, "Atlas.txt");
  assert.deepEqual(JSON.parse(JSON.stringify(browser.importPrepared(JSON.stringify(payload), "ignored.json", "en"))),
    JSON.parse(JSON.stringify(payload)), "versioned exports retain their metadata and vectors");
  for (const mutate of [
    (c: any) => { c.chunks[0].guiding_question_embedding.pop(); },
    (c: any) => { c.chunks[0].sentence_ids = [999]; },
    (c: any) => { c.chunks[0].text = "different text"; },
    (c: any) => { c.secret = "unknown field"; },
    (c: any) => { c.chunks[0].guiding_question_embedding.fill(0); },
    (c: any) => { c.chunks[0].summary = sessionKey; }
  ]) {
    const value = enriched(); mutate(value);
    assert.throws(() => browser.importPrepared(JSON.stringify(value), "a.json", "en"));
  }
  assert.throws(() => browser.importPrepared("{", "a.json", "en"), /Invalid JSON/);
  assert.throws(() => browser.importPrepared(" ".repeat(32 * 1024 * 1024 + 1), "a.json", "en"), /32 MiB/);
  assert.throws(() => browser.importPrepared(JSON.stringify({ chunks: Array(257).fill({}) }), "a.json", "en"), /256 chunk/);
});

async function deterministicBrowserClient() {
  const options = browserBuildOptions();
  // Only replace E5 inference, never the scorer or corpus validator.
  options.plugins!.push({ name: "fixed-query-vector", setup(builder) {
    builder.onLoad({ filter: /[/\\]browser[/\\]e5\.ts$/ }, () => ({
      contents: "export async function embedOne() { return Array.from({length:384}, (_, i) => i === 0 ? 1 : 0); }",
      loader: "ts"
    }));
  } });
  const compiled = await build(options);
  const context = vm.createContext({ TextEncoder, console: { log: noLog } });
  vm.runInContext(compiled.outputFiles![0].text, context);
  return { browser: context.ParancUBrowser, options };
}

test("browser retrieval uses the unchanged production scorer, default weights, indices and Top-5 ordering", async () => {
  const { browser, options } = await deterministicBrowserClient();
  const referenceBuild = await build({ ...options,
    entryPoints: [path.resolve(__dirname, "../../services/parancu-api/src/local/retrieval.ts")], globalName: "Reference" });
  const referenceContext = vm.createContext({ console: { log: noLog } });
  vm.runInContext(referenceBuild.outputFiles![0].text, referenceContext);
  let offset = 0;
  const sentences = ["LUNAR chemistry.", "LUNAR rocks.", "chemistry minerals.", "Other topic.",
    "Other topic.", "Other topic.", "Other topic."].map((text, id) => {
    const s = { id, text, start: offset, end: offset + text.length }; offset = s.end + 1; return s;
  });
  const fixture = { docId: "rank-fixture", sentences, chunks: sentences.map(s => ({
    id: s.id, startSentence: s.id, endSentence: s.id + 1, sentence_ids: [s.id], text: s.text,
    summary: s.text, guiding_question: s.text, answer_focus: "compatibility only",
    guiding_question_embedding: Array.from({ length: 384 }, (_, i) => i === (s.id === 1 ? 1 : 0) ? (s.id === 6 ? -1 : 1) : 0),
    answer_focus_embedding: Array.from({ length: 384 }, (_, i) => i === 1 ? 1 : 0)
  })) };
  const payload = browser.importPrepared(JSON.stringify(fixture), "fixture.json", "en");
  for (const question of ["LUNAR", "minerals", "What topic is described?"]) {
    const expected = await referenceContext.Reference.retrieveCandidatesFromPrepared(question, fixture, 5);
    const actual = await browser.retrieve(question, payload);
    assert.equal(actual.result.action, "retrieval_only");
    assert.deepEqual(JSON.parse(JSON.stringify(actual.retrievedEvidence)), JSON.parse(JSON.stringify(expected.map((c: RetrieveResult, i: number) => ({
      chunkIndex: c.chunk_index, text: c.chunk, summary: c.summary, candidateRank: i + 1, score: c.score, status: "not_evaluated"
    })))));
    assert.equal(actual.retrievedEvidence.length, 5);
  }
  const semanticOnly = await browser.retrieve("What topic is described?", payload);
  assert.deepEqual(Array.from(semanticOnly.retrievedEvidence, (c: any) => c.chunkIndex), [0, 2, 3, 4, 5], "stable ties preserve original indices");
  assert.ok(semanticOnly.retrievedEvidence.every((c: any) => c.score === 0.65));
  const anchors = await browser.retrieve("LUNAR", payload);
  assert.equal(anchors.retrievedEvidence[0].score, 0.999, "public retrieval scores preserve the production 0.999 cap");
  const rare = await browser.retrieve("minerals", payload);
  assert.equal(rare.retrievedEvidence[0].chunkIndex, 2);
  assert.equal(rare.retrievedEvidence[0].score, 0.65 + (1 - 0.65) / 3, "rare lowercase evidence uses the one-third component");
});

test("browser-owned import, question and export stay in memory even with an OpenAI key; reload clears them", async () => {
  const { browser } = await deterministicBrowserClient();
  const script = await readFile(path.join(webDirectory, "app.js"), "utf8");
  const requests: string[] = [];
  const stored = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  const makePage = () => {
    const nodes = new Map<string, any>();
    const makeNode = () => ({ value: "", files: [] as any[], textContent: "", hidden: false, disabled: false, className: "",
      children: [] as any[], listeners: new Map<string, any>(), attributes: new Map<string, string>(),
      classList: { toggle() {}, add() {} }, focus() {},
      setAttribute(key: string, value: string) { this.attributes.set(key, value); },
      append(...items: any[]) { this.children.push(...items); }, replaceChildren() { this.children = []; },
      addEventListener(name: string, listener: any) { this.listeners.set(name, listener); }
    });
    const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); };
    node("language").value = "en";
    const lifecycle = new Map<string, Array<() => void>>();
    const context = vm.createContext({ ParancUBrowser: browser, TextDecoder, Blob,
      URL: { createObjectURL: (blob: Blob) => { blobs.set("blob:private", blob); return "blob:private"; },
        revokeObjectURL: (url: string) => blobs.delete(url) },
      document: { getElementById: node, createElement: makeNode },
      window: { addEventListener(name: string, fn: () => void) { lifecycle.set(name, [...(lifecycle.get(name) ?? []), fn]); } },
      localStorage: { getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
      fetch: async (url: string) => {
        requests.push(url);
        assert.equal(url, "/api/settings/openai", "no corpus/question/evidence API is permitted");
        return { ok: true, json: async () => ({ ready: true, source: "session" }) };
      }
    });
    vm.runInContext(script, context);
    return { context, node, lifecycle };
  };
  const first = makePage();
  await vm.runInContext("refreshKeyStatus()", first.context);
  const fire = (id: string, event: string) => first.node(id).listeners.get(event)({ preventDefault() {} });
  fire("mode-import", "click");
  const bytes = Buffer.from(JSON.stringify(enriched()));
  first.node("document-file").files = [{ name: "private.json", size: bytes.length, arrayBuffer: async () => bytes }];
  fire("document-file", "change");
  await fire("prepare", "click");
  assert.equal(vm.runInContext("corpus.owner", first.context), "browser");
  assert.equal(stored.size, 0);
  assert.equal(first.node("ask").textContent, "Find evidence →");
  assert.match(first.node("question-hint").textContent, /Generate\/Verify is unavailable/);
  assert.equal(first.node("export-corpus").href, "blob:private");
  const exported = JSON.parse(await blobs.get("blob:private")!.text());
  assert.deepEqual(exported.corpus, enriched());
  assert.equal(exported.formatVersion, 1);
  const before = requests.length;
  first.node("question").value = "What color is Atlas?";
  await fire("question-form", "submit");
  assert.equal(requests.length, before, "asking imported-corpus questions makes no network request");
  assert.equal(first.node("answer-badge").textContent, "RETRIEVAL ONLY");
  assert.match(first.node("answer-text").textContent, /Browser ParancU/);
  assert.ok(first.node("evidence-list").children.length > 0);
  assert.equal(first.node("step-generate").className, "");
  assert.equal(first.node("step-verify").className, "");
  assert.equal(stored.size, 0);
  first.lifecycle.get("pagehide")!.forEach(fn => fn());
  assert.equal(blobs.size, 0);
  assert.equal(vm.runInContext("browserCorpus", first.context), null);
  const second = makePage();
  await vm.runInContext("refreshKeyStatus()", second.context);
  assert.equal(vm.runInContext("corpus", second.context), null);
  assert.equal(second.node("ask").disabled, true);
  assert.ok(requests.every(url => url === "/api/settings/openai"));
});

test("browser runtime assets retain Host/origin checks and do not resolve sessions", async t => {
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const sessions = new SessionManager();
  const base = await startServer(t, store, service(), new KeyManager(), [], sessions);
  const resolve = t.mock.method(sessions, "resolve", () => assert.fail("public assets allocated a session"));
  const response = await globalThis.fetch(base + "/parancu-browser/client.js");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.match(response.headers.get("content-security-policy")!, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(response.headers.get("content-security-policy")!, /'unsafe-eval'/);
  assert.match(await response.text(), /ParancUBrowser/);
  assert.equal((await globalThis.fetch(base + "/parancu-browser/client.js", { headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal((await globalThis.fetch(base + "/parancu-browser/ort/package.json")).status, 404);
  assert.equal((await globalThis.fetch(base + "/parancu-browser/e5/private.json")).status, 404);
  assert.equal(resolve.mock.callCount(), 0);
});

test("browser model response is chunked and delivers data before the source finishes", async t => {
  const directory = await tempDirectory(t);
  const fixture = path.join(directory, "model.onnx");
  await writeFile(fixture, "firstsecond");
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const base = await startServer(t, store, service(), new KeyManager());
  const modelPath = path.resolve(__dirname, "../../services/parancu-api/assets/models/e5/model_int8.onnx");
  const originalStat = fsPromises.stat;
  t.mock.method(fsPromises, "stat", async (filename: fs.PathLike) => {
    assert.equal(filename, modelPath);
    return originalStat(fixture);
  });
  const source = new PassThrough();
  const stream = t.mock.method(fs, "createReadStream", (filename: fs.PathLike) => {
    assert.equal(filename, modelPath);
    return source as unknown as fs.ReadStream;
  });
  try {
    source.write("first");
    const response = await globalThis.fetch(base + "/parancu-browser/e5/model_int8.onnx");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("transfer-encoding"), "chunked");
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(Buffer.from(first.value!).toString(), "first");
    assert.equal(source.writableEnded, false, "response starts before the model stream ends");
    source.end("second");
    let rest = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += Buffer.from(chunk.value).toString();
    }
    assert.equal(rest, "second");
    assert.equal(stream.mock.callCount(), 1);
  } finally { source.destroy(); }
});

test("Settings UI reflects server key state, clears input, closes on Use key, and switches to local retrieval after removal", async t => {
  environmentPresent(t);
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const base = await startServer(t, store, service(), new KeyManager());
  const nodes = new Map<string, any>();
  function node(id: string) {
    if (!nodes.has(id)) {
      const listeners = new Map<string, () => void>();
      nodes.set(id, {
        value: "", textContent: "", disabled: false, hidden: false, open: false,
        classList: { toggle() {}, add() {} },
        setAttribute() {}, replaceChildren() {},
        addEventListener(name: string, listener: () => void) { listeners.set(name, listener); },
        showModal() { this.open = true; },
        close() { this.open = false; listeners.get("close")?.(); }
      });
    }
    return nodes.get(id);
  }
  const writes: unknown[] = [];
  const context = vm.createContext({
    document: { getElementById: node },
    window: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem: (...args: unknown[]) => writes.push(args), removeItem() {} },
    fetch: (url: string, options?: RequestInit) => fetch(base + url, options)
  });
  vm.runInContext(await readFile(path.join(webDirectory, "app.js"), "utf8"), context);
  await vm.runInContext("refreshKeyStatus()", context);
  assert.equal(node("key-status").textContent, "OpenAI key missing");
  vm.runInContext("file = {}; controls()", context);
  assert.equal(node("prepare").disabled, true);
  vm.runInContext("mode = 'import'; controls()", context);
  assert.equal(node("prepare").disabled, false, "import does not require a key");
  vm.runInContext("mode = 'txt'; corpus = {status:'ready'}; controls()", context);
  assert.equal(node("question").disabled, false);

  node("settings-dialog").showModal();
  node("openai-key").value = sessionKey;
  await vm.runInContext("updateKey(false)", context);
  assert.equal(node("openai-key").value, "");
  assert.equal(node("settings-dialog").open, false);
  assert.equal(node("key-status").textContent, "OpenAI ready");
  assert.equal(node("question").disabled, false);
  node("question").value = "What color?";
  vm.runInContext("controls()", context);
  assert.equal(node("ask").disabled, false);
  vm.runInContext("corpus = null; controls()", context);
  assert.equal(node("prepare").disabled, false);

  node("settings-dialog").showModal();
  await vm.runInContext("updateKey(true)", context);
  assert.equal(node("key-status").textContent, "OpenAI key missing");
  assert.equal(node("prepare").disabled, true);
  vm.runInContext("corpus = {status:'ready'}; controls()", context);
  assert.equal(node("question").disabled, false);
  assert.equal(node("ask").disabled, false);
  assert.deepEqual(writes, [], "key settings must not write browser storage");

  node("openai-key").value = "invalid";
  await vm.runInContext("updateKey(false)", context);
  assert.equal(node("settings-dialog").open, true, "failed submissions keep Settings open");
  assert.equal(node("openai-key").value, "");
  assert.equal(node("settings-error").hidden, false);
  assert.equal(node("key-status").textContent, "OpenAI key missing");

  // Accepted keys must close Settings even if refreshing another page control fails.
  Object.defineProperty(node("mode-txt"), "disabled", {
    set() { throw new Error("Unrelated control render failed."); }, configurable: true
  });
  node("openai-key").value = sessionKey;
  await vm.runInContext("updateKey(false)", context);
  assert.equal(node("settings-dialog").open, false);
  assert.equal(node("openai-key").value, "");
  assert.equal(node("key-status").textContent, "OpenAI ready");
});


test("retrieval-only service preserves rankings, handles empty results and never calls LLM steps", async () => {
  const corpus = enriched();
  for (const candidates of [[candidate(4, "Atlas is blue."), candidate(2, "Nova is red.")], []]) {
    let retrievals = 0;
    const forbidden = async (): Promise<never> => { assert.fail("LLM step called in retrieval-only mode"); };
    const ask = createWorkflowService({
      retrieveCandidates: async (question, active, k) => {
        retrievals++; assert.equal(question, "What color?"); assert.equal(active, corpus); assert.equal(k, 5);
        return candidates;
      }, generateAnswer: forbidden, verifyAnswer: forbidden, checkComplement: forbidden
    });
    const response = await ask("What color?", corpus, true);
    assert.equal(retrievals, 1);
    assert.deepEqual(response.result, { action: "retrieval_only", question: "What color?" });
    assert.deepEqual(response.retrievedEvidence, candidates.map((c, i) => ({
      chunkIndex: c.chunk_index, text: c.chunk, summary: c.summary,
      candidateRank: i + 1, score: c.score, status: "not_evaluated"
    })));
  }
});

test("retrieval-only UI submits questions, displays unverified evidence and skips Generate/Verify progress", async () => {
  const nodes = new Map<string, any>();
  const makeNode = () => ({
    value: "", textContent: "", hidden: false, disabled: false, className: "", children: [] as any[],
    listeners: new Map<string, any>(),
    classList: { toggle() {}, add() {} }, setAttribute() {},
    append(...items: any[]) { this.children.push(...items); },
    replaceChildren() { this.children = []; },
    addEventListener(name: string, listener: any) { this.listeners.set(name, listener); }
  });
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); };
  let requests = 0;
  const context = vm.createContext({
    document: { getElementById: node, createElement: makeNode }, window: { addEventListener() {} },
    localStorage: { getItem: () => null },
    fetch: async (url: string, options: any) => {
      if (url === "/api/settings/openai") return { ok: true, json: async () => ({ ready: false, source: "none" }) };
      requests++;
      assert.equal(url, "/api/questions");
      assert.deepEqual(JSON.parse(options.body), { corpusId: "active", question: "What color?" });
      assert.match(node("activity").textContent, /server-side ParancU retrieval without OpenAI/);
      assert.equal(node("step-generate").className, "");
      assert.equal(node("step-verify").className, "");
      return { ok: true, json: async () => ({ result: { action: "retrieval_only", question: "What color?" },
        retrievedEvidence: requests === 1 ? [{ chunkIndex: 0, candidateRank: 1, text: "Atlas is blue.", score: 0.9, status: "not_evaluated" }] : [] }) };
    }
  });
  vm.runInContext(await readFile(path.join(webDirectory, "app.js"), "utf8"), context);
  vm.runInContext('corpus = { id: "active", status: "ready" }; controls()', context);
  assert.equal(node("ask").disabled, false);
  assert.equal(node("ask").textContent, "Find evidence →");
  node("question").value = "What color?";
  await node("question-form").listeners.get("submit")({ preventDefault() {} });
  assert.equal(requests, 1);
  assert.equal(node("answer-badge").textContent, "RETRIEVAL ONLY");
  assert.match(node("answer-text").textContent, /No answer was generated or verified/);
  assert.equal(node("verification").hidden, true);
  assert.equal(node("citation").hidden, true);
  assert.equal(node("evidence-list").children[0].open, true);
  assert.equal(node("step-generate").className, "");
  await node("question-form").listeners.get("submit")({ preventDefault() {} });
  assert.equal(node("evidence-count").textContent, "0");
  assert.equal(node("evidence-list").children[0].textContent, "ParancU returned no candidates.");
});


test("resource configuration has conservative defaults and rejects invalid overrides", () => {
  assert.deepEqual(readWebLimits({}), { maxTextBytes: 1048576, maxImportBytes: 8388608,
    maxChunks: 256, maxCorpora: 32, maxCorpusDiskBytes: 67108864, maxPreparations: 1, maxQuestions: 2, maxRetrievals: 2 });
  const env = { WEB_MAX_TEXT_BYTES: "12", WEB_MAX_IMPORT_BYTES: "13", WEB_MAX_CHUNKS: "14",
    WEB_MAX_CORPORA: "15", WEB_MAX_CORPUS_DISK_BYTES: "16", WEB_MAX_PREPARATIONS: "2", WEB_MAX_QUESTIONS: "3", WEB_MAX_RETRIEVALS: "4" };
  assert.deepEqual(readWebLimits(env), { maxTextBytes: 12, maxImportBytes: 13, maxChunks: 14,
    maxCorpora: 15, maxCorpusDiskBytes: 16, maxPreparations: 2, maxQuestions: 3, maxRetrievals: 4 });
  for (const key of Object.keys(env)) for (const value of ["", "0", "-1", "1.5", " 2", "2e2", "Infinity", "9007199254740992"]) {
    assert.throws(() => readWebLimits({ [key]: value }), new RegExp(key));
  }
});

async function diskQuotaFixture(t: TestContext) {
  const directory = await tempDirectory(t);
  const dependencies = { prepare: prepareCorpusLocal, enrich: async (c: ReturnType<typeof enriched>) => c };
  const baseline = new CorpusStore(directory, dependencies, noLog);
  const info = await baseline.import(enriched(), "café.json", "en");
  const payload = await baseline.export(info.id);
  const bytes = (await readFile(path.join(directory, `${info.id}.json`))).byteLength;
  await baseline.remove(info.id);
  const store = new CorpusStore(directory, dependencies, noLog, undefined,
    new WebResources({ ...DEFAULT_WEB_LIMITS, maxCorpusDiskBytes: bytes }));
  return { directory, payload, bytes, store };
}

test("persisted corpus quota accepts the exact UTF-8 size, rejects excess, and is released by removal", async t => {
  const { directory, payload, bytes, store } = await diskQuotaFixture(t);
  const first = await store.import(payload, "café.json", "en");
  assert.equal((await readFile(path.join(directory, `${first.id}.json`))).byteLength, bytes);
  assert.equal((await store.getInfo(first.id)).status, "ready");
  await assert.rejects(store.import(payload, "café.json", "en"), statusIs(429));
  assert.deepEqual(await readdir(directory), [`${first.id}.json`]);
  await store.remove(first.id);
  assert.deepEqual(await readdir(directory), []);
  const next = await store.import(payload, "café.json", "en");
  assert.deepEqual((await store.export(next.id)).corpus, payload.corpus);
});

test("concurrent persistence reserves bytes before filesystem work", async t => {
  const { directory, payload, bytes, store } = await diskQuotaFixture(t);
  const results = await Promise.allSettled([
    store.import(payload, "café.json", "en"),
    store.import(payload, "café.json", "en")
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") assert.ok(statusIs(429)(results[1].reason));
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.equal((await readFile(path.join(directory, files[0]))).byteLength, bytes);
});

test("failed persistence releases reserved disk quota", async t => {
  const { directory, payload, store } = await diskQuotaFixture(t);
  await rm(directory, { recursive: true });
  await writeFile(directory, "blocked");
  await assert.rejects(store.import(payload, "café.json", "en"), error =>
    statusIs(500)(error) && (error as Error).message === "Could not save the corpus.");
  await rm(directory);
  const info = await store.import(payload, "café.json", "en");
  assert.equal((await store.getInfo(info.id)).status, "ready");
  assert.deepEqual(await readdir(directory), [`${info.id}.json`]);
});

test("admission leases fail fast and release exactly once on success or thrown errors", async () => {
  const gate = new AdmissionGate(1);
  const release = gate.acquire();
  await assert.rejects(gate.run(() => assert.fail("must not queue")), statusIs(429));
  release(); release();
  assert.equal(await gate.run(() => 42), 42);
  await assert.rejects(gate.run(() => { throw new Error("sync"); }), /sync/);
  await assert.rejects(gate.run(async () => { throw new Error("async"); }), /async/);
  const last = gate.acquire();
  assert.throws(() => gate.acquire(), statusIs(429));
  last();
});

test("static assets, unmatched methods/routes and unowned reads never allocate a session", async t => {
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const sessions = new SessionManager(1);
  const base = await startServer(t, store, service(), configuredKeys(), [], sessions);
  // The only slot is occupied by the fixture; cookie-free requests must still work.
  for (const route of ["/", "/app.js", "/styles.css", "/icon.png"]) {
    const response = await globalThis.fetch(base + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    await response.arrayBuffer();
  }
  for (const [route, method] of [["/missing", "GET"],
    ["/api/corpora/import", "GET"], ["/api/settings/openai", "POST"], ["/app.js", "POST"],
    ["/api/corpora/00000000-0000-4000-8000-000000000000/export", "GET"]]) {
    const response = await globalThis.fetch(base + route, { method });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("set-cookie"), null);
    await response.text();
  }
  const full = await globalThis.fetch(base + "/api/settings/openai");
  assert.equal(full.status, 429);
  assert.equal(full.headers.get("set-cookie"), null);
  assert.equal((await fetch(base + "/api/settings/openai")).status, 200, "existing session is preserved");
});

test("TXT UTF-8 byte and chunk limits reject before enrichment; admitted validation errors release capacity", async t => {
  const resources = new WebResources({ ...DEFAULT_WEB_LIMITS, maxTextBytes: 12, maxChunks: 1 });
  let preparations = 0, enrichments = 0;
  const store = new CorpusStore(await tempDirectory(t), {
    prepare: (text, options) => { preparations++; return prepareCorpusLocal(text, options); },
    enrich: async corpus => { enrichments++; return corpus; }
  }, noLog, undefined, resources);
  const base = await startServer(t, store);
  assert.equal((await post(base, "/api/corpora", { ...input, text: "é".repeat(7) })).status, 413);
  assert.equal(preparations, 0);
  assert.equal((await post(base, "/api/corpora", { ...input, text: "A. B. C. D." })).status, 413);
  assert.equal(enrichments, 0);
  assert.equal((await post(base, "/api/corpora", { ...input, text: "", language: "fr" })).status, 400);
  const accepted = await post(base, "/api/corpora", { ...input, text: "é".repeat(6) });
  assert.equal(accepted.status, 202, "exact byte boundary is accepted");
  const info = await accepted.json();
  await store.drain();
  assert.equal((await store.getReady(info.id)).corpus.chunks[0].text, "é".repeat(6));
  assert.equal(enrichments, 1);
});

test("import byte limit covers Content-Length and streamed bodies; exact limit imports unchanged", async t => {
  const body = { corpus: enriched(), name: "example.json", language: "en" };
  const json = JSON.stringify(body);
  const resources = new WebResources({ ...DEFAULT_WEB_LIMITS, maxImportBytes: Buffer.byteLength(json) });
  const store = new CorpusStore(await tempDirectory(t), {
    prepare: () => { throw new Error("must not prepare"); }, enrich: async () => { throw new Error("must not enrich"); }
  }, noLog, undefined, resources);
  const base = await startServer(t, store);
  const tooLarge = await fetch(base + "/api/corpora/import", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: json + " "
  });
  assert.equal(tooLarge.status, 413);
  // No Content-Length: the streaming byte counter must independently stop overflow.
  const streamed = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(base + "/api/corpora/import", { method: "POST", headers: {
      "Content-Type": "application/json", Cookie: browserCookies.get(base)!, "Transfer-Encoding": "chunked"
    } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
    request.write(json);
    request.end(" ");
  });
  assert.equal(streamed, 413);
  const response = await post(base, "/api/corpora/import", body);
  assert.equal(response.status, 201);
  const info = await response.json();
  assert.deepEqual((await store.export(info.id)).corpus, body.corpus);
});

test("import chunk caps return 413 before schema validation and corpus reservations release on invalid import", async t => {
  const resources = new WebResources({ ...DEFAULT_WEB_LIMITS, maxChunks: 1, maxCorpora: 1 });
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog, undefined, resources);
  const base = await startServer(t, store);
  assert.equal((await post(base, "/api/corpora/import", { corpus: { chunks: [{}, {}] } })).status, 413);
  assert.equal((await post(base, "/api/corpora/import", { corpus: { formatVersion: 1, corpus: { chunks: [{}, {}] } } })).status, 413);
  assert.equal((await post(base, "/api/corpora/import", { corpus: {} })).status, 400);
  const corpus = enriched();
  corpus.chunks = corpus.chunks.slice(0, 1);
  const accepted = await post(base, "/api/corpora/import", { corpus, name: "one.json", language: "en" });
  assert.equal(accepted.status, 201);
  const id = (await accepted.json()).id;
  assert.equal((await post(base, "/api/corpora/import", { corpus, name: "two.json", language: "en" })).status, 429);
  assert.equal((await fetch(base + "/api/corpora/" + id)).status, 200);
  assert.deepEqual((await store.export(id)).corpus, corpus);
});

test("corpus reservations cover concurrent imports and are released after persistence or reload failure", async t => {
  const directory = await tempDirectory(t);
  const resources = new WebResources({ ...DEFAULT_WEB_LIMITS, maxCorpora: 1 });
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog, undefined, resources);
  const first = store.import(enriched(), "first.json", "en");
  await assert.rejects(store.import(enriched(), "second.json", "en"), statusIs(429));
  const info = await first;
  assert.deepEqual((await store.export(info.id)).corpus, enriched());
  const blocked = path.join(directory, "blocked");
  await writeFile(blocked, "file");
  const failed = new CorpusStore(blocked, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog, undefined,
    new WebResources({ ...DEFAULT_WEB_LIMITS, maxCorpora: 1 }));
  await assert.rejects(failed.import(enriched(), "a.json", "en"));
  assert.doesNotThrow(() => failed.assertCorpusCapacity());
  await assert.rejects(failed.import(enriched(), "b.json", "en"), error => !(error instanceof WebError && error.status === 429));
  const reloaded = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => c }, noLog, undefined,
    new WebResources({ ...DEFAULT_WEB_LIMITS, maxCorpora: 1 }));
  await assert.rejects(reloaded.getReady("00000000-0000-4000-8000-000000000000"), statusIs(404));
  const copies = await Promise.all([reloaded.getReady(info.id), reloaded.getReady(info.id)]);
  assert.deepEqual(copies[0], copies[1], "one load/reservation serves the same corpus");
});

test("preparation concurrency is configurable, fails fast with 429, and releases on success and upstream failure", async t => {
  const resources = new WebResources({ ...DEFAULT_WEB_LIMITS, maxPreparations: 2 });
  const gates = [deferred(), deferred()];
  let calls = 0;
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async corpus => {
    const index = calls++;
    if (index < 2) await gates[index].promise;
    if (index === 1) throw new Error("PRIVATE_OPENAI_FAILURE");
    return corpus;
  } }, noLog, undefined, resources);
  const base = await startServer(t, store);
  const first = await post(base, "/api/corpora", input);
  const second = await post(base, "/api/corpora", input);
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  const firstId = (await first.json()).id, secondId = (await second.json()).id;
  try {
    assert.equal((await post(base, "/api/corpora", input)).status, 429);
    assert.equal(calls, 2, "rejected work is not queued");
  } finally { gates.forEach(gate => gate.resolve()); }
  await store.drain();
  assert.equal((await store.getInfo(firstId)).status, "ready");
  assert.equal((await store.getInfo(secondId)).status, "failed");
  assert.equal((await post(base, "/api/corpora", input)).status, 202);
  await store.drain();
  assert.equal(calls, 3);
});

for (const failure of ["none", "retrieve", "generate", "verify"] as const) {
  test("question admission is released after " + failure + " and validation failure", async t => {
    const resources = new WebResources({ ...DEFAULT_WEB_LIMITS, maxQuestions: 1 });
    const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog, undefined, resources);
    const one = await store.import(enriched(), "one.json", "en");
    const two = await store.import(enriched(), "two.json", "en");
    const started = deferred(), finish = deferred();
    let block = true, shouldFail = true, retrievalCalls = 0;
    const ask = createWorkflowService({
      retrieveCandidates: async () => {
        retrievalCalls++;
        if (block) { started.resolve(); await finish.promise; }
        if (shouldFail && failure === "retrieve") throw new Error("PRIVATE_FAILURE");
        return [candidate(0, "Atlas is blue.")];
      },
      generateAnswer: async () => { if (shouldFail && failure === "generate") throw new Error("PRIVATE_FAILURE"); return "Blue"; },
      verifyAnswer: async () => { if (shouldFail && failure === "verify") throw new Error("PRIVATE_FAILURE"); return { supported: true, reason: "Supported" }; }
    }, resources);
    const base = await startServer(t, store, ask, configuredKeys(), [one.id, two.id]);
    const body = { corpusId: one.id, question: "Color?" };
    const first = post(base, "/api/questions", body);
    await started.promise;
    try {
      assert.equal((await post(base, "/api/questions", { ...body, corpusId: two.id })).status, 429);
      assert.equal(retrievalCalls, 1);
    } finally { finish.resolve(); }
    assert.equal((await first).status, failure === "none" ? 200 : 500);
    block = false; shouldFail = false;
    assert.equal((await post(base, "/api/questions", { ...body, question: "" })).status, 400);
    assert.equal((await post(base, "/api/questions", body, { Cookie: "parancu_session=invalid" })).status, 400);
    assert.equal((await fetch(base + "/api/questions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
    assert.equal((await post(base, "/api/questions", { ...body, corpusId: "unknown" })).status, 404);
    assert.equal((await post(base, "/api/questions", body)).status, 200);
  });
}

for (const fail of [false, true]) {
  test("retrieval gate is shared by keyed workflow and key-free retrieval; failure=" + fail, async t => {
    const resources = new WebResources({ ...DEFAULT_WEB_LIMITS, maxQuestions: 2, maxRetrievals: 1 });
    const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog, undefined, resources);
    const one = await store.import(enriched(), "one.json", "en");
    const two = await store.import(enriched(), "two.json", "en");
    const started = deferred(), finish = deferred();
    let blocking = true, calls = 0;
    const ask = createWorkflowService({
      retrieveCandidates: async () => {
        calls++;
        if (blocking) { started.resolve(); await finish.promise; if (fail) throw new Error("PRIVATE_RETRIEVAL_ERROR"); }
        return [candidate(0, "Atlas is blue.")];
      },
      generateAnswer: async () => "Blue", verifyAnswer: async () => ({ supported: true, reason: "Supported" })
    }, resources);
    const base = await startServer(t, store, ask, configuredKeys(), [one.id, two.id]);
    const first = post(base, "/api/questions", { corpusId: one.id, question: "Color?" });
    await started.promise;
    await fetch(base + "/api/settings/openai", { method: "DELETE" });
    try {
      assert.equal((await post(base, "/api/questions", { corpusId: two.id, question: "Color?" })).status, 429);
      assert.equal(calls, 1);
    } finally { finish.resolve(); }
    assert.equal((await first).status, fail ? 500 : 200);
    blocking = false;
    const response = await post(base, "/api/questions", { corpusId: two.id, question: "Color?" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.action, "retrieval_only");
  });
}

test("diagnostic recovery also holds the shared retrieval admission slot", async () => {
  const resources = new WebResources({ ...DEFAULT_WEB_LIMITS, maxRetrievals: 1 });
  const started = deferred(), finish = deferred();
  const corpus = enriched();
  let calls = 0;
  const ask = createWorkflowService({
    retrieveCandidates: async () => {
      if (++calls === 2) { started.resolve(); await finish.promise; return [candidate(1, corpus.chunks[1].text)]; }
      return [candidate(0, corpus.chunks[0].text)];
    },
    generateAnswer: async () => "Answer",
    verifyAnswer: async (_q, _a, _e, context) => ({ supported: Boolean(context), reason: "Checked", missingConcepts: context ? [] : ["color"] }),
    checkComplement: async () => ({ addsMissingSupport: true, reason: "Adds support" })
  }, resources);
  const first = ask("Color?", corpus);
  await started.promise;
  try { await assert.rejects(ask("Color?", corpus, true), statusIs(429)); }
  finally { finish.resolve(); }
  assert.equal((await first).result.action, "answer");
  assert.equal((await ask("Color?", corpus, true)).result.action, "retrieval_only");
});


test("upload/import body admission fails fast and releases after import failure", async t => {
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const original = store.import.bind(store);
  const started = deferred(), finish = deferred();
  let block = true, calls = 0;
  t.mock.method(store, "import", async (...args: Parameters<CorpusStore["import"]>) => {
    calls++;
    if (block) { started.resolve(); await finish.promise; throw new Error("PRIVATE_STORAGE_FAILURE"); }
    return original(...args);
  });
  const base = await startServer(t, store);
  const body = { corpus: enriched(), name: "one.json", language: "en" };
  const first = post(base, "/api/corpora/import", body);
  await started.promise;
  try {
    assert.equal((await post(base, "/api/corpora/import", body)).status, 429);
    assert.equal((await post(base, "/api/corpora", input)).status, 429, "uploads share the body-admission gate");
    assert.equal(calls, 1);
  } finally { finish.resolve(); }
  const failed = await first;
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /PRIVATE_STORAGE_FAILURE/);
  block = false;
  assert.equal((await post(base, "/api/corpora/import", body)).status, 201);
});

test("synchronous preparation errors and credential validation release the preparation slot", async t => {
  const resources = new WebResources({ ...DEFAULT_WEB_LIMITS, maxCorpora: 1 });
  let rejectContent = true, failPrepare = true;
  const store = new CorpusStore(await tempDirectory(t), {
    prepare: (text, options) => { if (failPrepare) throw new Error("split failure"); return prepareCorpusLocal(text, options); },
    enrich: async c => c
  }, noLog, () => { if (rejectContent) throw new Error("content rejected"); }, resources);
  assert.throws(() => store.create(input), /content rejected/);
  rejectContent = false;
  assert.throws(() => store.create(input), /split failure/);
  failPrepare = false;
  const info = store.create(input);
  await store.drain();
  assert.equal((await store.getInfo(info.id)).status, "ready");
  // Retained corpus capacity is separate from a transient preparation permit.
  const release = resources.preparations.acquire();
  release();
});
