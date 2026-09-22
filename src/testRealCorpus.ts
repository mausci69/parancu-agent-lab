import { randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrepareResult } from "../services/parancu-api/src/local/prepareCorpus";

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "QuestionAnswering.txt");
const corpusPath = path.join(root, "data/corpora/question-answering.prepared.json");
const questions = {
  "lunar-domain": "What did LUNAR answer questions about?",
  "retriever-reader": "What are the respective roles of the retriever and reader in a retriever-reader architecture?",
  "mathqa-languages": "Which input languages does MathQA accept?",
  "lunar-cost": "What was the total development cost of LUNAR in US dollars?"
} as const;
type QuestionId = keyof typeof questions;
type Command = { mode: "help" } | { mode: "prepare"; overwrite: boolean } |
  { mode: "run"; ids: QuestionId[] };

const usage = `Usage:
  npm run workflow:real -- --help
  npm run workflow:real -- prepare [--overwrite]
  npm run workflow:real -- run --question <id>
  npm run workflow:real -- run --all

Question IDs:
${Object.entries(questions).map(([id, question]) => `  ${id}: ${question}`).join("\n")}

prepare reads QuestionAnswering.txt unchanged and enriches it using live OpenAI calls.
run loads the saved corpus and uses live generation, verification and Langfuse tracing.
Preparation never runs questions. Existing corpora require explicit --overwrite.
`;

function parseArgs(args: string[]): Command {
  if (args.length === 1 && args[0] === "--help") return { mode: "help" };
  if (args[0] === "prepare" && (args.length === 1 ||
      (args.length === 2 && args[1] === "--overwrite"))) {
    return { mode: "prepare", overwrite: args.length === 2 };
  }
  if (args[0] === "run") {
    if (args.length === 2 && args[1] === "--all") {
      return { mode: "run", ids: Object.keys(questions) as QuestionId[] };
    }
    if (args.length === 3 && args[1] === "--question" &&
        Object.hasOwn(questions, args[2])) {
      return { mode: "run", ids: [args[2] as QuestionId] };
    }
  }
  throw new Error(`Invalid or missing arguments.\n${usage}`);
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCorpus(value: unknown): asserts value is PrepareResult {
  const fail = () => { throw new Error("Invalid prepared corpus. Prepare it explicitly with prepare --overwrite."); };
  if (!isRecord(value) || typeof value.docId !== "string" || !value.docId.trim() ||
      !Array.isArray(value.sentences) || value.sentences.length === 0 ||
      !Array.isArray(value.chunks) || value.chunks.length === 0) {
    return fail();
  }
  const sentenceIds = new Set<number>();
  for (const sentence of value.sentences) {
    if (!isRecord(sentence) || !Number.isInteger(sentence.id) ||
        typeof sentence.id !== "number" || sentence.id < 0 || sentenceIds.has(sentence.id) ||
        typeof sentence.text !== "string" || !sentence.text.trim() ||
        !Number.isInteger(sentence.start) || !Number.isInteger(sentence.end) ||
        Number(sentence.start) < 0 || Number(sentence.end) <= Number(sentence.start)) return fail();
    sentenceIds.add(sentence.id);
  }
  for (const chunk of value.chunks) {
    if (!isRecord(chunk) || !Number.isInteger(chunk.id) || Number(chunk.id) < 0 ||
        !Number.isInteger(chunk.startSentence) || !Number.isInteger(chunk.endSentence) ||
        !Array.isArray(chunk.sentence_ids) || chunk.sentence_ids.length === 0 ||
        !chunk.sentence_ids.every(id => typeof id === "number" && sentenceIds.has(id)) ||
        !["text", "summary", "guiding_question", "answer_focus"].every(key =>
          typeof chunk[key] === "string" && (chunk[key] as string).trim().length > 0)) return fail();
    for (const field of ["guiding_question_embedding", "answer_focus_embedding"]) {
      const vector = chunk[field];
      if (!Array.isArray(vector) || vector.length !== 384 ||
          !vector.every(n => typeof n === "number" && Number.isFinite(n)) ||
          !vector.some(n => n !== 0)) return fail();
    }
  }
}

async function loadCorpus(): Promise<PrepareResult> {
  if (!await exists(corpusPath)) {
    throw new Error(`Prepared corpus is missing: ${corpusPath}. Run prepare explicitly first.`);
  }
  let value: unknown;
  const raw = await readFile(corpusPath, "utf8");
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${corpusPath}. Prepare it explicitly with prepare --overwrite.`);
  }
  validateCorpus(value);
  return value;
}

async function saveCorpus(corpus: PrepareResult, overwrite: boolean): Promise<void> {
  await mkdir(path.dirname(corpusPath), { recursive: true });
  const temporary = `${corpusPath}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await writeFile(temporary, JSON.stringify(corpus, null, 2), { encoding: "utf8", flag: "wx" });
    if (overwrite) {
      await rename(temporary, corpusPath);
    } else {
      // Atomically refuse replacement even if another preparation finished meanwhile.
      await link(temporary, corpusPath);
    }
    published = true;
  } finally {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          published
            ? `Corpus successfully published to ${corpusPath}, but temporary-file cleanup failed: ${temporary}`
            : `Temporary-file cleanup also failed: ${temporary}`,
          cleanupError
        );
      }
    }
  }
}

