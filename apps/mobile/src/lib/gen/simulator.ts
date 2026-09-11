// Very small "pretend brain" used as a fallback during development/testing.
// Deterministic, fast, and side-effect free. British English in comments.

export type SimResult = { text: string; durationMs: number };

export async function simulateGenerate(prompt: string): Promise<SimResult> {
  const started = Date.now();
  // Produce a short, friendly stub that echoes intent without hallucinating facts.
  const trimmed = (prompt || "").trim().slice(0, 400);
  const text =
    trimmed.length > 0
      ? `Simulated answer:\n\n${summarise(trimmed)}\n\n— (simulator)`
      : "Simulated answer: (no input provided)\n\n— (simulator)";
  // Tiny delay so UI spinners/toasts can be exercised.
  await sleep(60);
  return { text, durationMs: Date.now() - started };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Naive single-paragraph "summary": first sentence up to ~220 chars.
function summarise(s: string): string {
  const max = 220;
  const dot = s.indexOf(".");
  const cut = dot > 20 && dot < max ? dot + 1 : Math.min(max, s.length);
  const out = s.slice(0, cut).replace(/\s+/g, " ").trim();
  return out.length < s.length ? `${out} …` : out;
}

