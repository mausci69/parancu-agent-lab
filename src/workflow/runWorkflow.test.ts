import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import type { RetrieveResult } from "../../services/parancu-api/src/local/retrieval";
import type { WorkflowDependencies } from "./graph";
import { runWorkflow } from "./runWorkflow";

const question = "What color is Atlas?";
const corpus: PrepareResult = { docId: "boundary-test", sentences: [], chunks: [] };
const candidates: RetrieveResult[] = Array.from({ length: 5 }, (_, index) => ({
  chunk_index: 10 + index,
  guiding_question: question,
  answer_focus: "",
  chunk: `Synthetic evidence ${index + 1}: Atlas is blue.`,
  summary: `Summary ${index + 1}`,
  sentence_ids: [index],
  score: 0.9 - index * 0.1,
  cosine_score: 0.95 - index * 0.1
}));

// These fakes replace every external operation; the real graph and wrapper run.
function fixture(items = candidates, acceptedRank = 1) {
  const calls: unknown[][] = [];
  const dependencies: WorkflowDependencies = {
    retrieveCandidates: async (...args) => {
      calls.push(["retrieve", ...args]);
      return items;
    },
    generateAnswer: async (q, evidence) => {
      calls.push(["generate", q, evidence]);
      return `Answer from ${evidence}`;
    },
    verifyAnswer: async (q, answer, evidence) => {
      calls.push(["verify", q, answer, evidence]);
      return {
        supported: items.findIndex(item => item.chunk === evidence) + 1 === acceptedRank,
        reason: `Checked ${evidence}`
      };
    }
  };
  return { calls, dependencies };
}

function expectedCalls(items: RetrieveResult[]) {
  return [
    ["retrieve", question, corpus, 5],
    ...items.flatMap(item => [
      ["generate", question, item.chunk],
      ["verify", question, `Answer from ${item.chunk}`, item.chunk]
    ])
  ];
}

test("empty retrieval returns no_evidence without model calls", async () => {
  const { calls, dependencies } = fixture([]);
  assert.deepEqual(await runWorkflow(question, corpus, dependencies), {
    action: "no_evidence", question
  });
  assert.deepEqual(calls, [["retrieve", question, corpus, 5]]);
});

for (const rank of [1, 2, 3, 4, 5]) {
  test(`candidate ${rank} can supply the accepted answer with exact provenance`, async () => {
    const { calls, dependencies } = fixture(candidates, rank);
    const candidate = candidates[rank - 1];
    assert.deepEqual(await runWorkflow(question, corpus, dependencies), {
      action: "answer",
      question,
      answer: `Answer from ${candidate.chunk}`,
      chunk: candidate.chunk,
      summary: candidate.summary,
      chunkIndex: candidate.chunk_index,
      candidateRank: rank,
      score: candidate.score,
      reason: `Checked ${candidate.chunk}`,
      evidence: {
        chunkIndex: candidate.chunk_index,
        text: candidate.chunk,
        candidateRank: rank,
        score: candidate.score
      }
    });
    // Also verifies one retrieval, candidate order, evidence isolation and early stop.
    assert.deepEqual(calls, expectedCalls(candidates.slice(0, rank)));
  });
}

test("all five candidates rejected returns no_evidence without a rejected draft", async () => {
  const { calls, dependencies } = fixture(candidates, 0);
  assert.deepEqual(await runWorkflow(question, corpus, dependencies), {
    action: "no_evidence", question
  });
  assert.deepEqual(calls, expectedCalls(candidates));
});

for (const stage of ["retrieveCandidates", "generateAnswer", "verifyAnswer"] as const) {
  test(`${stage} failure propagates the original error and stops processing`, async () => {
    const { calls, dependencies } = fixture();
    const failure = new Error(`${stage} failed`);
    const failures: string[] = [];
    dependencies[stage] = async () => {
      failures.push(stage);
      throw failure;
    };
    await assert.rejects(runWorkflow(question, corpus, dependencies), error => error === failure);
    assert.deepEqual(failures, [stage]);
    const completedCalls = stage === "retrieveCandidates" ? 0 : stage === "generateAnswer" ? 1 : 2;
    assert.deepEqual(calls, expectedCalls(candidates.slice(0, 1)).slice(0, completedCalls));
  });
}

