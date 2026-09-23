import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { test, type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { prepareCorpusLocal } from "../../services/parancu-api/src/local/prepareCorpus";
import type { RetrieveResult } from "../../services/parancu-api/src/local/retrieval";
import { CorpusStore, MAX_TEXT_BYTES, WebError } from "./corpusStore";
import { createWebServer } from "./server";
import { createWorkflowService } from "./workflowService";
import { KeyManager } from "./keyManager";
import { importCorpus, validatePreparedCorpus, exportFilename } from "./corpusFormat";
import { loadOpenAIKey } from "../../services/parancu-api/src/local/openaiKeyStore";
import { requestOpenAI } from "../../services/parancu-api/src/local/openaiRequest";
import { generateResponse } from "../responder/responseAgent";
import { verifyEvidence } from "../verifier/evidenceVerifier";

const source = "Atlas is blue. Nova is red. Atlas weighs one kilogram. Nova is lighter.";
const input = { name: "example.txt", text: source, language: "en" as const };
const webDirectory = path.resolve(__dirname, "../../apps/web");
const noLog = () => {};

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

async function startServer(t: TestContext, store: CorpusStore, ask = service(), keys = configuredKeys()) {
  const server = createWebServer({ store, ask, keys, webDirectory, reportError: noLog });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(keys.status().ready, false, "server close clears credential access");
    await store.drain();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  assert.throws(() => store.create(input), (error: unknown) => error instanceof WebError && error.status === 409);
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
  const base = await startServer(t, store, service({ fail: true }));
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
  const base = await startServer(t, store, service({ reject: true }));
  const response = await post(base, "/api/questions", { corpusId: info.id, question: "question" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.action, "no_evidence");
  assert.ok(!Object.hasOwn(body.result, "evidence"));
  assert.equal(body.retrievedEvidence.length, 3);
});

test("HTTP rejects duplicate questions while one is running", async t => {
  const gate = deferred();
  const started = deferred();
  const store = new CorpusStore(await tempDirectory(t), { prepare: prepareCorpusLocal, enrich: async c => c }, noLog);
  const info = store.create(input);
  await store.drain();
  const base = await startServer(t, store, async (q, c) => { started.resolve(); await gate.promise; return service()(q, c); });
  const body = { corpusId: info.id, question: "question" };
  const first = post(base, "/api/questions", body);
  await started.promise;
  const duplicate = await post(base, "/api/questions", body);
  assert.equal(duplicate.status, 409);
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

test("HTTP Use key and Remove key gate preparation/questions despite environment credentials; import stays usable", async t => {
  environmentPresent(t);
  const directory = await tempDirectory(t);
  let enrichCalls = 0;
  const keys = new KeyManager();
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => { enrichCalls++; return c; } }, noLog);
  const base = await startServer(t, store, service(), keys);
  assert.deepEqual(await (await fetch(base + "/api/settings/openai")).json(), { ready: false, source: "none" });
  assert.equal((await post(base, "/api/corpora", input)).status, 409);
  assert.equal((await post(base, "/api/questions", { corpusId: "x", question: "Question?" })).status, 409);
  const imported = await post(base, "/api/corpora/import", { corpus: enriched(), name: "Atlas.prepared.json", language: "en" });
  assert.equal(imported.status, 201);
  const info = await imported.json();
  assert.equal(info.origin, "imported");
  assert.equal(info.status, "ready");
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
  assert.equal((await post(base, "/api/questions", { corpusId: info.id, question: "What color?" })).status, 409);
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
  const base = await startServer(t, store);
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
    if (calls === 2) return new Response(JSON.stringify({ output_text: '{"evidenceSupported":true,"questionAligned":true,"reason":"Direct support."}' }));
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
    output_text: '{"evidenceSupported":true,"questionAligned":true,"reason":"' + encoded + '"}'
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
  const requests: string[] = [];
  let delayedStatus: { captured: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; done: ReturnType<typeof deferred> } | undefined;
  const context = vm.createContext({
    document: { getElementById: (id: string) => nodes.get(id) ?? null },
    window: { addEventListener() {} }, TextDecoder,
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
  const id = storage.get("parancu.web.corpusId");
  assert.ok(id);
  await vm.runInContext(`poll(${JSON.stringify(id)}, pollVersion)`, context);
  const assertLoaded = () => {
    assert.equal(vm.runInContext("corpus.id", context), id);
    assert.equal(storage.get("parancu.web.corpusId"), id);
    assert.equal(node("selected-file").hidden, false);
    assert.equal(node("file-name").textContent, "Atlas.txt");
    assert.equal(node("document-badge").textContent, "Document ready");
    assert.equal(node("corpus-stats").hidden, false);
    assert.equal(node("chunk-count").textContent, String(enriched().chunks.length));
    assert.equal(node("sentence-count").textContent, String(enriched().sentences.length));
    assert.equal(node("corpus-origin").hidden, false);
    assert.match(node("corpus-origin").textContent, /Imported/);
    assert.equal(node("export-corpus").hidden, false);
    assert.equal(node("export-corpus").href, `/api/corpora/${id}/export`);
    assert.equal(node("error").hidden, true);
  };
  assertLoaded();
  node("mode-import").fire("click");
  assertLoaded();
  assert.match(node("document-status").textContent, /loaded.*Export.*OpenAI key/);
  assert.equal(node("question").disabled, true);
  assert.equal(node("ask").disabled, true);
  assert.equal((await fetch(base + node("export-corpus").href)).status, 200);
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
  assert.equal(node("question").disabled, true);
  assert.equal(node("ask").disabled, true);
  assert.match(node("document-status").textContent, /loaded.*Export.*OpenAI key/);
  node("openai-key").value = sessionKey;
  node("key-form").fire("submit");
  await finishSettings();
  assertLoaded();
  assert.equal(node("question").disabled, false);
  assert.equal(node("ask").disabled, false);
  assert.equal(requests.filter(r => r === "POST /api/corpora/import").length, 1);
  assert.ok(!requests.includes("POST /api/corpora"));
  assert.ok(!requests.includes("POST /api/questions"));
  // Switching explicitly to a new TXT verifies its independent credential gate.
  node("mode-txt").fire("click");
  node("document-file").files = [{ name: "example.txt", size: 10 }];
  node("document-file").fire("change");
  assert.equal(node("prepare").disabled, false);
  node("remove-key").fire("click");
  await finishSettings();
  assert.equal(node("prepare").disabled, true);
});

test("Settings UI reflects server key state, clears input, closes on Use key, and disables work after removal", async t => {
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
  assert.equal(node("question").disabled, true);

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
  assert.equal(node("question").disabled, true);
  assert.equal(node("ask").disabled, true);
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
