export type OrchestrationTraceEvent =
  | {
      type: "retrieval_completed";
      candidateCount: number;
    }
  | {
      type: "candidate_started";
      candidateRank: number;
      chunkIndex: number;
      score: number;
    }
  | {
      type: "answer_generated";
      candidateRank: number;
      answer: string;
    }
  | {
      type: "verification_completed";
      candidateRank: number;
      supported: boolean;
      reason: string;
    }
  | {
      type: "candidate_accepted";
      candidateRank: number;
    }
  | {
      type: "no_evidence";
    };

export type OrchestrationTrace = {
  events: OrchestrationTraceEvent[];
};
