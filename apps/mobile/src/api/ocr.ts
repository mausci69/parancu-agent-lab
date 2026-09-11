import { postJson, postForm } from "./client";

export type OCRExtractResponse = {
  text: string;
  length: number;
  truncated?: boolean;
  note?: string;
};

export type PrepareCorpusResponse = {
  ready: boolean;
  status?: string;
  message?: string;
  chunks?: number;
  index_size?: number;
};

/**
 * Wrapper for /ocr_extract supporting optional PDF assembly.
 * If returnPdf=true, resolves to a Blob (PDF). Otherwise resolves to JSON.
 */
export async function ocrExtract(
  form: FormData,
  returnPdf = false,
  lang?: string
): Promise<Blob | any> {
  const qs = new URLSearchParams({
    return_pdf: returnPdf ? "true" : "false",
  });
  if (lang) qs.set("lang", lang);

  const path = `/ocr_extract?${qs.toString()}`;
  const opts = returnPdf ? { expect: "blob" as const } : undefined;

  return await postForm<any>(path, form, 30000, opts as any);
}

/**
 * Prepare corpus from raw text using the updated backend contract.
 *
 * - Sends { text } to POST /prepare_corpus
 * - Exposes:
 *    ready: boolean
 *    status, message: optional descriptive fields
 *    chunks, index_size: optional numeric metadata
 */
export async function prepareCorpusFromText(
  text: string,
  timeoutMs = 300000
): Promise<PrepareCorpusResponse> {
  const bodyText = (text || "").trim();

  if (!bodyText) {
    return {
      ready: false,
      status: "error",
      message: "Empty text. Provide non-empty text to prepare corpus.",
      chunks: 0,
      index_size: 0,
    };
  }

  const raw = await postJson<any>(
    "/prepare_corpus",
    { text: bodyText },
    timeoutMs
  );

  return {
    ready: !!raw?.ready,
    status: raw?.status,
    message: raw?.message,
    chunks:
      typeof raw?.chunks === "number"
        ? raw.chunks
        : undefined,
    index_size:
      typeof raw?.index_size === "number"
        ? raw.index_size
        : undefined,
  };
}
