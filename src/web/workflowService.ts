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
  retrievalQuery?: string;
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
    let retrievals = 0;
    const recoveryCandidates: RetrievedEvidence[] = [];
    const verdicts = new Map<number, { supported: boolean; reason: string }>();
    const result = await runWorkflow(question, corpus, {
      checkComplement: dependencies.checkComplement,
      retrieveCandidates: async (...args) => {
        const ranked = await dependencies.retrieveCandidates(...args);
        if (retrievals++ === 0) candidates = ranked;
        else recoveryCandidates.push(...ranked.map((c, index) => ({
          chunkIndex: c.chunk_index, text: c.chunk, summary: c.summary, candidateRank: index + 1,
          score: c.score, retrievalQuery: args[0], status: "not_evaluated" as const
        })));
        return ranked;
      },
      generateAnswer: async (...args) => {
        if (!args[2]) currentIndex += 1;
        return dependencies.generateAnswer(...args);
      },
      verifyAnswer: async (...args) => {
        const verdict = await dependencies.verifyAnswer(...args);
        if (args[3]) {
          const selected = args[3].evidenceSet[1];
          const row = recoveryCandidates.find(c => c.chunkIndex === selected.chunkIndex);
          if (row) { row.status = "rejected"; row.reason = verdict.reason; }
        } else verdicts.set(currentIndex, verdict);
        return verdict;
      }
    });
    return {
      result,
      retrievedEvidence: [...candidates.map((candidate, index): RetrievedEvidence => {
        const verdict = verdicts.get(index);
        return {
          chunkIndex: candidate.chunk_index, text: candidate.chunk, summary: candidate.summary,
          candidateRank: index + 1, score: candidate.score,
          status: result.action === "answer" && !result.evidenceSet && result.evidence.candidateRank === index + 1
            ? "accepted" : verdict ? "rejected" : "not_evaluated",
          ...(verdict ? { reason: verdict.reason } : {})
        };
      }), ...recoveryCandidates.filter(c => c.status !== "not_evaluated")].map(row => {
        const accepted = result.action === "answer" && result.evidenceSet?.find(e =>
          e.chunkIndex === row.chunkIndex && (e.retrievalQuery === row.retrievalQuery || (!row.retrievalQuery && e.retrievalQuery === question)));
        return accepted ? { ...row, status: "accepted" as const, reason: result.action === "answer" ? result.reason : row.reason } : row;
      })
    };
  };
}
