import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyEvidence, deriveEvidenceVerification } from "./evidenceVerifier";
import { checkComplementSupport } from "./complementSelector";
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
const attributed = (supported: boolean, quote = evidence) => [{ claim: "Test material claim", supported, evidenceQuote: supported ? quote : "" }];
const withKey = <T>(work: () => T) => withOpenAIKey(() => "sk-test-verifier-12345678901234567890", work);

const roleQuestion = "What role does the question classifier play, and how does that differ from the role of the retriever in a modern QA system?";
const classifierQuote = "The question classifier determines the type of question and the type of answer.";
const retrieverQuote = "The retriever is aimed at retrieving relevant documents related to the question.";
const roleEvidence = `${classifierQuote}\n${retrieverQuote}`;

const recoveredRoleAnswer = "The question classifier determines the type of question and the type of answer. In contrast, the retriever’s role is to retrieve relevant documents related to the question.";
const positiveRoleReason = "The answer addresses both requested roles and distinguishes them correctly: the question classifier identifies the question/answer type, while the retriever fetches relevant documents. Both factual claims are directly supported by the evidence.";
const sourceClassifier = "As of 2001, question-answering systems typically included a\u00a0question classifier\u00a0module that determined the type of question and the type of answer.[7]";
const sourceRetriever = "The retriever is aimed at retrieving relevant documents related to a given question, while the reader is used to infer the answer from the retrieved documents.";

for (const [label, quote, expected] of [
  ["exact substring", "module that determined the type of question and the type of answer", true],
  ["inserted quotation marks", sourceClassifier.replace("question classifier", 'question classifier"'), false],
  ["removed punctuation", sourceClassifier.replace("2001,", "2001"), false],
  ["added punctuation", sourceClassifier.replace("module", "module:"), false],
  ["changed capitalization", sourceClassifier.replace("question classifier", "Question Classifier"), false],
  ["paraphrase instead of literal quote", "The classifier identifies question and answer types.", false],
  ["literal live classifier quote", sourceClassifier, true]
] as const) {
  test(`literal quote copying: ${label}`, async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: [{ claim: classifierQuote, supported: true, evidenceQuote: quote }],
      questionCovered: true, conceptConflation: false, missingConcepts: [], reason: "The claim is supported."
    }) })));
    assert.equal((await withKey(() => verifyEvidence("What does the question classifier do?",
      classifierQuote, sourceClassifier))).supported, expected);
  });
}

test("production quote instructions require character-for-character source copying", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const system = JSON.parse(String(options.body)).input[0].content[0].text;
    assert.match(system, /Copy evidenceQuote character-for-character from one contiguous supporting substring/);
    assert.match(system, /Do not add or remove punctuation, insert quotation marks, change capitalization, paraphrase/);
    assert.match(system, /ellipses unless they literally occur/);
    assert.match(system, /clean up OCR\/text artifacts, or normalize any characters or whitespace/);
    assert.match(system, /after JSON decoding, evidenceQuote must still equal the copied source substring character-for-character/);
    assert.match(system, /cannot identify a literal supporting substring, return supported=false and evidenceQuote=""/);
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: [{ claim: classifierQuote, supported: false, evidenceQuote: "" }],
      questionCovered: true, conceptConflation: false, missingConcepts: [], reason: "No literal supporting substring identified."
    }) }));
  });
  assert.equal((await withKey(() => verifyEvidence(roleQuestion, classifierQuote, sourceClassifier))).supported, false);
});

for (const [label, source, quote, expected] of [
  ["non-breaking spaces", "The\u00a0question\u202fclassifier determines the type of question.", "The question classifier determines the type of question.", true],
  ["line breaks, tabs and repeated whitespace", "  The\r\nquestion\tclassifier   determines the type of question.\n", " The question classifier determines the type of question. ", true],
  ["live classifier sentence", sourceClassifier, "As of 2001, question-answering systems typically included a question classifier module that determined the type of question and the type of answer.[7]", true],
  ["altered wording", classifierQuote, classifierQuote.replace("determines", "guarantees"), false],
  ["missing factual content inside quote", classifierQuote, "The question classifier determines the type of answer.", false],
  ["added factual content", classifierQuote, "The question classifier always determines the type of question and the type of answer.", false],
  ["semantic paraphrase is not an exact quote", classifierQuote, "The classifier identifies question and answer types.", false],
  ["case remains significant", classifierQuote, classifierQuote.toLowerCase(), false],
  ["punctuation remains significant", classifierQuote, classifierQuote.replace(".", "!"), false],
  ["whitespace-only quote", classifierQuote, "\u00a0\t\r\n ", false]
] as const) {
  test(`normalized evidence quote: ${label}`, async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: [{ claim: classifierQuote, supported: true, evidenceQuote: quote }],
      questionCovered: true, conceptConflation: false, missingConcepts: [], reason: "Semantic support confirmed."
    }) })));
    const result = await withKey(() => verifyEvidence("What does the question classifier do?", classifierQuote, source));
    assert.equal(result.supported, expected);
  });
}

