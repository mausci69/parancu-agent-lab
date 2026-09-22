import {
  Annotation,
  END,
  START,
  StateGraph
} from "@langchain/langgraph";

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
    const candidates = await dependencies.retrieveCandidates(
      state.question,
      state.corpus,
      5
    );

    return {
      candidates,
      candidateIndex: 0,
      answer: null,
      supported: null,
      reason: null
    };
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

    const answer = await dependencies.generateAnswer(
      state.question,
      candidate.chunk
    );

    return {
      answer
    };
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

    const verification = await dependencies.verifyAnswer(
      state.question,
      state.answer,
      candidate.chunk
    );

    return {
      supported: verification.supported,
      reason: verification.reason
    };
  }

  async function advanceNode(
    state: typeof WorkflowState.State
  ) {
    return {
      candidateIndex: state.candidateIndex + 1,
      answer: null,
      supported: null,
      reason: null
    };
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
