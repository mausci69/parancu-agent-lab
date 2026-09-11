// /apps/mobile/src/lib/embeddings.ts

// Local multilingual E5 sentence embeddings via ONNX Runtime React Native.
// Corpus texts are embedded as passages and user questions as queries.
// Tokenisation is performed locally with Hugging Face Tokenizers.js.

import { Tokenizer } from "@huggingface/tokenizers";
import { Asset } from "expo-asset";
import * as ort from "onnxruntime-react-native";

const PAD_TOKEN_ID = BigInt(1);
const BOS_TOKEN_ID = 0;
const EOS_TOKEN_ID = 2;
const UNK_TOKEN_ID = 3;
const EMBEDDING_DIMENSION = 384;
const MAX_SEQUENCE_LENGTH = 512;

type E5Mode = "query" | "passage";

type NumericTensorData =
  | readonly number[]
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

type TokenizerEncoding = {
  ids: number[];
  tokens: string[];
  attention_mask: number[];
};

let tokenizer: Tokenizer | null = null;
let embeddingSession: ort.InferenceSession | null = null;
let loading: Promise<void> | null = null;

/** Resolve a bundled asset to a local file URI. */
async function loadModelAsset(
  moduleId: number
): Promise<string> {
  const asset = Asset.fromModule(moduleId);

  if (!asset.localUri) {
    await asset.downloadAsync();
  }

  if (!asset.localUri) {
    throw new Error(
      `Unable to resolve bundled asset: ${asset.name}`
    );
  }

  return asset.localUri;
}

/** Load the local tokenizer and E5 embedding model exactly once. */
async function ensureModels(): Promise<void> {
  if (tokenizer && embeddingSession) {
    return;
  }

  if (loading) {
    return loading;
  }

  loading = (async () => {
    console.log("[E5] Loading local assets...");

    console.log("[E5] Loading tokenizer configuration...");

    const tokenizerJson = require(
      "../../assets/models/e5/tokenizer.json"
    );

    const tokenizerConfig = require(
      "../../assets/models/e5/tokenizer_config.json"
    );

    const localTokenizer = new Tokenizer(
      tokenizerJson,
      tokenizerConfig
    );

    console.log("[E5] Validating tokenizer...");

    const validationEncoding =
      localTokenizer.encode(
        "query: EcoSearch tokenizer test"
      ) as TokenizerEncoding;

    if (!validationEncoding.ids.length) {
      throw new Error(
        "E5 tokenizer returned an empty validation sequence"
      );
    }

    if (
      validationEncoding.ids[0] !== BOS_TOKEN_ID ||
      validationEncoding.ids[
        validationEncoding.ids.length - 1
      ] !== EOS_TOKEN_ID
    ) {
      throw new Error(
        "Unexpected E5 tokenizer special-token sequence: " +
          JSON.stringify(validationEncoding.ids)
      );
    }

    console.log("[E5] Tokenizer OK", {
      validationTokenCount:
        validationEncoding.ids.length,
      firstTokenId:
        validationEncoding.ids[0],
      lastTokenId:
        validationEncoding.ids[
          validationEncoding.ids.length - 1
        ],
    });

    const embeddingModelUri = await loadModelAsset(
      require("../../assets/models/e5/model_int8.onnx")
    );

    console.log(
      "[E5] Model asset:",
      embeddingModelUri
    );

    console.log(
      "[E5] Creating embedding session..."
    );

    const loadedEmbeddingModel =
      await ort.InferenceSession.create(
        embeddingModelUri
      );

    console.log("[E5] Embedding model OK", {
      inputNames: loadedEmbeddingModel.inputNames,
      outputNames: loadedEmbeddingModel.outputNames,
    });

    tokenizer = localTokenizer;
    embeddingSession = loadedEmbeddingModel;
  })();

  try {
    await loading;
  } catch (error) {
    console.error("[E5] Model loading failed:", error);

    tokenizer = null;
    embeddingSession = null;
    loading = null;

    throw error;
  }
}

/** Add the prefix expected by multilingual E5. */
function prefixText(
  text: string,
  mode: E5Mode
): string {
  return `${mode}: ${text.trim()}`;
}

/** Convert ordinary numeric tensor data to JavaScript numbers. */
function numericTensorDataToNumbers(
  data: NumericTensorData
): number[] {
  const result = new Array<number>(data.length);

  for (
    let index = 0;
    index < data.length;
    index++
  ) {
    result[index] = Number(data[index]);
  }

  return result;
}

/**
 * Truncate an encoded sequence while preserving the final </s> token.
 */