for (const guard of ["none", "unsupported claim", "invalid quote", "question uncovered", "conflation", "missing concept"] as const) {
  test(`exact recovered role answer with positive reason: ${guard}`, async t => {
    const claims = [
      { claim: "The classifier determines question and answer type.", supported: true,
        evidenceQuote: "question classifier module that determined the type of question and the type of answer" },
      { claim: "The retriever retrieves documents relevant to the question.", supported: true,
        evidenceQuote: "The retriever is aimed at retrieving relevant documents related to a given question" }
    ];
    if (guard === "unsupported claim") { claims[0].supported = false; claims[0].evidenceQuote = ""; }
    if (guard === "invalid quote") claims[0].evidenceQuote = claims[0].evidenceQuote.replace("determined", "guaranteed");
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      const prompt = JSON.parse(String(options.body)).input[1].content[0].text;
      assert.ok(prompt.includes(recoveredRoleAnswer));
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        claims, questionCovered: guard !== "question uncovered", conceptConflation: guard === "conflation",
        missingConcepts: guard === "missing concept" ? ["retriever role"] : [], reason: positiveRoleReason,
        supported: false // The model's top-level boolean is irrelevant.
      }) }));
    });
    const result = await withKey(() => verifyEvidence(roleQuestion, recoveredRoleAnswer,
      `Chunk 37:\n${sourceClassifier}\n\nChunk 40:\n${sourceRetriever}`, {
        evidenceSet: [
          { chunkIndex: 37, candidateRank: 1, score: 0.9, text: sourceClassifier },
          { chunkIndex: 40, candidateRank: 2, score: 0.8, text: sourceRetriever }
        ], missingConcepts: ["retriever role"]
      }));
    assert.equal(result.supported, guard === "none");
    assert.equal(result.reason, positiveRoleReason, "reason is never used or rewritten to derive the verdict");
  });
}

for (const [label, answer, expected] of [
  ["by contrast", "The question classifier determines the type of question and the type of answer. The retriever, by contrast, retrieves relevant documents related to the question.", true],
  ["whereas", "The question classifier determines the question and answer type, whereas the retriever retrieves relevant documents.", true],
  ["while", "While the classifier identifies the type of question and answer, the retriever retrieves relevant documents.", true],
  ["unsupported superiority", "The classifier is more accurate than the retriever.", false],
  ["unsupported absolute", "Unlike the classifier, the retriever always finds the correct document.", false]
] as const) {
  test(`role comparison: ${label} ${expected ? "passes" : "fails"} claim attribution`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      calls++;
      const input = JSON.parse(String(options.body)).input;
      const system = input[0].content[0].text;
      const prompt = input[1].content[0].text;
      // Check the actual production prompt; mock the model's semantic decisions only.
      assert.match(system, /not standalone factual claims merely because they connect a comparison/);
      assert.match(system, /factual propositions on each side independently/);
      assert.match(system, /connective itself needs no separate evidenceQuote/);
      assert.match(system, /superiority.*exclusivity.*negation.*absolutes/);
      assert.match(system, /any implied claim that X does not do Z also requires support/);
      assert.ok(prompt.includes(roleQuestion) && prompt.includes(answer) && prompt.includes(roleEvidence));
      const claims = expected ? [
        { claim: "The classifier identifies the question and answer type.", supported: true, evidenceQuote: classifierQuote },
        { claim: "The retriever retrieves relevant documents related to the question.", supported: true, evidenceQuote: retrieverQuote }
      ] : [{ claim: answer, supported: false, evidenceQuote: "" }];
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        claims, questionCovered: true, conceptConflation: false, missingConcepts: [],
        reason: expected ? "The two supported roles establish the comparison." : "The factual comparison or absolute is not supported."
      }) }));
    });
    const result = await withKey(() => verifyEvidence(roleQuestion, answer, roleEvidence, {
      evidenceSet: [
        { chunkIndex: 0, candidateRank: 1, score: 0.9, text: classifierQuote },
        { chunkIndex: 1, candidateRank: 2, score: 0.8, text: retrieverQuote }
      ], missingConcepts: ["retriever role"]
    }));
    assert.equal(result.supported, expected);
    assert.equal(calls, 1);
  });
}