async function main() {
  const command = parseArgs(process.argv.slice(2));
  if (command.mode === "help") {
    console.log(usage);
    return;
  }

  // All local preflight checks run before SDK initialization or live-operation imports.
  let source: string | undefined;
  let corpus: PrepareResult | undefined;
  if (command.mode === "prepare") {
    if (!command.overwrite && await exists(corpusPath)) {
      throw new Error(`Prepared corpus already exists: ${corpusPath}. Use prepare --overwrite to regenerate explicitly.`);
    }
    source = await readFile(sourcePath, "utf8");
    if (!source.trim()) throw new Error(`Source document is empty: ${sourcePath}`);
  } else {
    corpus = await loadCorpus();
  }

  const { langfuseSdk } = await import("./observability/langfuse.js");
  let workflowFailed = false;
  try {
    if (command.mode === "prepare") {
      const { prepareCorpusLocal } = await import("../services/parancu-api/src/local/prepareCorpus.js");
      const { enrichPreparedCorpusWithOpenAI } = await import("../services/parancu-api/src/lib/gen/openaiPrepare.js");
      const prepared = prepareCorpusLocal(source!, { docId: "question-answering" });
      const enriched = await enrichPreparedCorpusWithOpenAI(prepared, { corpusLanguage: "en" });
      validateCorpus(enriched);
      await saveCorpus(enriched, command.overwrite);
      console.log(`Saved ${enriched.chunks.length} enriched chunks to ${corpusPath}. No questions executed.`);
    } else {
      const { runWorkflow } = await import("./workflow/runWorkflow.js");
      const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      const resultDirectory = path.join(root, "data/results/question-answering", runId);
      await mkdir(resultDirectory, { recursive: true });
      for (const id of command.ids) {
        const result = await runWorkflow(questions[id], corpus!);
        const record = { questionId: id, expectedAction: id === "lunar-cost" ? "no_evidence" : "answer", result };
        const resultPath = path.join(resultDirectory, `${id}.json`);
        await writeFile(resultPath, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
        console.log(JSON.stringify(record, null, 2));
        console.log(`Saved result to ${resultPath}`);
      }
    }
  } catch (error) {
    workflowFailed = true;
    throw error;
  } finally {
    try {
      await langfuseSdk.shutdown();
    } catch (shutdownError) {
      if (!workflowFailed) throw shutdownError;
      console.error("Langfuse shutdown also failed:", shutdownError);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
