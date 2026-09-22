import {
  Annotation,
  END,
  START,
  StateGraph
} from "@langchain/langgraph";
import { startActiveObservation } from "@langfuse/tracing";

import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import {
  retrieveCandidatesFromPrepared,
  type RetrieveResult
} from "../../services/parancu-api/src/local/retrieval";
import { generateResponse } from "../responder/responseAgent";
import { verifyEvidence } from "../verifier/evidenceVerifier";

export type WorkflowDependencies = {
  retrieveCandidates: (
    question: string,
    corpus: PrepareResult,
    k: number
  ) => Promise<RetrieveResult[]>;
  generateAnswer: (
    question: string,
    evidence: string
  ) => Promise<string>;
  verifyAnswer: (
    question: string,
    answer: string,
    evidence: string
  ) => Promise<{
    supported: boolean;
    reason: string;
  }>;
};

const defaultDependencies: WorkflowDependencies = {
  retrieveCandidates: retrieveCandidatesFromPrepared,
  generateAnswer: generateResponse,
  verifyAnswer: verifyEvidence
};

const WorkflowState = Annotation.Root({
  question: Annotation<string>(),
  corpus: Annotation<PrepareResult>(),
  candidates: Annotation<RetrieveResult[]>(),
  candidateIndex: Annotation<number>(),
  answer: Annotation<string | null>(),
  supported: Annotation<boolean | null>(),
  reason: Annotation<string | null>()
});

export function createWorkflowGraph(
  dependencies: WorkflowDependencies = defaultDependencies
) {
  async function retrieveNode(
    state: typeof WorkflowState.State
  ) {
    return startActiveObservation(
      "retrieve",
      async (span) => {
        span.update({
          input: {
            question: state.question
          }
        });

        const candidates = await dependencies.retrieveCandidates(
          state.question,
          state.corpus,
          5
        );

        span.update({
          output: {
            candidateCount: candidates.length,
            candidates: candidates.map((candidate, index) => ({
              rank: index + 1,
              chunkIndex: candidate.chunk_index,
              score: candidate.score
            }))
          }
        });

        return {
          candidates,
          candidateIndex: 0,
          answer: null,
          supported: null,
          reason: null
        };
      }
    );
  }

  async function generateNode(
    state: typeof WorkflowState.State
  ) {
    const candidate = state.candidates[state.candidateIndex];

    if (!candidate) {
      return {
        answer: null
      };
    }

    return startActiveObservation(
      "generate",
      async (span) => {
        span.update({
          input: {
            candidateRank: state.candidateIndex + 1,
            chunkIndex: candidate.chunk_index,
            evidence: candidate.chunk
          }
        });

        const answer = await dependencies.generateAnswer(
          state.question,
          candidate.chunk
        );

        span.update({
          output: {
            answer
          }
        });

        return {
          answer
        };
      }
    );
  }

  async function verifyNode(
    state: typeof WorkflowState.State
  ) {
    const candidate = state.candidates[state.candidateIndex];

    if (!candidate || !state.answer) {
      return {
        supported: false,
        reason: "No candidate or generated answer available."
      };
    }

    const answer = state.answer;

    return startActiveObservation(
      "verify",
      async (span) => {
        span.update({
          input: {
            candidateRank: state.candidateIndex + 1,
            answer,
            evidence: candidate.chunk
          }
        });

        const verification = await dependencies.verifyAnswer(
          state.question,
          answer,
          candidate.chunk
        );

        span.update({
          output: verification
        });

        return {
          supported: verification.supported,
          reason: verification.reason
        };
      }
    );
  }

  async function advanceNode(
    state: typeof WorkflowState.State
  ) {
    return startActiveObservation(
      "advance",
      async (span) => {
        const nextCandidateIndex = state.candidateIndex + 1;

        span.update({
          input: {
            currentCandidateRank: state.candidateIndex + 1
          },
          output: {
            nextCandidateRank: nextCandidateIndex + 1
          }
        });

        return {
          candidateIndex: nextCandidateIndex,
          answer: null,
          supported: null,
          reason: null
        };
      }
    );
  }

  function routeAfterVerification(
    state: typeof WorkflowState.State
  ) {
    if (state.supported) {
      return "end";
    }

    if (
      state.candidateIndex + 1 >=
      state.candidates.length
    ) {
      return "end";
    }

    return "advance";
  }

  return new StateGraph(WorkflowState)
    .addNode("retrieve", retrieveNode)
    .addNode("generate", generateNode)
    .addNode("verify", verifyNode)
    .addNode("advance", advanceNode)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "generate")
    .addEdge("generate", "verify")
    .addConditionalEdges(
      "verify",
      routeAfterVerification,
      {
        advance: "advance",
        end: END
      }
    )
    .addEdge("advance", "generate")
    .compile();
}

export const workflowGraph = createWorkflowGraph();