// Fixed copies of the relevant prepared chunks; tests never read the live corpus.
const comparisonEvidenceSet = [
  { chunkIndex: 6, candidateRank: 1, score: 0.9,
    text: 'This is similar to humans taking closed-book exams. •\tClosed-domain question answering deals with questions under a specific domain (for example, medicine or automotive maintenance) and can exploit domain-specific knowledge frequently formalized in ontologies. Alternatively, "closed-domain" might refer to a situation where only a limited type of questions are accepted, such as questions asking for descriptive rather than procedural information. Question answering systems in the context of[vague] machine reading applications have also been constructed in the medical domain, for instance related to[vague] Alzheimer\'s disease.[3]\n\t•\tOpen-domain question answering deals with questions about nearly anything and can only rely on general ontologies and world knowledge.' },
  { chunkIndex: 5, candidateRank: 1, score: 0.85,
    text: '•\tClosed-book question answering is when a system has memorized some facts during training and can answer questions without explicitly being given a context. This is similar to humans taking closed-book exams. •\tClosed-domain question answering deals with questions under a specific domain (for example, medicine or automotive maintenance) and can exploit domain-specific knowledge frequently formalized in ontologies. Alternatively, "closed-domain" might refer to a situation where only a limited type of questions are accepted, such as questions asking for descriptive rather than procedural information.' }
];
const comparisonEvidence = comparisonEvidenceSet.map(e => `Chunk ${e.chunkIndex}:\n${e.text}`).join("\n\n");
const comparisonContext = { evidenceSet: comparisonEvidenceSet, missingConcepts: ["closed-book question answering"] };
const liveComparisonAnswer = "Closed-book question answering means a system answers from facts it has memorized during training, without being given a context. Open-domain question answering deals with questions about nearly anything and relies only on general ontologies and world knowledge.";

test("live two-chunk recovery comparison accepts supported descriptions without explicit contrast wording", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    const input = JSON.parse(String(options.body)).input;
    const system = input[0].content[0].text;
    const prompt = input[1].content[0].text;
    // A prompt-contract regression, not a mock pretending to evaluate semantics.
    assert.match(system, /supported descriptions of both requested concepts can establish the distinction without an explicit contrast sentence/);
    assert.match(system, /do not require phrases such as 'the difference is' or 'in contrast'/);
    assert.match(system, /comparison rule also applies to questionCovered and missingConcepts/);
    assert.match(system, /every material claim to be supported by the supplied evidence/);
    assert.match(system, /Reject missing sides, unsupported claims/);
    assert.match(system, /Do not output supported/);
    assert.doesNotMatch(system, /questionAligned|missingConceptsCovered/);
    assert.ok(prompt.includes(liveComparisonAnswer));
    assert.ok(prompt.includes(comparisonEvidence));
    assert.ok(prompt.includes(JSON.stringify(comparisonContext.missingConcepts)));
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: [
        { claim: liveComparisonAnswer.split(". ")[0], supported: true, evidenceQuote: comparisonEvidenceSet[1].text.slice(2).split(". ")[0] },
        { claim: liveComparisonAnswer.split(". ")[1], supported: true, evidenceQuote: comparisonEvidenceSet[0].text.split("•\t").at(-1) }
      ], questionCovered: true, conceptConflation: false, missingConcepts: [],
      supported: false, // An unsolicited model-level verdict must not override the fields.
      reason: "Both supported descriptions make the distinction clear; an explicit contrast phrase is unnecessary."
    }) }));
  });
  for (const q of [question, "Compare closed-book and open-domain question answering.",
    "How do closed-book and open-domain question answering differ?"]) {
    assert.equal((await withKey(() => verifyEvidence(q, liveComparisonAnswer, comparisonEvidence, comparisonContext))).supported, true);
  }
  assert.equal(calls, 3);
});

