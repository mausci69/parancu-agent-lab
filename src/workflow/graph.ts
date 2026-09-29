import {
  Annotation,
  END,
  START,
  StateGraph
} from "@langchain/langgraph";
import { startActiveObservation } from "../observability/langfuse";

import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import {
  retrieveCandidatesFromPrepared,
  type RetrieveResult
} from "../../services/parancu-api/src/local/retrieval";
import { generateResponse } from "../responder/responseAgent";
import { verifyEvidence } from "../verifier/evidenceVerifier";
import type { EvidenceVerification } from "../verifier/evidenceVerifier";
import type { EvidenceContext, WorkflowEvidence } from "./state";
import { checkComplementSupport } from "../verifier/complementSelector";

export type WorkflowDependencies = {
  checkComplement?: typeof checkComplementSupport;
  retrieveCandidates: (
    question: string,
    corpus: PrepareResult,
    k: number
  ) => Promise<RetrieveResult[]>;
  generateAnswer: (
    question: string,
    evidence: string,
    context?: EvidenceContext
  ) => Promise<string>;
  verifyAnswer: (
    question: string,
    answer: string,
    evidence: string,
    context?: EvidenceContext
  ) => Promise<EvidenceVerification>;
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
  reason: Annotation<string | null>(),
  missingConcepts: Annotation<string[]>(),
  recoveryAttempted: Annotation<boolean>(),
  evidenceSet: Annotation<WorkflowEvidence[]>()
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
        span.update({ chunkCount: state.corpus.chunks.length });

        const candidates = await dependencies.retrieveCandidates(
          state.question,
          state.corpus,
          5
        );

        span.update({ candidateCount: candidates.length });

        return {
          candidates,
          candidateIndex: 0,
          recoveryAttempted: false,
          missingConcepts: [],
          evidenceSet: [],
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
        span.update({ candidateRank: state.candidateIndex + 1, chunkIndex: candidate.chunk_index });

        const answer = await dependencies.generateAnswer(
          state.question,
          candidate.chunk
        );

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
        span.update({ candidateRank: state.candidateIndex + 1, chunkIndex: candidate.chunk_index });

        const verification = await dependencies.verifyAnswer(
          state.question,
          answer,
          candidate.chunk
        );

        span.update({ supported: verification.supported, missingConceptCount: verification.missingConcepts?.length ?? 0 });

        return {
          supported: verification.supported,
          reason: verification.reason,
          missingConcepts: verification.supported ? [] : verification.missingConcepts ?? []
        };
      }
    );
  }

  async function recoverNode(state: typeof WorkflowState.State) {
    return startActiveObservation("diagnostic-recovery", async span => {
      const original = state.candidates[state.candidateIndex];
      const query = `What is ${state.missingConcepts[0]}?`;
      const excluded = new Set(state.candidates.slice(0, state.candidateIndex + 1).map(c => c.chunk_index));
      span.update({ missingConceptCount: state.missingConcepts.length });
      // Retrieve a fresh ranking with ParancU, retaining original positional indices.
      // Filtering is by provenance only, never by lexical matching of corpus content.
      const ranked = state.corpus.chunks.length
        ? await dependencies.retrieveCandidates(query, state.corpus, state.corpus.chunks.length)
        : [];
      const currentEvidence: WorkflowEvidence[] = [
        { chunkIndex: original.chunk_index, text: original.chunk, candidateRank: state.candidateIndex + 1,
          score: original.score, retrievalQuery: state.question }
      ];
      let selected: WorkflowEvidence | undefined;
      for (const [index, c] of ranked.entries()) {
        if (excluded.has(c.chunk_index) || !Number.isInteger(c.chunk_index) || c.chunk_index < 0 ||
          c.chunk_index >= state.corpus.chunks.length || !c.chunk.trim() || !Number.isFinite(c.score)) continue;
        excluded.add(c.chunk_index);
        const candidate: WorkflowEvidence = { chunkIndex: c.chunk_index, text: c.chunk,
          candidateRank: index + 1, score: c.score, retrievalQuery: query };
        const decision = await startActiveObservation("complement-selection", async selectionSpan => {
          selectionSpan.update({ candidateRank: candidate.candidateRank, chunkIndex: candidate.chunkIndex, evidenceCount: currentEvidence.length });
          const verdict = await (dependencies.checkComplement ?? checkComplementSupport)(
            state.question, state.missingConcepts, currentEvidence, candidate);
          selectionSpan.update({ accepted: verdict.addsMissingSupport });
          return verdict;
        });
        if (decision.addsMissingSupport) { selected = candidate; break; }
      }
      if (!selected) {
        span.update({ recovered: false });
        return { recoveryAttempted: true, supported: false, evidenceSet: [] };
      }
      const evidenceSet = [...currentEvidence, selected];
      const context: EvidenceContext = { evidenceSet, missingConcepts: state.missingConcepts };
      const evidence = evidenceSet.map(item => `Chunk ${item.chunkIndex}:\n${item.text}`).join("\n\n");
      const answer = await dependencies.generateAnswer(state.question, evidence, context);
      if (!answer.trim()) throw new Error("Recovery generation returned an empty answer.");
      const verdict = await dependencies.verifyAnswer(state.question, answer, evidence, context);
      span.update({ recovered: verdict.supported, evidenceCount: evidenceSet.length });
      return { recoveryAttempted: true, evidenceSet, answer, supported: verdict.supported, reason: verdict.reason };
    });
  }

  async function advanceNode(
    state: typeof WorkflowState.State
  ) {
    return startActiveObservation(
      "advance",
      async (span) => {
        const nextCandidateIndex = state.candidateIndex + 1;

        span.update({ currentCandidateRank: state.candidateIndex + 1, nextCandidateRank: nextCandidateIndex + 1 });

        return {
          candidateIndex: nextCandidateIndex,
          answer: null,
          supported: null,
          reason: null,
          missingConcepts: [],
          evidenceSet: []
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

    if (!state.recoveryAttempted && state.missingConcepts.length) return "recover";

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
    .addNode("recover", recoverNode)
    .addNode("advance", advanceNode)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "generate")
    .addEdge("generate", "verify")
    .addConditionalEdges(
      "verify",
      routeAfterVerification,
      {
        advance: "advance",
        recover: "recover",
        end: END
      }
    )
    .addConditionalEdges("recover", state =>
      state.supported || state.candidateIndex + 1 >= state.candidates.length ? "end" : "advance",
    { advance: "advance", end: END })
    .addEdge("advance", "generate")
    .compile();
}

export const workflowGraph = createWorkflowGraph();
