import assert from "node:assert/strict";
import { test } from "node:test";
import { createObservability, langfuseSdk, safeMetadata, type Metadata, type ObservationHandle, type Stage } from "./langfuse";
import { runWorkflow } from "../workflow/runWorkflow";
import { deriveEvidenceVerification } from "../verifier/evidenceVerifier";
import { prepareCorpusLocal } from "../../services/parancu-api/src/local/prepareCorpus";
import { retrieveTop, retrieveTopK, buildSemanticIndex } from "../../services/parancu-api/src/local/retrieval";
import type { WorkflowDependencies } from "../workflow/graph";
import { logOperational } from "../../services/parancu-api/src/local/diagnostics";
import { enrichPreparedCorpusWithOpenAI } from "../../services/parancu-api/src/lib/gen/openaiPrepare";

const privateText = "PRIVATE_DOCUMENT_QUESTION_ANSWER_REASON_SESSION_sk-secret-12345678901234567890";
function recorder() {
  const records: Array<{ stage: Stage; metadata: Metadata; ended: boolean }> = [];
  const start = (stage: Stage): ObservationHandle => {
    const record = { stage, metadata: {} as Metadata, ended: false };
    records.push(record);
    return { update: values => { Object.assign(record.metadata, values); }, end: () => { record.ended = true; }, child: start };
  };
  return { records, transport: { start, shutdown: async () => {} } };
}

test("observability requires exact opt-in; credentials alone never initialize an exporter", async () => {
  for (const env of [{}, { LANGFUSE_PUBLIC_KEY: "present", LANGFUSE_SECRET_KEY: "present" },
    ...["", "false", "1", "TRUE", " true", "true "].map(value => ({
      PARANCU_OBSERVABILITY: value, LANGFUSE_PUBLIC_KEY: "present", LANGFUSE_SECRET_KEY: "present"
    }))]) {
    let initialized = 0;
    const telemetry = createObservability(env, () => { initialized++; return recorder().transport; });
    assert.equal(initialized, 0, "SDK must not initialize");
    assert.equal(telemetry.enabled, false);
    assert.equal(telemetry.startActiveObservation("generate", span => { span.update({ answer: privateText }); return privateText; }), privateText);
    await telemetry.shutdown();
  }
});

test("disabled application imports do not load Langfuse SDK or transport modules", () => {
  assert.equal(process.env.PARANCU_OBSERVABILITY === "true", false,
    "Run deterministic tests with PARANCU_OBSERVABILITY=false to avoid a real exporter at module import.");
  assert.equal(Object.keys(require.cache).some(file =>
    /[/\\]@langfuse[/\\]/.test(file) || /[/\\]langfuseTransport\.[jt]s$/.test(file)), false);
});

test("metadata allowlist rejects text, nested values, identifiers and invalid scalar types", () => {
  const allowed = { chunkCount: 0, candidateCount: 2, candidateRank: 1, chunkIndex: 0,
    currentCandidateRank: 1, nextCandidateRank: 2, missingConceptCount: 1, evidenceCount: 2,
    claimCount: 3, failedCheckCount: 0, durationMs: 0.5,
    supported: false, evidenceSupported: true, accepted: false, recovered: true, answered: true, failed: false };
  assert.deepEqual(safeMetadata({ ...allowed, question: privateText, text: privateText,
    evidence: privateText, answer: privateText, verifier: { reason: privateText },
    sessionId: 123, apiKey: privateText, docId: 456, [privateText]: 1 }), allowed);
  for (const value of [null, undefined, privateText, [privateText], {
    chunkCount: -1, candidateCount: NaN, candidateRank: "1", durationMs: Infinity,
    evidenceCount: [1], claimCount: { value: 1 }, supported: "true", answered: 1
  }]) assert.deepEqual(safeMetadata(value), {});
});

