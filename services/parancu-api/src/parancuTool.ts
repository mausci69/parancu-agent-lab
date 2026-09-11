// services/parancu-api/src/parancuTool.ts

import {
  ParancuClient,
  type ParancuQueryResponse,
} from "./parancuClient.js";

export type ParancuEvidence = {
  question: string;
  chunk: string;
  summary: string;
  score: number;
  low_confidence: boolean;
};

const client =
  new ParancuClient();

export async function prepareParancu(
  text: string,
  language: "en" | "it" = "en",
  environmentId = "default"
): Promise<void> {
  await client.prepare(
    text,
    language,
    environmentId
  );
}

export async function askParancu(
  question: string,
  environmentId = "default"
): Promise<ParancuEvidence> {
  const result: ParancuQueryResponse =
    await client.query(
      question,
      environmentId
    );

  return {
    question:
      result.question,

    chunk:
      result.chunk,

    summary:
      result.summary,

    score:
      result.score,

    low_confidence:
      result.low_confidence,
  };
}