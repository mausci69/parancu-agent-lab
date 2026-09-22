import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";
import type { RetrieveResult } from "../../services/parancu-api/src/local/retrieval";

export type WorkflowState = {
  question: string;
  corpus: PrepareResult;
  candidates: RetrieveResult[];
  candidateIndex: number;
  answer: string | null;
  supported: boolean | null;
  reason: string | null;
};
