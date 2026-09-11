// services/parancu-api/src/local/openaiKeyStore.ts

export async function loadOpenAIKey(): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY?.trim();

  return key || null;
}
