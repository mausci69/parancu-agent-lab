import { verifyEvidence } from "./verifier/evidenceVerifier";

async function main() {
  const question =
    "What color is the prototype device?";

  const answer =
    "The prototype device is blue.";

  const evidence =
    "The prototype device shown in the report is blue and weighs 1.2 kilograms.";

  const result = await verifyEvidence(
    question,
    answer,
    evidence
  );

  console.log("\nQUESTION:");
  console.log(question);

  console.log("\nPROPOSED ANSWER:");
  console.log(answer);

  console.log("\nEVIDENCE:");
  console.log(evidence);

  console.log("\nVERIFICATION:");
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
