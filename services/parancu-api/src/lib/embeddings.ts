// services/parancu-api/src/lib/embeddings.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-node";

const BOS_TOKEN_ID = 0;
const EOS_TOKEN_ID = 2;

const EMBEDDING_DIMENSION = 384;
const MAX_SEQUENCE_LENGTH = 512;

type E5Mode = "query" | "passage";

type TokenizerEncoding = {
  ids: number[];
  tokens: string[];
  attention_mask: number[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_DIR = path.resolve(
  __dirname,
  "../../assets/models/e5"
);

const MODEL_PATH = path.join(
  MODEL_DIR,
  "model_int8.onnx"
);

const TOKENIZER_PATH = path.join(
  MODEL_DIR,
  "tokenizer.json"
);

const TOKENIZER_CONFIG_PATH = path.join(
  MODEL_DIR,
  "tokenizer_config.json"
);

let tokenizer: Tokenizer | null = null;
let embeddingSession: ort.InferenceSession | null = null;
let loading: Promise<void> | null = null;

function readJson(filePath: string): any {
  return JSON.parse(
    fs.readFileSync(filePath, "utf8")
  );
}

async function ensureModels(): Promise<void> {
  if (tokenizer && embeddingSession) {
    return;
  }

  if (loading) {
    return loading;
  }

  loading = (async () => {
    console.log("[E5] Loading desktop assets...");

    if (!fs.existsSync(MODEL_PATH)) {
      throw new Error(
        `E5 model not found: ${MODEL_PATH}`
      );
    }

    if (!fs.existsSync(TOKENIZER_PATH)) {
      throw new Error(
        `E5 tokenizer not found: ${TOKENIZER_PATH}`
      );
    }

    const tokenizerJson =
      readJson(TOKENIZER_PATH);

    const tokenizerConfig =
      readJson(TOKENIZER_CONFIG_PATH);

    const localTokenizer = new Tokenizer(
      tokenizerJson,
      tokenizerConfig
    );

    const validationEncoding =
      localTokenizer.encode(
        "query: ParancU tokenizer test"
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
    });

    embeddingSession =
      await ort.InferenceSession.create(
        MODEL_PATH
      );

    tokenizer = localTokenizer;

    console.log("[E5] Model OK", {
      inputNames: embeddingSession.inputNames,
      outputNames: embeddingSession.outputNames,
    });
  })();

  try {
    await loading;
  } catch (error) {
    tokenizer = null;
    embeddingSession = null;
    loading = null;
    throw error;
  }
}

function prefixText(
  text: string,
  mode: E5Mode
): string {
  return `${mode}: ${text.trim()}`;
}

function truncateSequence(
  tokenIds: number[]
): number[] {
  if (
    tokenIds.length <=
    MAX_SEQUENCE_LENGTH
  ) {
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

  const sequences = texts.map((text) => {
    const encoding = tokenizer!.encode(
      text
    ) as TokenizerEncoding;

    if (!encoding.ids.length) {
      throw new Error(
        "E5 tokenizer returned an empty sequence"
      );
    }

    return truncateSequence(
      encoding.ids
    );
  });

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

  inputIdsData.fill(BigInt(1));

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
        row * sequenceLength +
        column;

      inputIdsData[flatIndex] =
        BigInt(sequence[column]);

      attentionMaskData[flatIndex] =
        BigInt(1);
    }
  }

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

  const shape =
    sentenceEmbedding.dims;

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

  const flatData = Array.from(
    sentenceEmbedding.data as Float32Array,
    Number
  );

  const embeddings: number[][] =
    [];

  for (
    let row = 0;
    row < texts.length;
    row++
  ) {
    const start =
      row * EMBEDDING_DIMENSION;

    embeddings.push(
      flatData.slice(
        start,
        start +
          EMBEDDING_DIMENSION
      )
    );
  }

  return embeddings;
}

export async function embedOne(
  text: string
): Promise<number[]> {
  const [embedding] =
    await embed([text], "query");

  return embedding;
}

export async function embedMany(
  texts: string[]
): Promise<number[][]> {
  return embed(texts, "passage");
}