function recoveryFixture() {
  const items = candidates.slice(0, 3).map((c, index) => ({ ...c, chunk_index: index }));
  const prepared: PrepareResult = { ...corpus, chunks: items.map(c => ({
    id: c.chunk_index, text: c.chunk, startSentence: 0, endSentence: 0, sentence_ids: []
  })) };
  const queries: string[] = [];
  const generated: string[] = [];
  const dependencies: WorkflowDependencies = {
    retrieveCandidates: async q => { queries.push(q); return queries.length === 1 ? items.slice(0, 2) : items; },
    checkComplement: async () => ({ addsMissingSupport: true, reason: "Additional support." }),
    generateAnswer: async (_q, text) => { generated.push(text); return "Unsupported answer"; },
    verifyAnswer: async () => ({ supported: false, reason: "Missing concept.", missingConcepts: ["Atlas color"] })
  };
  return { items, prepared, queries, generated, dependencies };
}

test("no valid complementary evidence preserves no_evidence and attempts recovery only once", async () => {
  const f = recoveryFixture();
  f.dependencies.retrieveCandidates = async q => {
    f.queries.push(q);
    // Only the original chunk, an invalid index, and empty text are returned.
    return f.queries.length === 1 ? [f.items[0]] : [f.items[0], { ...f.items[1], chunk_index: -1 }, { ...f.items[2], chunk: " " }];
  };
  assert.deepEqual(await runWorkflow(question, f.prepared, f.dependencies), { action: "no_evidence", question });
  assert.deepEqual(f.queries, [question, "What is Atlas color?"]);
  assert.equal(f.generated.length, 1);
});

test("unrelated verification rejection does not retrieve for recovery", async () => {
  const f = recoveryFixture();
  f.dependencies.verifyAnswer = async () => ({ supported: false, reason: "Unsupported date." });
  assert.deepEqual(await runWorkflow(question, f.prepared, f.dependencies), { action: "no_evidence", question });
  assert.deepEqual(f.queries, [question]);
  assert.equal(f.generated.length, 2);
});

test("recovery excludes every previously tried chunk, preserving original indices and query rank", async () => {
  const f = recoveryFixture();
  const considered: number[] = [];
  f.dependencies.checkComplement = async (_q, _missing, current, candidate) => {
    assert.deepEqual(current.map(e => e.chunkIndex), [1]);
    considered.push(candidate.chunkIndex);
    return { addsMissingSupport: true, reason: "Adds support." };
  };
  f.dependencies.verifyAnswer = async (_q, _answer, text, context) => {
    if (context) {
      assert.deepEqual(context.evidenceSet.map(e => [e.chunkIndex, e.candidateRank]), [[1, 2], [2, 3]]);
      return { supported: true, reason: "Combined support." };
    }
    return { supported: false, reason: "Rejected.", ...(text === f.items[1].chunk ? { missingConcepts: ["Atlas color"] } : {}) };
  };
  const result = await runWorkflow(question, f.prepared, f.dependencies);
  assert.equal(result.action, "answer");
  assert.equal(f.queries.length, 2);
  assert.deepEqual(considered, [2], "both the original and previously used chunks are skipped before checking");
});

test("first eligible complement with sufficient support is selected immediately", async () => {
  const f = recoveryFixture();
  const considered: number[] = [];
  f.dependencies.checkComplement = async (_q, missing, current, candidate) => {
    assert.deepEqual(missing, ["Atlas color"]);
    assert.deepEqual(current.map(e => e.chunkIndex), [0]);
    considered.push(candidate.chunkIndex);
    return { addsMissingSupport: true, reason: "Sufficient new support." };
  };
  f.dependencies.verifyAnswer = async (_q, _answer, _text, context) => ({
    supported: Boolean(context), reason: "Checked.", ...(!context ? { missingConcepts: ["Atlas color"] } : {})
  });
  const result = await runWorkflow(question, f.prepared, f.dependencies);
  assert.equal(result.action, "answer");
  assert.deepEqual(considered, [1], "remaining candidates are not checked after acceptance");
  if (result.action === "answer") assert.equal(result.evidenceSet?.[1].candidateRank, 2);
});

