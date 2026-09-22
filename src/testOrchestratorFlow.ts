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
      guiding_question: "What material is the Atlas prototype made from?",
      answer_focus: "Atlas prototype material",
      chunk:
        "The Atlas prototype is made from aluminium and weighs 1.2 kilograms.",
      summary:
        "The Atlas prototype is made from aluminium.",
      sentence_ids: [0],
      score: 0.91,
      cosine_score: 0.91
    },
    {
      chunk_index: 1,
      guiding_question: "What color is the Atlas prototype?",
      answer_focus: "Atlas prototype color",
      chunk:
        "The Atlas prototype is blue and was developed by the research team.",
      summary:
        "The Atlas prototype is blue.",
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
      if (evidence.includes("aluminium")) {
        return "The Atlas prototype is made from aluminium.";
      }

      return "The Atlas prototype is blue.";
    },

    verifyAnswer: async (
      question,
      answer,
      evidence
    ) => {
      const supported =
        question.toLowerCase().includes("color") &&
        answer.toLowerCase().includes("blue") &&
        evidence.toLowerCase().includes("blue");

      return {
        supported,
        reason: supported
          ? "The answer provides the requested color and is supported by the evidence."
          : "The answer does not provide the requested color."
      };
    }
  };

  const result = await runOrchestrator(
    "What color is the Atlas prototype?",
    corpus,
    dependencies
  );

  console.log(
    JSON.stringify(result, null, 2)
  );

  if (
    result.action !== "answer" ||
    result.candidateRank !== 2
  ) {
    throw new Error(
      "Expected candidate rank 2."
    );
  }

  console.log(
    "\nPASS: candidate 1 rejected, candidate 2 accepted."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
