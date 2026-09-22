import { langfuseSdk } from "./observability/langfuse";

async function main() {
  let workflowFailed = false;

  try {
    const { prepareCorpusLocal } = await import(
      "../services/parancu-api/src/local/prepareCorpus.js"
    );
    const { enrichPreparedCorpusWithOpenAI } = await import(
      "../services/parancu-api/src/lib/gen/openaiPrepare.js"
    );
    const { runWorkflow } = await import("./workflow/runWorkflow.js");

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
  } catch (error) {
    workflowFailed = true;
    throw error;
  } finally {
    try {
      await langfuseSdk.shutdown();
    } catch (shutdownError) {
      if (!workflowFailed) {
        throw shutdownError;
      }

      console.error("Langfuse shutdown also failed:", shutdownError);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
