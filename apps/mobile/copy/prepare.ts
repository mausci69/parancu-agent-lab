// Centralised copy for text→prepare flow (keeps Upload & Scan screens consistent)

export const PREPARE = {
  tooShortTitle: "Too short",
  tooShortBody: "Please extract text first, then try again.",

  // Status messages
  prepared: (status?: string, chunks?: number | string) =>
    status ? `Prepared: ${status} (chunks: ${chunks ?? "?"})` : "Prepared",

  failedPrefix: (http?: number | string) =>
    `Prepare failed${http ? ` (HTTP ${http})` : ""}:`,

  // Hints for common errors
  hints: {
    "400": "Hint: request invalid. Ensure the extracted text is readable (≥ ~20 chars).",
    "413": "Hint: text is too large. Try fewer pages or trim the content.",
    "415": "Hint: unsupported content type. Please submit plain text.",
  },
};

