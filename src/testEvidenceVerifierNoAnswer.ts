import { verifyEvidence } from "./verifier/evidenceVerifier";

async function main() {
  const question =
    "What color is the Atlas prototype?";

  const answer =
    "The color of the Atlas prototype is not specified in the evidence.";

  const evidence =
    "The Nova prototype is blue and weighs 900 grams.";

  const result = await verifyEvidence(
    question,
    answer,
    evidence
  );

  console.log("\nVERIFICATION:");
  console.log(result);

  if (result.supported) {
    throw new Error(
      "Expected an unsupported result when the evidence does not contain the requested answer."
    );
  }

  console.log(
    "\nPASS: missing-information answer correctly rejected."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