test("all structured sub-decisions determine acceptance despite contradictory supported and reason", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response());
  for (const evidenceSupported of [false, true]) for (const questionCovered of [false, true])
    for (const conceptConflation of [false, true]) for (const missing of [false, true]) {
      const expected = evidenceSupported && questionCovered && !conceptConflation && !missing;
      const decision = { claims: attributed(evidenceSupported, comparisonEvidenceSet[1].text), questionCovered, conceptConflation,
        missingConcepts: missing ? ["open-domain question answering"] : [],
        reason: expected ? "Reject this answer despite the successful checks." : "Accept this answer despite the failed checks." };
      assert.equal(deriveEvidenceVerification(decision, comparisonEvidence).supported, expected);
      mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
        ...decision, supported: !expected
      }) })));
      const result = await withKey(() => verifyEvidence(question, liveComparisonAnswer, comparisonEvidence, comparisonContext));
      assert.equal(result.supported, expected);
      assert.deepEqual(result.missingConcepts ?? [], decision.missingConcepts);
    }
});

test("closed-book-only coverage retains the missing open-domain diagnostic for recovery", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ output_text: JSON.stringify({
    claims: attributed(true), questionCovered: false, conceptConflation: false,
    missingConcepts: ["open-domain question answering"], reason: "The open-domain side is missing.", supported: true
  }) })));
  assert.deepEqual(await withKey(() => verifyEvidence(question,
    "Closed-book question answering answers from memorized training facts without a supplied context.", comparisonEvidence, comparisonContext)), {
    supported: false, reason: "The open-domain side is missing.", missingConcepts: ["open-domain question answering"]
  });
});

test("fabricated, empty, altered and answer-only quotes cannot support a claim", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response());
  for (const evidenceQuote of ["Invented evidence that is absent.", "", " ",
    "Closed-book question answering is when a system has memorized all facts during training", // Changes factual wording, not just whitespace.
    liveComparisonAnswer]) {
    mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: [{ claim: "A claim", supported: true, evidenceQuote }], questionCovered: true,
      conceptConflation: false, missingConcepts: [], reason: "Approved by model.", evidenceSupported: true, supported: true
    }) })));
    assert.equal((await withKey(() => verifyEvidence(question, liveComparisonAnswer, comparisonEvidence, comparisonContext))).supported, false);
  }
});

test("a faithful paraphrase is supported by a verbatim quote rather than identical answer wording", async t => {
  const quote = "A system has memorized some facts during training and can answer questions without explicitly being given a context.";
  const paraphrase = "The system answers using facts learned in training, with no context supplied.";
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const system = JSON.parse(String(options.body)).input[0].content[0].text;
    assert.match(system, /ALL material factual claims/);
    assert.match(system, /Faithful paraphrases count as supported/);
    assert.match(system, /Unsupported claims must have supported=false/);
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: [{ claim: paraphrase, supported: true, evidenceQuote: quote }],
      questionCovered: true, conceptConflation: false, missingConcepts: [], reason: "Faithful paraphrase."
    }) }));
  });
  assert.ok(!quote.includes(paraphrase));
  assert.equal((await withKey(() => verifyEvidence("How does this system answer?", paraphrase, quote))).supported, true);
});

test("empty claims cannot pass vacuously; malformed claim attribution is an operational error", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response());
  for (const claims of [[], null, [{ claim: "A claim", supported: "true", evidenceQuote: evidence }],
    [{ claim: "A claim", supported: true }], [{ claim: "", supported: true, evidenceQuote: evidence }]]) {
    mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      claims, questionCovered: true, conceptConflation: false, missingConcepts: [], reason: "Approved."
    }) })));
    const run = () => withKey(() => verifyEvidence(question, liveComparisonAnswer, comparisonEvidence, comparisonContext));
    if (Array.isArray(claims) && claims.length === 0) assert.equal((await run()).supported, false);
    else await assert.rejects(run(), /Answer verifier returned invalid JSON/);
  }
});

