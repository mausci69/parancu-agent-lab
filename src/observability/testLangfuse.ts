import { langfuseSdk } from "./langfuse";
import { startActiveObservation } from "@langfuse/tracing";

async function main() {
  await startActiveObservation(
    "parancu-langfuse-test",
    async (span) => {
      span.update({
        input: {
          question: "What color is the Atlas prototype?"
        },
        output: {
          answer: "The Atlas prototype is blue."
        }
      });
    }
  );
}

main()
  .then(async () => {
    await langfuseSdk.shutdown();
    console.log("Langfuse test trace sent.");
  })
  .catch(async (error) => {
    console.error(error);
    await langfuseSdk.shutdown();
    process.exit(1);
  });
