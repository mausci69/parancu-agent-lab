// services/parancu-api/src/testRetrieval.ts

import fs from "node:fs";
import path from "node:path";

import {
  retrieveFromPrepared,
} from "./local/retrieval.js";

const corpusPath = path.resolve(
  "../../apps/mobile/corpus_normanni_mobile.json"
);

const corpus = JSON.parse(
  fs.readFileSync(corpusPath, "utf8")
);

const question =
  "Quando sono sbarcati i Normanni in Sicilia?";

const result =
  await retrieveFromPrepared(
    question,
    corpus
  );

console.log("\nQUESTION:");
console.log(question);

console.log("\nRESULT:");
console.log(
  JSON.stringify(result, null, 2)
);
