import fs from "node:fs";
import path from "node:path";

import { runOrchestrator } from "./agent/orchestrator";

async function main() {
  const corpusPath = path.resolve(
    "../apps/mobile/corpus_normanni_mobile.json"
  );

  const corpus = JSON.parse(
    fs.readFileSync(corpusPath, "utf8")
  );

const userMessage =
  "C'è qualcosa sulla nascita di Ruggero II?";

  const result = await runOrchestrator(
    userMessage,
    corpus
  );

  console.log("\nUSER:");
  console.log(userMessage);

  console.log("\nORCHESTRATOR RESULT:");
  console.log(
    JSON.stringify(result, null, 2)
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
