import { assertNoCredentials, loadOpenAIKey } from "./openaiKeyStore.js";

export async function checkOpenAIContent(value: unknown): Promise<void> {
  try { assertNoCredentials(JSON.stringify(value), [await loadOpenAIKey(), process.env.OPENAI_API_KEY?.trim()]); }
  catch { throw new Error("OpenAI returned unsafe content."); }
}

/** Keep transport failures and upstream bodies out of exceptions and tracing. */
export async function requestOpenAI(body: unknown): Promise<any> {
  const key = await loadOpenAIKey();
  if (!key) throw new Error("Missing OpenAI API key.");
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error("Upstream request failed.");
    const payload: unknown = await response.json();
    assertNoCredentials(JSON.stringify(payload), [key, process.env.OPENAI_API_KEY?.trim()]);
    return payload;
  } catch {
    // Do not attach a cause: fetch errors and upstream payloads can contain keys.
    throw new Error("OpenAI request failed. Check your key, account access, and connection.");
  }
}
