import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

const requiredFiles = [
  "model_int8.onnx", "sentencepiece.bpe.model", "special_tokens_map.json",
  "tokenizer_config.json", "tokenizer.json", "tokenizer.onnx"
];

async function verifyE5Bundle(): Promise<void> {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(new URL("../assets/e5-manifest.json", import.meta.url), "utf8"));
    if (manifest?.model !== "intfloat/multilingual-e5-small" || manifest.dimensions !== 384 ||
        !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files) ||
        Object.keys(manifest.files).length !== requiredFiles.length ||
        requiredFiles.some(name => !Object.hasOwn(manifest.files, name) ||
          typeof manifest.files[name] !== "string" || !/^[a-f0-9]{64}$/.test(manifest.files[name]))) {
      throw new Error();
    }
  } catch { throw new Error("E5 bundle manifest is invalid or unavailable."); }

  for (const name of requiredFiles) {
    const hash = createHash("sha256");
    try {
      for await (const chunk of createReadStream(new URL(`../assets/models/e5/${name}`, import.meta.url))) {
        hash.update(chunk);
      }
    } catch { throw new Error("E5 bundle file is missing or unreadable."); }
    if (hash.digest("hex") !== manifest.files[name]) throw new Error("E5 bundle checksum mismatch.");
  }
  console.log("E5 bundle verified (6 files, 384 dimensions).");
}

void verifyE5Bundle().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
