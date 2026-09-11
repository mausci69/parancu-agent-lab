// Lightweight bridge to a local LLM runtime (e.g. llama.cpp OpenAI-compatible server).
// - Times out via AbortController.
// - Parses OpenAI-style chat completions and a minimal "content" fallback.
// - Surfaces clear error codes for UI to react (timeout/unreachable/bad_shape).
// British English in comments.

import { LOCAL_LLM_URL, LOCAL_LLM_TIMEOUT_MS, DEBUG_FORCE_SIM } from "../../constants/env";

export type LocalHealth = { ok: boolean; status: "ready" | "loading" | "error"; detail?: string };

export type LocalGenOpts = {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string; // optional, if your local server exposes multiple models
};

export type LocalGenResult = {
  text: string;
  durationMs: number;
};

export class LocalLLMError extends Error {
  code: "TIMEOUT" | "UNREACHABLE" | "BAD_SHAPE" | "FORCED_SIM";
  constructor(code: LocalLLMError["code"], message: string) {
    super(message);
    this.name = "LocalLLMError";
    this.code = code;
  }
}

/** Simple health check. Prefer a cheap GET. */
export async function health(): Promise<LocalHealth> {
  if (DEBUG_FORCE_SIM) {
    return { ok: false, status: "error", detail: "Forced simulator via DEBUG flag" };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.min(10_000, LOCAL_LLM_TIMEOUT_MS)); // health should be fast
  try {
    const r = await fetch(`${LOCAL_LLM_URL}/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) {
      return { ok: false, status: "error", detail: `HTTP ${r.status}` };
    }
    // Accept any small JSON with {status:"ready"} or similar; fallback to text
    let status: LocalHealth["status"] = "ready";
    try {
      const j = await r.json();
      const s = (j.status || j.state || "").toString().toLowerCase();
      status = s.includes("ready") ? "ready" : s.includes("load") ? "loading" : "ready";
    } catch {
      const txt = await r.text();
      status = txt.toLowerCase().includes("ready") ? "ready" : "ready";
    }
    return { ok: status === "ready", status };
  } catch (e: any) {
    clearTimeout(t);
    if (e?.name === "AbortError") {
      return { ok: false, status: "error", detail: "timeout" };
    }
    return { ok: false, status: "error", detail: "unreachable" };
  }
}

/**
 * Generate text locally. Targets OpenAI-compatible /v1/chat/completions first.
 * If shape is unexpected, throws LocalLLMError("BAD_SHAPE") so caller can fall back to simulator.
 */
export async function generateLocal(prompt: string, opts: LocalGenOpts = {}): Promise<LocalGenResult> {
  if (DEBUG_FORCE_SIM) {
    throw new LocalLLMError("FORCED_SIM", "Forced simulator via DEBUG flag");
  }
  const started = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), LOCAL_LLM_TIMEOUT_MS);

  const body = {
    model: opts.model ?? "local",
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 256,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: prompt },
    ],
  };

  try {
    const res = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      // Some llama.cpp builds return 404 if OpenAI route not enabled.
      // Treat as unreachable for now; UI may fall back to simulator.
      throw new LocalLLMError("UNREACHABLE", `HTTP ${res.status}`);
    }
    const j = await res.json();

    // Try to parse OpenAI-style
    const text =
      j?.choices?.[0]?.message?.content ??
      j?.choices?.[0]?.text ?? // some servers use 'text'
      j?.content ?? // ultra-minimal servers
      null;

    if (typeof text !== "string" || !text.length) {
      throw new LocalLLMError("BAD_SHAPE", "Response missing content");
    }

    return { text, durationMs: Date.now() - started };
  } catch (e: any) {
    clearTimeout(t);
    if (e instanceof LocalLLMError) throw e;
    if (e?.name === "AbortError") {
      throw new LocalLLMError("TIMEOUT", `Timed out after ${LOCAL_LLM_TIMEOUT_MS} ms`);
    }
    throw new LocalLLMError("UNREACHABLE", e?.message || "Network error");
  }
}

