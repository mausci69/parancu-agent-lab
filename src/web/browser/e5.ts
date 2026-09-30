// Promoted from experiments/browser-e5/browser-embed.js (same tokenizer/tensors/output).
import type * as Ort from "onnxruntime-web";

const base = "/parancu-browser";
const importAsset = (name: string): Promise<any> => import(`${base}/${name}`);
type Runtime = { tokenizer: { encode(text: string): { ids: number[] } }; session: Ort.InferenceSession; ort: typeof Ort };
let loading: Promise<Runtime> | undefined;
let running = false;

async function initialize(): Promise<Runtime> {
  const [{ Tokenizer }, ort] = await Promise.all([
    importAsset("tokenizers.mjs"), importAsset("ort/ort.wasm.min.mjs")
  ]);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = new URL(`${base}/ort/`, location.href).href;
  const read = async (name: string) => {
    const response = await fetch(`${base}/e5/${name}`, { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error("Model asset unavailable.");
    return response.json();
  };
  const [definition, config] = await Promise.all([read("tokenizer.json"), read("tokenizer_config.json")]);
  const tokenizer = new Tokenizer(definition, config);
  const session = await ort.InferenceSession.create(`${base}/e5/model_int8.onnx`, { executionProviders: ["wasm"] });
  return { tokenizer, session, ort };
}

export async function embedOne(text: string): Promise<number[]> {
  if (running) throw new Error("Browser retrieval is already running.");
  running = true;
  try {
    const { tokenizer, session, ort } = await (loading ??= initialize());
    let tokens = tokenizer.encode(`query: ${text.trim()}`).ids;
    if (!tokens.length || tokens[0] !== 0 || tokens.at(-1) !== 2) throw new Error("Unexpected BOS/EOS");
    if (tokens.length > 512) { tokens = tokens.slice(0, 512); tokens[511] = 2; }
    const length = Math.max(1, tokens.length);
    const ids = new BigInt64Array(length).fill(1n);
    const mask = new BigInt64Array(length);
    tokens.forEach((id, i) => { ids[i] = BigInt(id); mask[i] = 1n; });
    const inputs = {
      input_ids: new ort.Tensor("int64", ids, [1, length]),
      attention_mask: new ort.Tensor("int64", mask, [1, length])
    };
    let outputs: Ort.InferenceSession.ReturnType | undefined;
    try {
      outputs = await session.run(inputs);
      const tensor = outputs.sentence_embedding;
      if (!tensor || tensor.dims.length !== 2 || tensor.dims[0] !== 1 || tensor.dims[1] !== 384) throw new Error("Invalid E5 shape");
      const vector = Array.from(tensor.data as Float32Array, Number);
      if (vector.length !== 384 || !vector.every(Number.isFinite)) throw new Error("Invalid E5 values");
      return vector;
    } finally {
      Object.values(inputs).forEach(tensor => tensor.dispose());
      if (outputs) Object.values(outputs).forEach(tensor => tensor.dispose());
    }
  } catch {
    throw new Error("Browser E5 retrieval failed. Check model availability and browser memory, then reload the page.");
  } finally { running = false; }
}