test("one unsupported material claim vetoes otherwise complete comparison coverage", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ output_text: JSON.stringify({
    claims: [...attributed(true, comparisonEvidenceSet[1].text),
      { claim: "Both methods always achieve 100% accuracy.", supported: false, evidenceQuote: "" }],
    questionCovered: true, conceptConflation: false,
    missingConcepts: [], reason: "The claimed perfect accuracy is not supported.", supported: true
  }) })));
  assert.equal((await withKey(() => verifyEvidence(question,
    liveComparisonAnswer + " Both methods always achieve 100% accuracy.", comparisonEvidence, comparisonContext))).supported, false);
});

test("closed-book/closed-domain conflation remains a deterministic veto", async t => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("Known conflation must not reach the model"); });
  const result = await withKey(() => verifyEvidence(question,
    "Closed-book, or closed-domain, question answering concerns a specific domain.", comparisonEvidence, comparisonContext));
  assert.equal(result.supported, false);
  assert.deepEqual(result.missingConcepts, ["closed-book question answering"]);
  assert.equal(deriveEvidenceVerification({ claims: attributed(true), questionCovered: true,
    conceptConflation: true, missingConcepts: [], reason: "Conflation." }, comparisonEvidence).supported, false);
});

test("comparison clarification does not override missing coverage, unsupported claims or concept rejection", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response());
  for (const [answer, evidenceSupported, questionCovered, missingConceptsCovered] of [
    ["Open-domain QA deals with questions about nearly anything.", true, false, false],
    [liveComparisonAnswer + " Both systems are always 100% accurate.", false, true, true],
    ["Closed-domain QA covers a specific domain. Open-domain QA covers nearly anything.", true, false, false]
  ] as const) {
    mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: attributed(evidenceSupported), questionCovered, conceptConflation: false, missingConcepts: missingConceptsCovered ? [] : ["closed-book question answering"], reason: "A required check failed."
    }) })));
    assert.equal((await withKey(() => verifyEvidence(question, answer, comparisonEvidence, comparisonContext))).supported, false);
  }
  mock.mock.mockImplementation(async () => { assert.fail("Conflation must be rejected before the model call"); });
  assert.equal((await withKey(() => verifyEvidence(question,
    "Closed-book or closed-domain question answering deals with a specific domain.", comparisonEvidence, comparisonContext))).supported, false);
});

test("recovery rejects higher-ranked chunk 4 and selects chunk 5 with real selector, generator, verifier, graph and web adapter", async t => {
  const missing = "Closed-book question answering answers using knowledge stored in model parameters, without retrieving external documents.";
  const answer = "Closed-book QA uses stored model knowledge without external retrieval. Open-domain QA covers unrestricted subject matter. These describe different dimensions.";
  const prepared = { ...corpus, chunks: Array.from({ length: 7 }, (_, id) => ({
    id, text: id === 5 ? missing : evidence, sentence_ids: [], startSentence: 0, endSentence: 0
  })) };
  let retrievals = 0;
  let generations = 0;
  let verifications = 0;
  const considered: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const { input } = JSON.parse(String(options.body));
    const system = input[0].content[0].text;
    const prompt = input[1].content[0].text;
    assert.ok(prompt.includes(question), "generation/verification retain the original question");
    if (system.startsWith("You are a complementary-evidence selector.")) {
      const data = JSON.parse(prompt);
      assert.deepEqual(data.missingConcepts, ["closed-book question answering"]);
      assert.deepEqual(data.currentEvidence.map((e: { chunkIndex: number }) => e.chunkIndex), [6]);
      assert.match(system, /Mentioning a phrase.*lexical overlap.*insufficient/);
      assert.match(system, /actual new factual support/);
      considered.push(data.candidate.chunkIndex);
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        addsMissingSupport: data.candidate.chunkIndex === 5,
        reason: data.candidate.chunkIndex === 5 ? "Defines closed-book answering without external retrieval." : "Mentions the term without defining it; no missing support added."
      }) }));
    }
    if (system.startsWith("You are a response agent.")) {
      generations++;
      if (generations === 1) {
        assert.ok(!prompt.includes(missing));
        return new Response(JSON.stringify({ output_text: "Closed-book, or **closed-domain**, question answering is limited to a specific domain..." }));
      }
      assert.match(prompt, /Chunk 6:/);
      assert.match(prompt, /Chunk 5:/);
      assert.ok(prompt.includes(evidence) && prompt.includes(missing));
      return new Response(JSON.stringify({ output_text: answer }));
    }
    verifications++;
    assert.ok(prompt.includes(evidence) && prompt.includes(missing));
    assert.match(prompt, /Previously missing concepts:[\s\S]*closed-book question answering/);
    assert.match(system, /ALL previously missing concepts/);
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: attributed(true), questionCovered: true, conceptConflation: false, missingConcepts: [],
      reason: "Chunk 5 defines closed-book; chunk 6 defines open-domain. No equivalence is asserted."
    }) }));
  });
  const result = await withKey(() => createWorkflowService({
    retrieveCandidates: async (query, actualCorpus, k) => {
      assert.equal(actualCorpus, prepared);
      if (++retrievals === 1) { assert.equal(query, question); assert.equal(k, 5); return [candidate(evidence, 6)]; }
      assert.equal(query, "What is closed-book question answering?");
      assert.equal(k, 7, "recovery ranks the corpus without truncating away remaining chunks");
      return [candidate("Closed-book question answering is a research topic.", 4), candidate(evidence, 6),
        { ...candidate(missing, 5), guiding_question: "What is closed-book question answering?" }];
    }, generateAnswer: generateResponse, verifyAnswer: verifyEvidence
  })(question, prepared));
  assert.equal(result.result.action, "answer");
  if (result.result.action !== "answer") assert.fail("Expected recovered answer");
  assert.equal(result.result.answer, answer);
  assert.deepEqual(result.result.evidenceSet, [
    { chunkIndex: 6, text: evidence, candidateRank: 1, score: candidate(evidence, 6).score, retrievalQuery: question },
    { chunkIndex: 5, text: missing, candidateRank: 3, score: candidate(missing, 5).score, retrievalQuery: "What is closed-book question answering?" }
  ]);
  assert.deepEqual(result.retrievedEvidence.filter(e => e.status === "accepted").map(e => e.chunkIndex), [6, 5]);
  assert.equal(retrievals, 2);
  assert.equal(generations, 2);
  assert.equal(verifications, 1, "first rejection is the real deterministic concept guard");
  assert.deepEqual(considered, [4, 5], "chunk 6 is skipped and lexical mention in chunk 4 is insufficient");
});

