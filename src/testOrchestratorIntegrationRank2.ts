import { prepareCorpusLocal } from "../services/parancu-api/src/local/prepareCorpus";
import { enrichPreparedCorpusWithOpenAI } from "../services/parancu-api/src/lib/gen/openaiPrepare";
import { runOrchestrator } from "./agent/orchestrator";

async function main() {
  const document = [
    "The Atlas prototype was developed by the research team.",
    "Atlas is a compact prototype designed for field testing.",
    "The team evaluated the prototype under several environmental conditions.",
    "The Nova prototype is blue and weighs 900 grams.",
    "Nova was developed after Atlas.",
    "Its battery lasts approximately six hours.",
    "The Atlas prototype is red and weighs 1.2 kilograms.",
    "Atlas uses an aluminium frame.",
    "Its battery lasts approximately eight hours."
  ].join(" ");

  const question =
    "What color is the Atlas prototype?";

  const prepared = prepareCorpusLocal(
    document,
    {
      sentencesPerChunk: 3,
      overlap: 2
    }
  );

  const corpus =
    await enrichPreparedCorpusWithOpenAI(
      prepared,
      {
        corpusLanguage: "en"
      }
    );

  const result = await runOrchestrator(
    question,
    corpus
  );

  console.log("\nQUESTION:");
  console.log(question);

  console.log("\nORCHESTRATOR RESULT:");
  console.log(
    JSON.stringify(result, null, 2)
  );

  if (
    result.action !== "answer" ||
    !result.answer.toLowerCase().includes("red")
  ) {
    throw new Error(
      "Expected the real integration flow to return the supported Atlas color."
    );
  }

  console.log(
    `\nPASS: real integration flow returned the supported answer at candidate rank ${result.candidateRank}.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
