// Local generation wired through the temporary bridge simulator.
// Later, replace the bridge with a real llama.cpp / mistral.cpp backend.
import { localLLMGenerate } from "./localBridge";

export async function generateSummaryLocal(input: string): Promise<string | null> {
  console.log("[localGen] generateSummaryLocal called · len=", input?.length ?? 0);
  try {
    const out = await localLLMGenerate("summary", input);
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

export async function generateQuestionsLocal(input: string): Promise<string[] | null> {
  try {
    const out = await localLLMGenerate("questions", input);
    return Array.isArray(out) ? out : null;
  } catch {
    return null;
  }
}

/** No-op initialiser used by App.tsx in dev; avoids crash until real local LLM is wired. */
export async function initLocalGen(_config: Record<string, any> = {}): Promise<void> {
  // eslint-disable-next-line no-console
  console.warn("[Stub] initLocalGen called");
}