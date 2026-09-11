// apps/mobile/src/lib/llm/localBridge.ts
// Local LLM bridge: try real HTTP endpoint first, fallback to simulator.
//
// Expected server (replace host/port if needed):
//   POST http://127.0.0.1:8080/generate
//   body: { task: "summary"|"questions", input: string }
//   returns: { output: string | string[] }

type Task = "summary" | "questions";

async function postWithTimeout(url: string, payload: any, ms = 5000): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

export async function localLLMGenerate(task: Task, input: string): Promise<string | string[]> {
  // 1) Try real local server
  try {
    const data = await postWithTimeout("http://127.0.0.1:8080/generate", { task, input });
    if (data && typeof data.output !== "undefined") {
      return data.output;
    }
    throw new Error("Invalid response shape");
  } catch (err) {
    // 2) Fallback to simulator
    console.log(`[localBridge] Fallback simulator for ${task}:`, err instanceof Error ? err.message : String(err));
    if (task === "summary") {
      return "Simulated summary: " + input.slice(0, 60) + "...";
    }
    return ["Simulated question 1?", "Simulated question 2?", "Simulated question 3?"];
  }
}
