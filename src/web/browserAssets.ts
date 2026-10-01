import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import { build, type BuildOptions } from "esbuild";

const root = path.resolve(__dirname, "../..");
const prefix = "/parancu-browser/";
const files = new Map<string, [string, string]>();
for (const name of ["model_int8.onnx", "tokenizer.json", "tokenizer_config.json"]) {
  files.set(`${prefix}e5/${name}`, [path.join(root, "services/parancu-api/assets/models/e5", name),
    name.endsWith("json") ? "application/json" : "application/octet-stream"]);
}
files.set(`${prefix}tokenizers.mjs`, [path.join(root,
  "services/parancu-api/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs"), "text/javascript"]);
for (const name of ["ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  files.set(`${prefix}ort/${name}`, [path.join(root, "node_modules/onnxruntime-web/dist", name),
    name.endsWith("wasm") ? "application/wasm" : "text/javascript"]);
}

export function browserBuildOptions(): BuildOptions {
  return {
    entryPoints: [path.join(__dirname, "browser/client.ts")], bundle: true,
    write: false, format: "iife", globalName: "ParancUBrowser", platform: "browser", target: "es2022",
    logLevel: "silent",
    plugins: [{ name: "browser-e5", setup(builder) {
      builder.onResolve({ filter: /^\.\.\/lib\/embeddings\.js$/ }, args => {
        if (path.resolve(args.importer) !== path.join(root, "services/parancu-api/src/local/retrieval.ts")) return;
        return { path: path.join(__dirname, "browser/e5.ts") };
      });
    } }]
  };
}
let bundle: Promise<Uint8Array> | undefined;
export function browserBundle(): Promise<Uint8Array> {
  return bundle ??= build(browserBuildOptions()).then(result => result.outputFiles![0].contents);
}

/** Called only after Host/origin checks. Public assets never resolve a session. */
export async function serveBrowserAsset(url: string, response: ServerResponse): Promise<boolean> {
  if (url === `${prefix}client.js`) {
    const content = await browserBundle();
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    response.end(content);
    return true;
  }
  const file = files.get(url);
  if (!file) return false;
  await stat(file[0]);
  // Omit Content-Length so HTTP/1 uses chunked transfer for large streamed assets.
  response.writeHead(200, { "Content-Type": file[1] });
  // Stream the 113 MiB model rather than allocating a server-side copy per request.
  try { await pipeline(createReadStream(file[0]), response); }
  catch { response.destroy(); }
  return true;
}
