// /New_EcoSearch/EcoSearch_v1_mobile_llm/apps/mobile/src/lib/ocrLocal.ts

import TextRecognition from "@react-native-ml-kit/text-recognition";

/** Result per page when running on-device OCR. */
export type LocalOcrPageResult =
  | {
      ok: true;
      text: string;
    }
  | {
      ok: false;
      text: "";
      error: string;
    };

export type LocalOcrBatchResult = {
  text: string; // concatenated text (pages joined with \n\n)
  pages: LocalOcrPageResult[]; // per-page outcomes
};

function extractTextFromMlKitResult(res: any): string {
  if (!res) return "";

  if (typeof res === "string") {
    return res.trim();
  }

  if (typeof res.text === "string" && res.text.trim()) {
    return res.text.trim();
  }

  if (Array.isArray(res.blocks)) {
    const fromBlocks = res.blocks
      .map((block: any) => {
        if (!block) return "";

        if (typeof block.text === "string") {
          return block.text;
        }

        if (Array.isArray(block.lines)) {
          return block.lines
            .map((line: any) => {
              if (!line) return "";

              if (typeof line.text === "string") {
                return line.text;
              }

              if (Array.isArray(line.elements)) {
                return line.elements
                  .map((el: any) =>
                    typeof el?.text === "string" ? el.text : ""
                  )
                  .filter(Boolean)
                  .join(" ");
              }

              return "";
            })
            .filter(Boolean)
            .join("\n");
        }

        return "";
      })
      .filter(Boolean)
      .join("\n\n");

    if (fromBlocks.trim()) {
      return fromBlocks.trim();
    }
  }

  if (Array.isArray(res.lines)) {
    const fromLines = res.lines
      .map((line: any) => {
        if (!line) return "";

        if (typeof line.text === "string") {
          return line.text;
        }

        if (Array.isArray(line.elements)) {
          return line.elements
            .map((el: any) =>
              typeof el?.text === "string" ? el.text : ""
            )
            .filter(Boolean)
            .join(" ");
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");

    if (fromLines.trim()) {
      return fromLines.trim();
    }
  }

  if (Array.isArray(res.elements)) {
    const fromElements = res.elements
      .map((el: any) => (typeof el?.text === "string" ? el.text : ""))
      .filter(Boolean)
      .join(" ");

    if (fromElements.trim()) {
      return fromElements.trim();
    }
  }

  return "";
}

/**
 * Run ML Kit OCR over multiple image URIs (offline).
 * @param uris Array of file:// or content:// image URIs
 * @param lang Optional UI language hint ("en" | "it"); ML Kit is language-agnostic here
 */
export async function mlkitExtractPages(
  uris: string[],
  lang?: "en" | "it"
): Promise<LocalOcrBatchResult> {
  const pages: LocalOcrPageResult[] = [];

  for (const uri of uris) {
    try {
      const res = await TextRecognition.recognize(uri);

      console.log("[OCR LOCAL] raw result for uri:", uri);
      console.log("[OCR LOCAL] raw result payload:", JSON.stringify(res, null, 2));

      const pageText = extractTextFromMlKitResult(res);

      console.log("[OCR LOCAL] extracted text length:", pageText.length);
      console.log(
        "[OCR LOCAL] extracted text preview:",
        pageText.slice(0, 300)
      );

      pages.push({
        ok: true,
        text: pageText,
      });
    } catch (e: any) {
      console.log("[OCR LOCAL] recognition error:", e?.message ?? String(e));

      pages.push({
        ok: false,
        text: "",
        error: e?.message ?? "OCR failed",
      });
    }
  }

  const text = pages
    .map((p) => (p.ok ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");

  return { text, pages };
}