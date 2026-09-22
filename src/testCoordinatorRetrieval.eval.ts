import fs from "node:fs";
import path from "node:path";

import { coordinate } from "./coordinator/coordinator";
import { verifyEvidence } from "./verifier/evidenceVerifier";
import { generateResponse } from "./responder/responseAgent";
import { retrieveCandidatesFromPrepared } from "../services/parancu-api/src/local/retrieval";

async function main() {
  const corpusPath = path.resolve(
    "../apps/mobile/corpus_normanni_mobile.json"
  );

  const corpus = JSON.parse(
    fs.readFileSync(corpusPath, "utf8")
  );

  const userMessage =
    "C'è qualcosa sulla nascita del Regno di Sicilia?";

  const decision = coordinate(userMessage);

  console.log("\nUSER:");
  console.log(userMessage);

  console.log("\nCOORDINATOR:");
  console.log(decision);

  if (decision.action === "retrieve") {
    const candidates =
      await retrieveCandidatesFromPrepared(
        decision.query,
        corpus,
        5
      );

    for (
      let i = 0;
      i < candidates.length;
      i += 1
    ) {
      const candidate = candidates[i];

      console.log(`\nCANDIDATE ${i + 1}:`);
      console.log(
        JSON.stringify(candidate, null, 2)
      );

      const answer = await generateResponse(
        userMessage,
        candidate.chunk
      );

      console.log("\nGENERATED ANSWER:");
      console.log(answer);

      const verification = await verifyEvidence(
        userMessage,
        answer,
        candidate.chunk
      );

      console.log("\nVERIFICATION:");
      console.log(
        JSON.stringify(verification, null, 2)
      );

      if (verification.supported) {
        console.log(
          `\nSUPPORTED ANSWER FOUND AT RANK ${i + 1}`
        );

        console.log("\nFINAL ANSWER:");
        console.log(answer);

        return;
      }
    }

    console.log(
      "\nNO SUPPORTED ANSWER FOUND"
    );

    return;
  }

  console.log("\nDIRECT RESPONSE:");
  console.log(decision.message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});