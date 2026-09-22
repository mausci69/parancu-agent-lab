import { loadOpenAIKey } from "../../services/parancu-api/src/local/openaiKeyStore";

const OPENAI_RESPONSES_URL =
  "https://api.openai.com/v1/responses";

const OPENAI_MODEL =
  process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

function extractTextFromResponse(payload: any): string {
  if (
    typeof payload?.output_text === "string" &&
    payload.output_text.trim()
  ) {
    return payload.output_text.trim();
  }

  const parts: string[] = [];

  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      if (!Array.isArray(item?.content)) {
        continue;
      }

      for (const content of item.content) {
        if (
          typeof content?.text === "string" &&
          content.text.trim()
        ) {
          parts.push(content.text.trim());
        }
      }
    }
  }

  return parts.join("\n").trim();
}

export async function generateResponse(
  question: string,
  evidence: string
): Promise<string> {
  const apiKey = await loadOpenAIKey();

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const system = [
    "You are a response agent.",
    "Answer the user's question using only the supplied evidence.",
    "Do not use outside knowledge.",
    "Do not add facts that are not present in the evidence.",
    "If the evidence is partial, answer only the supported part.",
    "Keep the answer concise and natural."
  ].join("\n");

  const user = [
    "Question:",
    question,
    "",
    "Evidence:",
    evidence
  ].join("\n");

  const response = await fetch(
    OPENAI_RESPONSES_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: system
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: user
              }
            ]
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Response generation failed: HTTP ${response.status} ${errorText}`
    );
  }

  const payload = await response.json();

  return extractTextFromResponse(payload);
}
