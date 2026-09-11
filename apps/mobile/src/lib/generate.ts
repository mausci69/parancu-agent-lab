// High-level generate helper that routes via the orchestrator.
// Keeps UI code simple and centralises return shape.

import { generateText, type OrchestratorResult } from "./gen";

export async function generateAnswer(prompt: string): Promise<OrchestratorResult> {
  const trimmed = (prompt || "").trim();
  if (!trimmed) {
    return {
      text: "",
      durationMs: 0,
      engineUsed: "sim",
      outcome: "fallback_sim",
      meta: { detail: "empty_prompt" },
    };
  }
  return await generateText(trimmed);
}