test("explicit opt-in enables metadata telemetry without capturing return values or errors", async () => {
  const { records, transport } = recorder();
  let initialized = 0;
  const telemetry = createObservability({ PARANCU_OBSERVABILITY: "true" }, () => { initialized++; return transport; });
  assert.equal(initialized, 1);
  assert.equal(telemetry.enabled, true);
  assert.equal(telemetry.startActiveObservation(privateText as Stage, () => privateText), privateText);
  assert.equal(records.length, 0, "unknown stage names must not enter telemetry");
  assert.deepEqual(safeMetadata({ candidateCount: 2, supported: true, question: privateText,
    candidateRank: privateText, durationMs: Infinity, input: { text: privateText }, docId: privateText }),
  { candidateCount: 2, supported: true });
  assert.equal(await telemetry.startActiveObservation("parancu-workflow", async span => {
    span.update({ candidateCount: 2, question: privateText, evidence: privateText, answer: privateText,
      reason: privateText, sessionId: privateText, apiKey: privateText, output: { secret: privateText } });
    return telemetry.startActiveObservation("generate", () => privateText);
  }), privateText);
  const failure = new Error(privateText, { cause: new Error(privateText) });
  await assert.rejects(telemetry.startActiveObservation("verify", async () => { throw failure; }), error => error === failure);
  assert.throws(() => telemetry.startActiveObservation("verifier-decision", () => { throw failure; }), error => error === failure);
  assert.ok(records.every(record => record.ended && Number.isFinite(record.metadata.durationMs)));
  assert.equal(records[0].metadata.candidateCount, 2);
  assert.equal(records[2].metadata.failed, true);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_|sk-secret|sessionId|apiKey|reason|output/);
  await telemetry.shutdown();
});

test("telemetry initialization and delivery failures cannot alter application results", t => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...values: unknown[]) => { warnings.push(values); });
  const disabled = createObservability({ PARANCU_OBSERVABILITY: "true" }, () => { throw new Error(privateText); });
  assert.equal(disabled.enabled, false);
  assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_/);
  const broken = createObservability({ PARANCU_OBSERVABILITY: "true" }, () => ({
    start: () => { throw new Error(privateText); }, shutdown: async () => {}
  }));
  assert.equal(broken.startActiveObservation("retrieve", () => 42), 42);
  const brokenHandle: ObservationHandle = {
    update() { throw new Error(privateText); },
    end() { throw new Error(privateText); },
    child() { throw new Error(privateText); }
  };
  const delivery = createObservability({ PARANCU_OBSERVABILITY: "true" }, () => ({
    start: () => brokenHandle, shutdown: async () => {}
  }));
  assert.equal(delivery.startActiveObservation("retrieve", span => {
    span.update({ candidateCount: 1 });
    return delivery.startActiveObservation("generate", () => privateText);
  }), privateText);
  assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_/);
});

test("real workflow and verifier pass only metadata to tracing and retain identical results", async t => {
  const { records, transport } = recorder();
  const telemetry = createObservability({ PARANCU_OBSERVABILITY: "true" }, () => transport);
  const updates: unknown[] = [];
  t.mock.method(langfuseSdk, "startActiveObservation", <T>(stage: Stage, work: (span: { update(value: unknown): void }) => T): T =>
    telemetry.startActiveObservation(stage, span => work({ update(value) { updates.push(value); span.update(value); } })));
  const corpus = prepareCorpusLocal(privateText + ".", { docId: privateText });
  const dependencies = {
    retrieveCandidates: async () => [{ chunk_index: 0, chunk: privateText, summary: privateText,
      guiding_question: privateText, answer_focus: privateText, sentence_ids: [0], score: 1, cosine_score: 1 }],
    generateAnswer: async () => privateText,
    verifyAnswer: async () => deriveEvidenceVerification({ claims: [{ claim: privateText, supported: true, evidenceQuote: privateText }],
      questionCovered: true, conceptConflation: false, missingConcepts: [], reason: privateText }, privateText)
  };
  const enabled = await runWorkflow(privateText, corpus, dependencies);
  assert.equal(enabled.action, "answer");
  assert.ok(records.some(record => record.stage === "verifier-decision"));
  assert.doesNotMatch(JSON.stringify({ updates, records }), /PRIVATE_|sk-secret/);
  for (const value of updates) assert.deepEqual(value, safeMetadata(value));
  t.mock.method(langfuseSdk, "startActiveObservation", createObservability({}).startActiveObservation);
  assert.deepEqual(await runWorkflow(privateText, corpus, dependencies), enabled);
});

