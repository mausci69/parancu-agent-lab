import type { PrepareResult } from "../../services/parancu-api/src/local/prepareCorpus";

import { coordinate } from "../coordinator/coordinator";
import { verifyEvidence } from "../verifier/evidenceVerifier";
import { generateResponse } from "../responder/responseAgent";
import type { OrchestrationTrace } from "../observability/orchestrationTrace";
import {
  retrieveCandidatesFromPrepared,
  type RetrieveResult
} from "../../services/parancu-api/src/local/retrieval";

type RetrieveCandidates = (
  question: string,
  corpus: PrepareResult,
  k: number
) => Promise<RetrieveResult[]>;

type GenerateAnswer = (
  question: string,
  evidence: string
) => Promise<string>;

type VerifyAnswer = (
  question: string,
  answer: string,
  evidence: string
) => Promise<{
  supported: boolean;
  reason: string;
}>;

export type OrchestratorDependencies = {
  retrieveCandidates: RetrieveCandidates;
  generateAnswer: GenerateAnswer;
  verifyAnswer: VerifyAnswer;
  trace?: OrchestrationTrace;
};

const defaultDependencies: OrchestratorDependencies = {
  retrieveCandidates: retrieveCandidatesFromPrepared,
  generateAnswer: generateResponse,
  verifyAnswer: verifyEvidence
};

export type OrchestratorResult =
  | {
      action: "respond";
      message: string;
    }
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

export async function runOrchestrator(
  userMessage: string,
  corpus: PrepareResult,
  dependencies: OrchestratorDependencies = defaultDependencies
): Promise<OrchestratorResult> {
  const decision = coordinate(userMessage);

  if (decision.action === "respond") {
    return {
      action: "respond",
      message: decision.message
    };
  }

  const candidates =
    await dependencies.retrieveCandidates(
      decision.query,
      corpus,
      5
    );

  dependencies.trace?.events.push({
    type: "retrieval_completed",
    candidateCount: candidates.length
  });

  for (
    let candidateIndex = 0;
    candidateIndex < candidates.length;
    candidateIndex += 1
  ) {
    const candidate = candidates[candidateIndex];
    const candidateRank = candidateIndex + 1;

    dependencies.trace?.events.push({
      type: "candidate_started",
      candidateRank,
      chunkIndex: candidate.chunk_index,
      score: candidate.score
    });

    const answer =
      await dependencies.generateAnswer(
        userMessage,
        candidate.chunk
      );

    dependencies.trace?.events.push({
      type: "answer_generated",
      candidateRank,
      answer
    });

    const verification =
      await dependencies.verifyAnswer(
        userMessage,
        answer,
        candidate.chunk
      );

    dependencies.trace?.events.push({
      type: "verification_completed",
      candidateRank,
      supported: verification.supported,
      reason: verification.reason
    });

    if (verification.supported) {
      dependencies.trace?.events.push({
        type: "candidate_accepted",
        candidateRank
      });

      return {
        action: "answer",
        question: userMessage,
        answer,
        chunk: candidate.chunk,
        summary: candidate.summary,
        chunkIndex: candidate.chunk_index,
        candidateRank,
        score: candidate.score,
        reason: verification.reason
      };
    }
  }

  dependencies.trace?.events.push({
    type: "no_evidence"
  });

  return {
    action: "no_evidence",
    question: userMessage
  };
}
