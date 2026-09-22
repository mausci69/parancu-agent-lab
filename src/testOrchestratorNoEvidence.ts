import type { PrepareResult } from "../services/parancu-api/src/local/prepareCorpus";
import type { RetrieveResult } from "../services/parancu-api/src/local/retrieval";

import {
  runOrchestrator,
  type OrchestratorDependencies
} from "./agent/orchestrator";

async function main() {
  const corpus: PrepareResult = {
    docId: "test-document",
    sentences: [],
    chunks: []
  };

  const candidates: RetrieveResult[] = [
    {
      chunk_index: 0,
      guiding_question: "What material is the prototype made from?",
      answer_focus: "prototype material",
      chunk: "The prototype is made from aluminium.",
      summary: "The prototype is made from aluminium.",
      sentence_ids: [0],
      score: 0.91,
      cosine_score: 0.91
    },
    {
      chunk_index: 1,
      guiding_question: "How much does the prototype weigh?",
      answer_focus: "prototype weight",
      chunk: "The prototype weighs 1.2 kilograms.",
      summary: "The prototype weighs 1.2 kilograms.",
      sentence_ids: [1],
      score: 0.84,
      cosine_score: 0.84
    }
  ];

  const dependencies: OrchestratorDependencies = {
    retrieveCandidates: async () => candidates,

    generateAnswer: async (
      question,
      evidence
    ) => {
      return evidence;
    },

    verifyAnswer: async () => {
      return {
        supported: false,
        reason: "The evidence does not answer the requested question."
      };
    }
  };

  const result = await runOrchestrator(
    "What color is the prototype?",
    corpus,
    dependencies
  );

  console.log(
    JSON.stringify(result, null, 2)
  );

  if (result.action !== "no_evidence") {
    throw new Error(
      "Expected no_evidence."
    );
  }

  console.log(
    "\nPASS: all candidates rejected."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
