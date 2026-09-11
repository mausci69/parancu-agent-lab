// services/parancu-api/src/agentFile.ts

import fs from "node:fs/promises";

import {
  prepareParancu,
} from "./parancuTool.js";

import {
  runAgent,
} from "./agent.js";

const filePath =
  process.argv[2]?.trim();

const question =
  process.argv
    .slice(3)
    .join(" ")
    .trim();

if (
  !filePath ||
  !question
) {
  throw new Error(
    'Usage: npx tsx src/agentFile.ts <file.txt> "<question>"'
  );
}

const text =
  await fs.readFile(
    filePath,
    "utf8"
  );

await prepareParancu(
  text,
  "it"
);

const answer =
  await runAgent(
    question
  );

console.log(
  "\nAGENT ANSWER:\n"
);

console.log(
  answer
);
