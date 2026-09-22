import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import { workflowGraph } from "./graph";

export type WorkflowResult =
  | {
      action: "answer";
      question: string;
      answer: string;
      chunk: string;
      summary: string;
      chunkIndex: number;
      candidateRank: number;
      score: number;
      reason: string;
    }
  | {
      action: "no_evidence";
      question: string;
    };

export async function runWorkflow(
  question: string,
  corpus: PrepareResult
): Promise<WorkflowResult> {
  const state = await workflowGraph.invoke({
    question,
    corpus,
    candidates: [],
    candidateIndex: 0,
    answer: null,
    supported: null,
    reason: null
  });

  const candidate = state.candidates[state.candidateIndex];

  if (
    state.supported &&
    state.answer &&
    candidate
  ) {
    return {
      action: "answer",
      question,
      answer: state.answer,
      chunk: candidate.chunk,
      summary: candidate.summary,
      chunkIndex: candidate.chunk_index,
      candidateRank: state.candidateIndex + 1,
      score: candidate.score,
      reason: state.reason ?? ""
    };
  }

  return {
    action: "no_evidence",
    question
  };
}
