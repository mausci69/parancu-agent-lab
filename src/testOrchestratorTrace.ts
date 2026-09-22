import type { PrepareResult } from "../services/parancu-api/src/local/prepareCorpus";
import type { OrchestrationTrace } from "./observability/orchestrationTrace";
import {
  runOrchestrator,
  type OrchestratorDependencies
} from "./agent/orchestrator";

async function main() {
  const corpus = {
    docId: "trace-test",
    sentences: [],
    chunks: []
  } as unknown as PrepareResult;

  const trace: OrchestrationTrace = {
    events: []
  };

  const dependencies: OrchestratorDependencies = {
    trace,
    retrieveCandidates: async () => [
      {
        chunk_index: 0,
        guiding_question: "What material is the prototype made from?",
        answer_focus: "",
        chunk: "The Atlas prototype uses an aluminium frame.",
        summary: "Atlas uses an aluminium frame.",
        sentence_ids: [0],
        score: 0.91,
        cosine_score: 0.91
      },
      {
        chunk_index: 1,
        guiding_question: "What color is the Atlas prototype?",
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
          reason: "The requested color is present in the evidence."
        };
      }

      return {
        supported: false,
        reason: "The evidence does not contain the requested color."
      };
    }
  };

  const result = await runOrchestrator(
    "What color is the Atlas prototype?",
    corpus,
    dependencies
  );

  console.log(
    JSON.stringify(
      {
        result,
        trace
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
