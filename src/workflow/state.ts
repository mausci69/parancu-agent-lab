import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import type { RetrieveResult } from "../../services/parancu-api/src/local/retrieval";

export type WorkflowEvidence = {
  chunkIndex: number;
  text: string;
  candidateRank: number;
  score: number;
  retrievalQuery?: string;
};

export type EvidenceContext = {
  evidenceSet: WorkflowEvidence[];
  missingConcepts: string[];
};

export type WorkflowState = {
  question: string;
  corpus: PrepareResult;
  candidates: RetrieveResult[];
  candidateIndex: number;
  answer: string | null;
  supported: boolean | null;
  reason: string | null;
  missingConcepts: string[];
  recoveryAttempted: boolean;
  evidenceSet: WorkflowEvidence[];
};
