import { assertNoCredentials, loadOpenAIKey } from "./openaiKeyStore.js";
import { readWebOpenAITimeout } from "../../../../src/web/runtimeConfig.js";

export async function checkOpenAIContent(value: unknown): Promise<void> {
  try { assertNoCredentials(JSON.stringify(value), [await loadOpenAIKey(), process.env.OPENAI_API_KEY?.trim()]); }
  catch { throw new Error("OpenAI returned unsafe content."); }
}

/** Keep transport failures and upstream bodies out of exceptions and tracing. */
export async function requestOpenAI(body: unknown): Promise<any> {
  const key = await loadOpenAIKey();
  if (!key) throw new Error("Missing OpenAI API key.");
  const controller = new AbortController();
  // Split long configured deadlines to avoid Node's timer overflow clamping.
  let remaining = readWebOpenAITimeout();
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const delay = Math.min(remaining, 2_147_483_647);
    timer = setTimeout(() => {
      remaining -= delay;
      if (remaining > 0) schedule();
      else controller.abort();
    }, delay);
  };
  schedule();
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error("Upstream request failed.");
    const payload: unknown = await response.json();
    assertNoCredentials(JSON.stringify(payload), [key, process.env.OPENAI_API_KEY?.trim()]);
    return payload;
  } catch {
    // Do not attach a cause: fetch errors and upstream payloads can contain keys.
    throw new Error("OpenAI request failed. Check your key, account access, and connection.");
  } finally {
    clearTimeout(timer!);
  }
}
