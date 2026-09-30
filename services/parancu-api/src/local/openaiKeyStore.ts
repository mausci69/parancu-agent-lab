import { AsyncLocalStorage } from "node:async_hooks";

// Request-local provider: credentials never enter workflow state or process.env.
const credentials = new AsyncLocalStorage<() => string | null>();

export function withOpenAIKey<T>(provider: () => string | null, work: () => T): T {
  return credentials.run(provider, work);
}

export async function loadOpenAIKey(): Promise<string | null> {
  const provider = credentials.getStore();
  const key = provider ? provider() : process.env.OPENAI_API_KEY?.trim();

  return key || null;
}

export { assertNoCredentials } from "./credentialContent.js";
