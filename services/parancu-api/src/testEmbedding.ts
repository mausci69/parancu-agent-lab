// services/parancu-api/src/testEmbedding.ts

import { embedOne } from "./lib/embeddings.js";

const question =
  "Quando sono sbarcati i Normanni in Sicilia?";

const embedding =
  await embedOne(question);

console.log("QUESTION:");
console.log(question);

console.log("\nEMBEDDING:");
console.log("dimension:", embedding.length);
console.log(
  "first 10:",
  embedding.slice(0, 10)
);
