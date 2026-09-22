// /src/testOrchestrator.ts

import { prepareCorpusLocal } from "../services/parancu-api/src/local/prepareCorpus";
import { enrichPreparedCorpusWithOpenAI } from "../services/parancu-api/src/lib/gen/openaiPrepare";
import { runOrchestrator } from "./agent/orchestrator";

async function main() {
  const document = [
    "The Atlas prototype was developed by the research team.",
    "The prototype is blue and weighs 1.2 kilograms.",
    "Its battery lasts approximately eight hours.",
    "A second prototype called Nova was developed later.",
    "Nova is red and weighs 900 grams."
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
