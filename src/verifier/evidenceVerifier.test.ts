import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyEvidence } from "./evidenceVerifier";
import { withOpenAIKey } from "../../services/parancu-api/src/local/openaiKeyStore";
import { runWorkflow } from "../workflow/runWorkflow";
import type { RetrieveResult } from "../../services/parancu-api/src/local/retrieval";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createWebServer } from "../web/server";
import { CorpusStore } from "../web/corpusStore";
import { KeyManager } from "../web/keyManager";
import { createWorkflowService } from "../web/workflowService";
import { generateResponse } from "../responder/responseAgent";
import { prepareCorpusLocal } from "../../services/parancu-api/src/local/prepareCorpus";

const question = "What is the difference between closed-book and open-domain question answering?";
const evidence = "Closed-domain question answering deals with questions under a specific domain. Open-domain question answering deals with questions about nearly anything.";
const incorrectAnswer = "Closed-book, or closed-domain, question answering is about questions within a specific domain...";
const corpus = { docId: "verifier-regression", sentences: [], chunks: [] };
const candidate = (text: string, index = 0): RetrieveResult => ({
  chunk_index: index, chunk: text, summary: text, guiding_question: question, answer_focus: "",
  sentence_ids: [], score: 0.9 - index * 0.1, cosine_score: 0.9
});
const withKey = <T>(work: () => T) => withOpenAIKey(() => "sk-test-verifier-12345678901234567890", work);

test("exact closed-book/closed-domain regression is rejected by the real verifier and graph", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    // Even an erroneous positive model verdict must not allow this known conflation.
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      evidenceSupported: true, questionAligned: true, reason: "Incorrect approval."
    }) }));
  });
  const verdict = await withKey(() => verifyEvidence(question, incorrectAnswer, evidence));
  assert.equal(verdict.supported, false);
  assert.match(verdict.reason, /closed-book.*closed-domain/);
  const result = await withKey(() => runWorkflow(question, corpus, {
    retrieveCandidates: async () => [candidate(evidence)],
    generateAnswer: async () => incorrectAnswer,
    verifyAnswer: verifyEvidence
  }));
  assert.deepEqual(result, { action: "no_evidence", question });
  assert.equal(calls, 0, "the deterministic guard must reject this conflation without trusting a model");
});

test("the graph advances after a concept mismatch and can accept a correctly aligned later candidate", async t => {
  const aligned = "Closed-book QA answers from model parameters without retrieving documents. Open-domain QA concerns unrestricted subject matter; the terms describe different dimensions.";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    output_text: JSON.stringify({ evidenceSupported: true, questionAligned: true, reason: "The original concepts are preserved." })
  })));
  const result = await withKey(() => runWorkflow(question, corpus, {
    retrieveCandidates: async () => [candidate(evidence), candidate(aligned, 1)],
    generateAnswer: async (_question, passage) => passage === evidence ? incorrectAnswer : aligned,
    verifyAnswer: verifyEvidence
  }));
  assert.equal(result.action, "answer");
  if (result.action === "answer") assert.equal(result.evidence.candidateRank, 2);
});

for (const [evidenceSupported, questionAligned] of [[true, true], [true, false], [false, true], [false, false]]) {
  test(`acceptance requires both checks: evidence=${evidenceSupported}, alignment=${questionAligned}`, async t => {
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      const input = JSON.parse(String(options.body)).input;
      const system = input[0].content[0].text;
      const user = input[1].content[0].text;
      assert.match(system, /two independent checks/);
      assert.match(system, /Do not reinterpret the question/);
      assert.match(system, /merges terms whose equivalence is not established/);
      assert.ok(user.includes(question) && user.includes(evidence));
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        evidenceSupported, questionAligned, reason: "Separate checks."
      }) }));
    });
    // Isolate the two verdict flags; deterministic substitutions are tested separately.
    const verdict = await withKey(() => verifyEvidence(question,
      "Closed-book QA and open-domain QA concern different dimensions.", evidence));
    assert.equal(verdict.supported, evidenceSupported && questionAligned);
  });
}

test("a supported distinction or correction is not rejected by the conflation guard", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      evidenceSupported: true, questionAligned: true, reason: "An explicit distinction, not an equivalence."
    }) }));
  });
  for (const answer of [
    "Closed-book is not closed-domain: one concerns access to external evidence, the other concerns topic scope.",
    'The phrase "closed-book, or closed-domain" incorrectly treats distinct concepts as equivalent.'
  ]) assert.equal((await withKey(() => verifyEvidence("Are these concepts equivalent?", answer, answer))).supported, true);
  assert.equal(calls, 2);
});

