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
