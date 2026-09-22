import type { PrepareResult } from "../services/parancu-api/src/local/prepareCorpus";
import { createWorkflowGraph } from "./workflow/graph";

async function main() {
  const corpus = {
    docId: "workflow-fallback-test",
    sentences: [],
    chunks: []
  } as unknown as PrepareResult;

  const graph = createWorkflowGraph({
    retrieveCandidates: async () => [
      {
        chunk_index: 0,
        guiding_question: "What material is Atlas made from?",
        answer_focus: "",
        chunk: "The Atlas prototype uses an aluminium frame.",
        summary: "Atlas uses aluminium.",
        sentence_ids: [0],
        score: 0.91,
        cosine_score: 0.91
      },
      {
        chunk_index: 1,
        guiding_question: "What color is Atlas?",
        answer_focus: "",
        chunk: "The Atlas prototype is blue.",
        summary: "Atlas is blue.",
        sentence_ids: [1],
        score: 0.84,
        cosine_score: 0.84
      }
    ],

    generateAnswer: async (_question, evidence) => {
      if (evidence.includes("blue")) {
        return "The Atlas prototype is blue.";
      }

      return "The Atlas prototype uses an aluminium frame.";
    },

    verifyAnswer: async (_question, _answer, evidence) => {
      if (evidence.includes("blue")) {
        return {
          supported: true,
          reason: "The requested color is present."
        };
      }

      return {
        supported: false,
        reason: "The requested color is not present."
      };
    }
  });

  const state = await graph.invoke({
    question: "What color is the Atlas prototype?",
    corpus,
    candidates: [],
    candidateIndex: 0,
    answer: null,
    supported: null,
    reason: null
  });

  console.log(
    JSON.stringify(
      state,
      null,
      2
    )
  );

  if (
    state.candidateIndex !== 1 ||
    state.supported !== true ||
    state.answer !== "The Atlas prototype is blue."
  ) {
    throw new Error(
      "Expected candidate 1 to fail and candidate 2 to pass."
    );
  }

  console.log(
    "PASS: LangGraph fallback moved from candidate 1 to candidate 2."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