test("production Markdown regression through HTTP, web adapter, real generation and verifier", async t => {
  const productionAnswer = "Closed-book, or **closed-domain**, question answering is limited to a specific domain...";
  const realFetch = globalThis.fetch;
  let generationCalls = 0;
  let verificationCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url) !== "https://api.openai.com/v1/responses") return realFetch(url, options);
    const body = JSON.parse(String(options?.body));
    if (body.input[0].content[0].text.startsWith("You are a response agent.")) {
      generationCalls++;
      return new Response(JSON.stringify({ output_text: productionAnswer }));
    }
    verificationCalls++;
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      evidenceSupported: true, questionAligned: true,
      reason: "The answer matches the question’s key concepts: it contrasts closed-book/closed-domain question answering with open-domain question answering."
    }) }));
  });
  const directory = await mkdtemp(path.join(tmpdir(), "parancu-verifier-http-"));
  const store = new CorpusStore(directory, { prepare: prepareCorpusLocal, enrich: async c => c });
  const keys = new KeyManager();
  keys.set("sk-test-verifier-http-12345678901234567890");
  const server = createWebServer({
    store, keys, webDirectory: path.resolve(__dirname, "../../apps/web"),
    ask: createWorkflowService({
      retrieveCandidates: async () => [candidate(evidence)],
      generateAnswer: generateResponse, verifyAnswer: verifyEvidence
    })
  });
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await store.drain();
    await rm(directory, { recursive: true, force: true });
  });
  const info = store.create({ name: "qa.txt", text: evidence, language: "en" });
  await store.drain();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/questions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ corpusId: info.id, question })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.result, { action: "no_evidence", question });
  assert.equal(data.retrievedEvidence[0].status, "rejected");
  assert.equal(data.retrievedEvidence.some((item: { status: string }) => item.status === "accepted"), false);
  assert.equal(generationCalls, 1);
  assert.equal(verificationCalls, 0, "even the production positive verdict cannot bypass the guard");
});

test("formatted aliases and substitutions are rejected independently of model approval", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      evidenceSupported: true, questionAligned: true, reason: "Incorrect approval."
    }) }));
  });
  for (const answer of [
    "Closed-book, or **closed-domain**, question answering is limited to a specific domain...",
    "In this context, **closed-book** is also known as _closed-domain_ QA.",
    "Closed–domain QA is equivalent to closed‑book QA.",
    "Closed-book (closed-domain) QA concerns one field.",
    "Closed-book/closed-domain question answering concerns one field.",
    "Closed-book = closed-domain.",
    "Closed-book and closed-domain are interchangeable.",
    "Closed-book is another name for closed-domain.",
    "Closed-book, a.k.a. closed-domain, concerns one field.",
    "Closed-book, i.e. closed-domain, concerns one field.",
    "Closed&#45;book,&nbsp;or &ast;&ast;closed&#x2d;domain&ast;&ast;, concerns one field.",
    "Closed&amp;hyphen;book, or closed&amp;hyphen;domain, concerns one field.",
    "Closed-\nbook,\t or **closed-\ndomain**, concerns one field.",
    "Closed-book, or <strong>closed-domain</strong>, concerns one field.",
    "Closed-book, or [closed-domain](https://example.invalid), concerns one field.",
    "Closed-domain QA concerns one field; open-domain QA does not."
  ]) {
    const verdict = await withKey(() => verifyEvidence(question, answer, evidence));
    assert.equal(verdict.supported, false, answer);
  }
  assert.equal(calls, 0);
});

test("a model explanation that aliases these concepts cannot approve an otherwise unflagged answer", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    output_text: JSON.stringify({
      evidenceSupported: true, questionAligned: true,
      reason: "It contrasts closed-book/**closed-domain** question answering with open-domain question answering."
    })
  })));
  const verdict = await withKey(() => verifyEvidence(question, "Closed-book QA uses internal knowledge.", evidence));
  assert.equal(verdict.supported, false);
  assert.match(verdict.reason, /explanation conflates/);
});

test("missing or malformed alignment verdicts remain operational errors, never approval", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response());
  for (const value of [
    { supported: true, reason: "Legacy single verdict." },
    { evidenceSupported: true, reason: "Alignment missing." },
    { evidenceSupported: true, questionAligned: "true", reason: "Wrong type." },
    { evidenceSupported: true, questionAligned: true },
    null
  ]) {
    mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: JSON.stringify(value) })));
    await assert.rejects(withKey(() => verifyEvidence(question, "An answer.", evidence)), /Answer verifier returned/);
  }
});
