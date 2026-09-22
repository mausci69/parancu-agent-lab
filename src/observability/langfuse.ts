import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

export const langfuseSdk = new NodeSDK({
  spanProcessors: [
    new LangfuseSpanProcessor()
  ]
});

langfuseSdk.start();