test("production retrieval and preparation diagnostics never print document or query content", async t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  const logs: unknown[][] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    t.mock.method(console, method, (...values: unknown[]) => { logs.push(values); });
  }
  const corpus = prepareCorpusLocal(privateText + ".", { docId: privateText });
  for (const chunk of corpus.chunks) Object.assign(chunk, { summary: privateText, guiding_question: privateText,
    guiding_question_embedding: [1], answer_focus_embedding: [1] });
  // Empty query skips E5 inference while exercising actual ranking diagnostics.
  const retrieved = await retrieveTopK("", buildSemanticIndex(corpus), 1);
  assert.equal(retrieved[0].chunk, corpus.chunks[0].text);
  assert.deepEqual(await retrieveTop("", buildSemanticIndex(corpus)), retrieved[0]);
  const empty = { docId: privateText, chunks: [], sentences: [] };
  assert.deepEqual(await enrichPreparedCorpusWithOpenAI(empty), empty);
  logOperational("prepared-chunk", { chunkIndex: 0, summary: privateText, guidingQuestion: privateText, answerFocus: privateText });
  logOperational("retrieval-query", { keywordCount: 1, queryKeywords: [privateText], sessionId: privateText, apiKey: privateText });
  assert.ok(logs.length > 0);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|sk-secret|guidingQuestion|queryKeywords|sessionId|apiKey/);
});

for (const acceptComplement of [false, true]) {
  test(`recovery and complement decisions remain private (accepted=${acceptComplement})`, async t => {
    const { records, transport } = recorder();
    const telemetry = createObservability({ PARANCU_OBSERVABILITY: "true" }, () => transport);
    const updates: unknown[] = [];
    t.mock.method(langfuseSdk, "startActiveObservation", <T>(stage: Stage, work: (span: { update(value: unknown): void }) => T): T =>
      telemetry.startActiveObservation(stage, span => work({ update(value) { updates.push(value); span.update(value); } })));
    const corpus = prepareCorpusLocal(`${privateText}. ${privateText}.`, {
      docId: privateText, sentencesPerChunk: 1, overlap: 0
    });
    const candidates = corpus.chunks.map((chunk, index) => ({
      chunk_index: index, chunk: chunk.text, summary: privateText, guiding_question: privateText,
      answer_focus: privateText, sentence_ids: chunk.sentence_ids, score: 1, cosine_score: 1
    }));
    const dependencies: WorkflowDependencies = {
      retrieveCandidates: async () => candidates,
      generateAnswer: async () => privateText,
      verifyAnswer: async (_q, _answer, _evidence, context) => ({
        supported: Boolean(context), reason: privateText, missingConcepts: context ? [] : [privateText]
      }),
      checkComplement: async () => ({ addsMissingSupport: acceptComplement, reason: privateText })
    };
    const result = await runWorkflow(privateText, corpus, dependencies);
    assert.equal(result.action, acceptComplement ? "answer" : "no_evidence");
    assert.ok(records.some(record => record.stage === "diagnostic-recovery"));
    assert.ok(records.some(record => record.stage === "complement-selection" && record.metadata.accepted === acceptComplement));
    if (!acceptComplement) assert.ok(records.some(record => record.stage === "advance"));
    for (const update of updates) assert.deepEqual(update, safeMetadata(update));
    assert.doesNotMatch(JSON.stringify({ records, updates }), /PRIVATE_|sk-secret/);
    t.mock.method(langfuseSdk, "startActiveObservation", createObservability({}).startActiveObservation);
    assert.deepEqual(await runWorkflow(privateText, corpus, dependencies), result);
    await telemetry.shutdown();
  });
}