test("no candidate adds missing support: no combined generation, then original fallback resumes", async () => {
  const f = recoveryFixture();
  const considered: number[] = [];
  f.dependencies.checkComplement = async (_q, _missing, current, candidate) => {
    assert.deepEqual(current.map(e => e.chunkIndex), [0], "rejected candidates never accumulate into evidence");
    considered.push(candidate.chunkIndex);
    return { addsMissingSupport: false, reason: "Insufficient support." };
  };
  assert.deepEqual(await runWorkflow(question, f.prepared, f.dependencies), { action: "no_evidence", question });
  assert.deepEqual(considered, [1, 2]);
  assert.deepEqual(f.generated, [f.items[0].chunk, f.items[1].chunk]);
  assert.equal(f.queries.length, 2, "fallback cannot launch another recovery");
});

test("empty recovery generation is an operational error", async () => {
  const f = recoveryFixture();
  f.dependencies.generateAnswer = async (_q, _text, context) => context ? " " : "Partial answer";
  await assert.rejects(runWorkflow(question, f.prepared, f.dependencies), /Recovery generation returned an empty answer/);
});

test("failed recovery is limited to two chunks and one attempt, then ordinary fallback continues", async () => {
  const f = recoveryFixture();
  let recoveryVerifications = 0;
  f.dependencies.verifyAnswer = async (q, _answer, text, context) => {
    assert.equal(q, question);
    if (context) {
      recoveryVerifications++;
      assert.deepEqual(context.evidenceSet.map(e => e.chunkIndex), [0, 1]);
      assert.ok(text.includes(f.items[0].chunk) && text.includes(f.items[1].chunk));
      assert.ok(!text.includes(f.items[2].chunk));
    }
    return { supported: false, reason: "Still missing.", missingConcepts: ["Atlas color"] };
  };
  assert.deepEqual(await runWorkflow(question, f.prepared, f.dependencies), { action: "no_evidence", question });
  assert.equal(f.queries.length, 2);
  assert.equal(recoveryVerifications, 1);
  assert.equal(f.generated.length, 3);
  assert.equal(f.generated[2], f.items[1].chunk, "fallback returns to single-candidate evidence");
});

test("a later single candidate can still succeed after failed recovery without stale composed evidence", async () => {
  const f = recoveryFixture();
  f.dependencies.verifyAnswer = async (_q, _answer, text, context) => ({
    supported: !context && text === f.items[1].chunk, reason: "Checked.", missingConcepts: ["Atlas color"]
  });
  const result = await runWorkflow(question, f.prepared, f.dependencies);
  assert.equal(result.action, "answer");
  if (result.action !== "answer") assert.fail();
  assert.equal(result.candidateRank, 2);
  assert.equal(result.evidenceSet, undefined);
  assert.equal(f.queries.length, 2);
});

for (const stage of ["retrieve", "select", "generate", "verify"]) {
  test(`recovery ${stage} operational failure propagates unchanged`, async () => {
    const f = recoveryFixture();
    const failure = new Error("Recovery failed");
    const originalRetrieve = f.dependencies.retrieveCandidates;
    const originalGenerate = f.dependencies.generateAnswer;
    const originalVerify = f.dependencies.verifyAnswer;
    if (stage === "select") f.dependencies.checkComplement = async () => { throw failure; };
    f.dependencies.retrieveCandidates = async (...args) => {
      if (stage === "retrieve" && f.queries.length) throw failure;
      return originalRetrieve(...args);
    };
    f.dependencies.generateAnswer = async (...args) => {
      if (stage === "generate" && args[2]) throw failure;
      return originalGenerate(...args);
    };
    f.dependencies.verifyAnswer = async (...args) => {
      if (stage === "verify" && args[3]) throw failure;
      return originalVerify(...args);
    };
    await assert.rejects(runWorkflow(question, f.prepared, f.dependencies), error => error === failure);
  });
}