test("complement selector rejects malformed verdicts and sanitizes decoded secrets", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response());
  const key = "sk-test-verifier-12345678901234567890";
  for (const value of [null, { addsMissingSupport: "true", reason: "Wrong type" },
    { addsMissingSupport: true }, { addsMissingSupport: false, reason: " " },
    { addsMissingSupport: true, reason: key }]) {
    const text = JSON.stringify(value).replace(key, key.split("").map(c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join(""));
    mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: text })));
    await assert.rejects(withKey(() => checkComplementSupport(question, comparisonContext.missingConcepts,
      [comparisonEvidenceSet[0]], comparisonEvidenceSet[1])), error => {
      assert.ok(error instanceof Error && !String(error).includes(key));
      assert.match(String(error), /Complement selector returned an invalid verdict/);
      return true;
    });
  }
});

test("recovery verification requires missing coverage and still rejects unsupported aliases", async t => {
  const context = { evidenceSet: [], missingConcepts: ["closed-book question answering"] };
  const mock = t.mock.method(globalThis, "fetch", async () => new Response());
  for (const covered of [false, true]) {
    mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: attributed(true), questionCovered: covered, conceptConflation: false, missingConcepts: covered ? [] : ["closed-book question answering"], reason: "Coverage checked."
    }) })));
    const result = await withKey(() => verifyEvidence(question, "Closed-book QA and open-domain QA are distinct.", evidence, context));
    assert.equal(result.supported, covered);
  }
  assert.equal((await withKey(() => verifyEvidence(question, incorrectAnswer, evidence, context))).supported, false);
  mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
    claims: attributed(true), questionCovered: true, conceptConflation: false, reason: "Missing coverage verdict."
  }) })));
  await assert.rejects(withKey(() => verifyEvidence(question, "Distinct concepts.", evidence, context)), /invalid JSON/);
});