test("real Langfuse transport exports only metadata and ignores ambient attributes and SDK debug settings", async t => {
  const logs: unknown[][] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    t.mock.method(console, method, (...values: unknown[]) => { logs.push(values); });
  }
  const overrides = { LANGFUSE_DEBUG: "true", OTEL_LOG_LEVEL: "DEBUG",
    OTEL_SDK_DISABLED: "false", OTEL_TRACES_SAMPLER: "always_on",
    LANGFUSE_RELEASE: privateText, LANGFUSE_TRACING_ENVIRONMENT: privateText,
    OTEL_RESOURCE_ATTRIBUTES: `session.id=${privateText}`, OTEL_SERVICE_NAME: privateText };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { createLangfuseTransport } = await import("./langfuseTransport.js");
  const { propagateAttributes } = await import("@langfuse/core");
  const { startObservation } = await import("@langfuse/tracing");
  const exported: unknown[] = [];
  for (const env of [{}, { LANGFUSE_PUBLIC_KEY: "present" }, { LANGFUSE_SECRET_KEY: "present" },
    { LANGFUSE_PUBLIC_KEY: " ", LANGFUSE_SECRET_KEY: "present" }]) {
    assert.throws(() => createLangfuseTransport(env), /^Error: Missing observability configuration\.$/);
  }
  const transport = createLangfuseTransport({ LANGFUSE_PUBLIC_KEY: "private-public-key",
    LANGFUSE_SECRET_KEY: "private-secret-key" }, {
    export(spans, done) {
      exported.push(...spans.map(span => ({ name: span.name, attributes: span.attributes,
        events: span.events, links: span.links, status: span.status,
        resource: span.resource.attributes, scope: span.instrumentationScope,
        context: span.spanContext(), parent: span.parentSpanContext })));
      done({ code: 0 });
    },
    shutdown: async () => {}
  });
  try {
    propagateAttributes({ sessionId: privateText, userId: privateText, metadata: { secret: privateText } }, () => {
      const parent = transport.start("parancu-workflow");
      parent.update({ candidateCount: 2, sessionId: 123, unknown: 42 });
      const child = parent.child("generate");
      child.update({ answered: true, input: privateText } as unknown as Metadata);
      child.end();
      parent.end();
      // A third-party span must never enter this application's exporter.
      startObservation(privateText, { input: privateText, output: privateText }).end();
    });
  } finally { await transport.shutdown(); }
  assert.equal(exported.length, 2);
  const serialized = JSON.stringify({ exported, logs });
  assert.doesNotMatch(serialized, /PRIVATE_|sk-secret|private-public-key|private-secret-key|session\.id|user\.id/);
  const spans = exported as Array<{ name: string; attributes: Record<string, unknown>;
    context: { traceId: string; spanId: string }; parent?: { spanId: string } }>;
  const parent = spans.find(span => span.name === "parancu-workflow")!;
  const child = spans.find(span => span.name === "generate")!;
  assert.equal(child.context.traceId, parent.context.traceId);
  assert.equal(child.parent?.spanId, parent.context.spanId);
  assert.equal(parent.attributes["langfuse.observation.metadata.candidateCount"], "2");
  assert.equal(child.attributes["langfuse.observation.metadata.answered"], "true");
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) {
      assert.ok(["parancu.metadata_only", "langfuse.observation.type", "langfuse.environment",
        "langfuse.release", "langfuse.internal.is_app_root",
        "langfuse.observation.metadata.candidateCount", "langfuse.observation.metadata.answered"].includes(key), key);
    }
  }
});
