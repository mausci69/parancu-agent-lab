const events = ["retrieval-query", "retrieval-candidates", "retrieval-score", "preparation-start", "prepared-chunk"] as const;
const fields = new Set(["keywordCount", "rareKeywordCount", "candidateCount", "chunkCount", "chunkIndex", "score", "cosineScore"]);

/** Operational console diagnostics never accept text, identifiers or nested payloads. */
export function logOperational(event: typeof events[number], values: Record<string, unknown>) {
  if (!events.includes(event)) return;
  const metadata: Record<string, number> = {};
  for (const [field, value] of Object.entries(values)) {
    if (fields.has(field) && typeof value === "number" && Number.isFinite(value)) metadata[field] = value;
  }
  console.log(`[ParancU ${event}]`, metadata);
}
