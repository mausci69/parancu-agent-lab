import { loadOpenAIKey } from "../../services/parancu-api/src/local/openaiKeyStore";

const OPENAI_RESPONSES_URL =
  "https://api.openai.com/v1/responses";

const OPENAI_MODEL =
  process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

export type EvidenceVerification = {
  supported: boolean;
  reason: string;
};

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

export async function verifyEvidence(
  question: string,
  answer: string,
  evidence: string
): Promise<EvidenceVerification> {
  const apiKey = await loadOpenAIKey();

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const system = [
    "You are an answer verifier.",
    "Check whether the proposed answer actually answers the user's question using information contained in the supplied evidence.",
    "An answer saying that the information is missing, unknown, unspecified, unavailable, or not present is NOT a supported answer.",
    "If the evidence does not contain the requested answer, return supported=false so another candidate can be evaluated.",
    "Check whether the proposed answer actually addresses the user's question.",
    "Use only the supplied evidence.",
    "Do not use outside knowledge.",
    "Semantic similarity is not enough.",
    "Every factual claim in the answer must be supported by the evidence.",
    "Do not accept an answer that mixes entities, events, dates, locations, causes, or relationships.",
    "If only part of the answer is supported, return supported=false.",
    "Return strict JSON only."
  ].join("\n");

  const user = [
    "Question:",
    question,
    "",
    "Proposed answer:",
    answer,
    "",
    "Evidence:",
    evidence,
    "",
    'Return exactly: {"supported": true|false, "reason": "..."}'
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
      `Answer verification failed: HTTP ${response.status} ${errorText}`
    );
  }

  const payload = await response.json();
  const text = extractTextFromResponse(payload);

  try {
    const parsed = JSON.parse(text);

    return {
      supported: parsed.supported === true,
      reason: String(parsed.reason || "")
    };
  } catch {
    throw new Error(
      `Answer verifier returned invalid JSON: ${text}`
    );
  }
}