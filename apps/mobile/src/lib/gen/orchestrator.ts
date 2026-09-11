// Orchestrates generation across Server / Local / Simulator.
// Policy: respect user's chosen engine; if "auto", try Local then fall back to Simulator.
// Server path is a placeholder to be wired to your existing API client.
// British English in comments.

import { getGenEngine } from "../../constants/storage";
import type { GenEngine } from "../../constants/genEngine";
import { DEBUG_FORCE_SIM } from "../../constants/env";
import { health as localHealth, generateLocal, LocalLLMError } from "./localBridge";
import { simulateGenerate } from "./simulator";

export type OrchestratorResult = {
  text: string;
  durationMs: number;
  engineUsed: GenEngine;
  outcome: "success" | "fallback_sim" | "server_unimplemented";
  meta?: { errorCode?: string; detail?: string };
};

export async function generateText(prompt: string): Promise<OrchestratorResult> {
  const pref: GenEngine = await getGenEngine().catch(() => "server" as GenEngine);

  // Debug override for UI testing.
  if (DEBUG_FORCE_SIM) {
    const sim = await simulateGenerate(prompt);
    return { ...sim, engineUsed: "sim", outcome: "fallback_sim" };
  }

  // Helper to run simulator and tag fallback
  const runSim = async (detail?: string): Promise<OrchestratorResult> => {
    const sim = await simulateGenerate(prompt);
    return {
      ...sim,
      engineUsed: "sim",
      outcome: "fallback_sim",
      meta: detail ? { detail } : undefined,
    };
  };

  // Explicit simulator
  if (pref === "sim") {
    return runSim("User selected simulator");
  }

  // Explicit local
  if (pref === "local") {
    try {
      const h = await localHealth();
      if (!h.ok) return runSim(`Local not ready: ${h.status}${h.detail ? ` (${h.detail})` : ""}`);
      const out = await generateLocal(prompt);
      return { ...out, engineUsed: "local", outcome: "success" };
    } catch (e: any) {
      const code = e instanceof LocalLLMError ? e.code : "UNKNOWN";
      return runSim(`Local error: ${code}`);
    }
  }

  // Auto: try local, then simulator
  if (pref === "auto") {
    try {
      const h = await localHealth();
      if (h.ok) {
        const out = await generateLocal(prompt);
        return { ...out, engineUsed: "local", outcome: "success" };
      }
      // Not ready → simulator
      return runSim(`Auto: local ${h.status}`);
    } catch (e: any) {
      const code = e instanceof LocalLLMError ? e.code : "UNKNOWN";
      return runSim(`Auto: local error ${code}`);
    }
  }

  // Server: placeholder – wire to your existing backend call when ready.
  if (pref === "server") {
    return {
      text: "Server generation not yet wired in this orchestrator. Please integrate your API client.",
      durationMs: 0,
      engineUsed: "server",
      outcome: "server_unimplemented",
      meta: { detail: "stub" },
    };
  }

  // Safety net
  return runSim("Unexpected engine preference");
}

