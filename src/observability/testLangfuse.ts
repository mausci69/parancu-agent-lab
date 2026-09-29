import { langfuseSdk, startActiveObservation } from "./langfuse";

async function main() {
  await startActiveObservation(
    "parancu-langfuse-test",
    async (span) => {
      span.update({ candidateCount: 1, answered: true });
    }
  );
}

main()
  .then(async () => {
    await langfuseSdk.shutdown();
    console.log("Observability diagnostic completed; export requires PARANCU_OBSERVABILITY=true.");
  })
  .catch(async () => {
    console.error("Observability diagnostic failed.");
    await langfuseSdk.shutdown();
    process.exit(1);
  });
