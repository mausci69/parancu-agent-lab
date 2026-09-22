import { prepareCorpusLocal } from "../services/parancu-api/src/local/prepareCorpus";
import { enrichPreparedCorpusWithOpenAI } from "../services/parancu-api/src/lib/gen/openaiPrepare";
import { runWorkflow } from "./workflow/runWorkflow";

async function main() {
  const document = [
    "The Atlas prototype was developed by the research team.",
    "The Atlas prototype is blue and weighs 1.2 kilograms.",
    "Its battery lasts approximately eight hours.",
    "The Nova prototype was developed later.",
    "Nova is red and weighs 900 grams.",
    "Its battery lasts approximately six hours."
  ].join(" ");

  const prepared = prepareCorpusLocal(
    document,
    {
      docId: "workflow-test"
    }
  );

  const corpus = await enrichPreparedCorpusWithOpenAI(
    prepared
  );

  const result = await runWorkflow(
    "What color is the Atlas prototype?",
    corpus
  );

  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
