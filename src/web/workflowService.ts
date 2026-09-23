import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import { retrieveCandidatesFromPrepared, type RetrieveResult } from "../../services/parancu-api/src/local/retrieval";
import type { WorkflowDependencies } from "../workflow/graph";
import { runWorkflow, type WorkflowResult } from "../workflow/runWorkflow";
import { generateResponse } from "../responder/responseAgent";
import { verifyEvidence } from "../verifier/evidenceVerifier";

export type RetrievedEvidence = {
  chunkIndex: number;
  text: string;
  summary: string;
  candidateRank: number;
  score: number;
  status: "accepted" | "rejected" | "not_evaluated";
  reason?: string;
};
export type WebWorkflowResult = { result: WorkflowResult; retrievedEvidence: RetrievedEvidence[] };

const defaults: WorkflowDependencies = {
  retrieveCandidates: retrieveCandidatesFromPrepared,
  generateAnswer: generateResponse,
  verifyAnswer: verifyEvidence
};

export function createWorkflowService(dependencies: WorkflowDependencies = defaults) {
  return async (question: string, corpus: PrepareResult): Promise<WebWorkflowResult> => {
    // Everything below is request-local, including attempt order for identical chunk texts.
    let candidates: RetrieveResult[] = [];
    let currentIndex = -1;
    const verdicts = new Map<number, { supported: boolean; reason: string }>();
    const result = await runWorkflow(question, corpus, {
      retrieveCandidates: async (...args) => {
        candidates = await dependencies.retrieveCandidates(...args);
        return candidates;
      },
      generateAnswer: async (...args) => {
        currentIndex += 1;
        return dependencies.generateAnswer(...args);
      },
      verifyAnswer: async (...args) => {
        const verdict = await dependencies.verifyAnswer(...args);
        verdicts.set(currentIndex, verdict);
        return verdict;
      }
    });
    return {
      result,
      retrievedEvidence: candidates.map((candidate, index) => {
        const verdict = verdicts.get(index);
        return {
          chunkIndex: candidate.chunk_index, text: candidate.chunk, summary: candidate.summary,
          candidateRank: index + 1, score: candidate.score,
          status: result.action === "answer" && result.evidence.candidateRank === index + 1
            ? "accepted" : verdict ? "rejected" : "not_evaluated",
          ...(verdict ? { reason: verdict.reason } : {})
        };
      })
    };
  };
}