test("model coverage diagnostics are required, validated and preserved on contradictory coverage", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response());
  const reply = (extra: object) => mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
    claims: attributed(false), questionCovered: false, conceptConflation: false, missingConcepts: [], reason: "Missing coverage.", ...extra
  }) })));
  reply({ missingConcepts: ["closed-book question answering"] });
  assert.deepEqual((await withKey(() => verifyEvidence(question, "Partial answer.", evidence))).missingConcepts, ["closed-book question answering"]);
  reply({ claims: attributed(true), questionCovered: true, missingConcepts: ["closed-book question answering"] });
  assert.deepEqual((await withKey(() => verifyEvidence(question, "Aligned answer.", evidence))).missingConcepts, ["closed-book question answering"]);
  for (const missingConcepts of ["concept", [""], [null], ["x".repeat(161)], ["a", "b", "c", "d"]]) {
    reply({ missingConcepts });
    await assert.rejects(withKey(() => verifyEvidence(question, "Partial answer.", evidence)), /invalid JSON/);
  }
});

test("exact closed-book/closed-domain regression is rejected by the real verifier and graph", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    // Even an erroneous positive model verdict must not allow this known conflation.
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: attributed(true), questionCovered: true, conceptConflation: false, missingConcepts: [], reason: "Incorrect approval."
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
    output_text: JSON.stringify({ claims: attributed(true, aligned), questionCovered: true, conceptConflation: false, missingConcepts: [], reason: "The original concepts are preserved." })
  })));
  const result = await withKey(() => runWorkflow(question, corpus, {
    retrieveCandidates: async () => [candidate(evidence), candidate(aligned, 1)],
    generateAnswer: async (_question, passage) => passage === evidence ? incorrectAnswer : aligned,
    verifyAnswer: verifyEvidence
  }));
  assert.equal(result.action, "answer");
  if (result.action === "answer") assert.equal(result.evidence.candidateRank, 2);
});

for (const [evidenceSupported, questionCovered] of [[true, true], [true, false], [false, true], [false, false]]) {
  test(`acceptance requires both checks: evidence=${evidenceSupported}, alignment=${questionCovered}`, async t => {
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      const input = JSON.parse(String(options.body)).input;
      const system = input[0].content[0].text;
      const user = input[1].content[0].text;
      assert.match(system, /claim-level attribution/);
      assert.match(system, /Do not reinterpret the question/);
      assert.match(system, /merges terms whose equivalence is not established/);
      assert.ok(user.includes(question) && user.includes(evidence));
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        claims: attributed(evidenceSupported), questionCovered, conceptConflation: false, missingConcepts: [], reason: "Separate checks."
      }) }));
    });
    // Isolate the two verdict flags; deterministic substitutions are tested separately.
    const verdict = await withKey(() => verifyEvidence(question,
      "Closed-book QA and open-domain QA concern different dimensions.", evidence));
    assert.equal(verdict.supported, evidenceSupported && questionCovered);
  });
}

test("a supported distinction or correction is not rejected by the conflation guard", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    const supplied = JSON.parse(String(options.body)).input[1].content[0].text.split("Evidence:\n")[1].split("\n\n")[0];
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: attributed(true, supplied), questionCovered: true, conceptConflation: false, missingConcepts: [], reason: "An explicit distinction, not an equivalence."
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
      claims: attributed(true), questionCovered: true, conceptConflation: false, missingConcepts: [],
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
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    const supplied = JSON.parse(String(options.body)).input[1].content[0].text.split("Evidence:\n")[1].split("\n\n")[0];
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      claims: attributed(true), questionCovered: true, conceptConflation: false, missingConcepts: [], reason: "Incorrect approval."
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

test("model reason text cannot override valid structured sub-decisions", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    output_text: JSON.stringify({
      claims: attributed(true), questionCovered: true, conceptConflation: false, missingConcepts: [],
      reason: "It contrasts closed-book/**closed-domain** question answering with open-domain question answering."
    })
  })));
  const verdict = await withKey(() => verifyEvidence(question, "Closed-book QA uses internal knowledge.", evidence));
  assert.equal(verdict.supported, true);
  assert.match(verdict.reason, /It contrasts/);
});

test("missing or malformed alignment verdicts remain operational errors, never approval", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response());
  for (const value of [
    { supported: true, reason: "Legacy single verdict." },
    { claims: attributed(true), reason: "Alignment missing." },
    { claims: attributed(true), questionCovered: "true", reason: "Wrong type." },
    { claims: attributed(true), questionCovered: true },
    null
  ]) {
    mock.mock.mockImplementation(async () => new Response(JSON.stringify({ output_text: JSON.stringify(value) })));
    await assert.rejects(withKey(() => verifyEvidence(question, "An answer.", evidence)), /Answer verifier returned/);
  }
});