function truncateSequence(
  tokenIds: number[]
): number[] {
  if (tokenIds.length <= MAX_SEQUENCE_LENGTH) {
    return tokenIds;
  }

  const truncated = tokenIds.slice(
    0,
    MAX_SEQUENCE_LENGTH
  );

  truncated[MAX_SEQUENCE_LENGTH - 1] =
    EOS_TOKEN_ID;

  return truncated;
}

/**
 * Tokenise a text batch and construct padded int64 model inputs.
 */
function tokenise(
  texts: string[]
): {
  inputIds: ort.Tensor;
  attentionMask: ort.Tensor;
} {
  if (!tokenizer) {
    throw new Error(
      "E5 tokenizer is not ready"
    );
  }

  console.log("[E5] Tokenising batch...", {
    textsCount: texts.length,
    firstTextLength: texts[0]?.length ?? 0,
  });

  const sequences: number[][] = [];

  for (const text of texts) {
    const encoding =
      tokenizer.encode(text) as TokenizerEncoding;

    if (!encoding.ids.length) {
      throw new Error(
        "E5 tokenizer returned an empty sequence"
      );
    }

    sequences.push(
      truncateSequence(encoding.ids)
    );
  }

  const sequenceLength = Math.max(
    1,
    ...sequences.map(
      (sequence) => sequence.length
    )
  );

  const tensorSize =
    texts.length * sequenceLength;

  const inputIdsData =
    new BigInt64Array(tensorSize);

  const attentionMaskData =
    new BigInt64Array(tensorSize);

  inputIdsData.fill(PAD_TOKEN_ID);

  for (
    let row = 0;
    row < sequences.length;
    row++
  ) {
    const sequence = sequences[row];

    for (
      let column = 0;
      column < sequence.length;
      column++
    ) {
      const flatIndex =
        row * sequenceLength + column;

      inputIdsData[flatIndex] =
        BigInt(sequence[column]);

      attentionMaskData[flatIndex] =
        BigInt(1);
    }
  }

  console.log("[E5] Tokenisation OK", {
    batchSize: texts.length,
    sequenceLength,
  });

  return {
    inputIds: new ort.Tensor(
      "int64",
      inputIdsData,
      [texts.length, sequenceLength]
    ),

    attentionMask: new ort.Tensor(
      "int64",
      attentionMaskData,
      [texts.length, sequenceLength]
    ),
  };
}

/** Run multilingual E5 for a batch of queries or passages. */
async function embed(
  texts: string[],
  mode: E5Mode
): Promise<number[][]> {
  if (!texts.length) {
    return [];
  }

  await ensureModels();

  if (!embeddingSession) {
    throw new Error(
      "E5 embedding session is not ready"
    );
  }

  const prefixedTexts = texts.map(
    (text) => prefixText(text, mode)
  );

  const {
    inputIds,
    attentionMask,
  } = tokenise(prefixedTexts);

  console.log("[E5] Running embedding model...", {
    batchSize: texts.length,
    sequenceLength: inputIds.dims[1],
  });

  const outputs =
    await embeddingSession.run({
      input_ids: inputIds,
      attention_mask: attentionMask,
    });

  const sentenceEmbedding =
    outputs.sentence_embedding;

  if (!sentenceEmbedding) {
    throw new Error(
      "E5 output is missing sentence_embedding"
    );
  }

  const shape = sentenceEmbedding.dims;

  if (
    shape.length !== 2 ||
    shape[0] !== texts.length ||
    shape[1] !== EMBEDDING_DIMENSION
  ) {
    throw new Error(
      `Unexpected E5 sentence_embedding shape: [${shape.join(
        ", "
      )}]`
    );
  }

  const flatData =
    numericTensorDataToNumbers(
      sentenceEmbedding.data as NumericTensorData
    );

  const embeddings: number[][] =
    new Array(texts.length);

  for (
    let row = 0;
    row < texts.length;
    row++
  ) {
    const start =
      row * EMBEDDING_DIMENSION;

    const end =
      start + EMBEDDING_DIMENSION;

    embeddings[row] =
      flatData.slice(start, end);
  }

  console.log("[E5] Embedding model OK", {
    batchSize: embeddings.length,
    dimension: EMBEDDING_DIMENSION,
  });

  return embeddings;
}

/** Embed one user question using the multilingual E5 query prefix. */
export async function embedOne(
  text: string
): Promise<number[]> {
  const [embedding] =
    await embed([text], "query");

  return embedding;
}

/** Embed corpus chunks using the multilingual E5 passage prefix. */
export async function embedMany(
  texts: string[]
): Promise<number[][]> {
  return embed(texts, "passage");
}

/** Clear loaded resources so tests can start from a clean state. */
export function _resetEmbeddingsForTests(): void {
  tokenizer = null;
  embeddingSession = null;
  loading = null;
}