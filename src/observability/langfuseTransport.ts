import { NodeSDK } from "@opentelemetry/sdk-node";
import { context, ROOT_CONTEXT, diag } from "@opentelemetry/api";
import { configureGlobalLogger, LogLevel } from "@langfuse/core";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation, type LangfuseSpan } from "@langfuse/tracing";
import { safeMetadata, type Metadata, type Stage, type ObservationHandle, type TelemetryTransport } from "./langfuse";

/** Loaded only on explicit opt-in; never executes application callbacks in the SDK. */
export function createLangfuseTransport(
  env: NodeJS.ProcessEnv,
  exporter?: NonNullable<ConstructorParameters<typeof LangfuseSpanProcessor>[0]>["exporter"]
): TelemetryTransport {
  if (!env.LANGFUSE_PUBLIC_KEY?.trim() || !env.LANGFUSE_SECRET_KEY?.trim()) {
    throw new Error("Missing observability configuration.");
  }
  // SDK diagnostics can include credentials, endpoint details or upstream errors.
  configureGlobalLogger({ level: LogLevel.NONE });
  diag.disable();
  const sdk = new NodeSDK({
    serviceName: "parancu-agent-lab",
    autoDetectResources: false,
    instrumentations: [],
    textMapPropagator: null,
    logRecordProcessors: [],
    metricReaders: [],
    spanProcessors: [new LangfuseSpanProcessor({
      exporter,
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
      // Do not inherit arbitrary environment/release labels from SDK env vars.
      environment: "",
      release: "",
      mediaUploadEnabled: false,
      shouldExportSpan: ({ otelSpan }) => otelSpan.attributes["parancu.metadata_only"] === true
    })]
  });
  // NodeSDK's constructor can enable diagnostics via OTEL_LOG_LEVEL.
  diag.disable();
  sdk.start();
  function wrap(span: LangfuseSpan): ObservationHandle {
    span.otelSpan.setAttribute("parancu.metadata_only", true);
    const metadata: Metadata = {};
    return {
      update: values => { Object.assign(metadata, safeMetadata(values)); span.update({ metadata: { ...metadata } }); },
      end: () => span.end(),
      child: stage => context.with(ROOT_CONTEXT, () => wrap(span.startObservation(stage)))
    };
  }
  // Keep explicit parent links, but never inherit ambient baggage/session attributes.
  return {
    start: (stage: Stage) => context.with(ROOT_CONTEXT, () => wrap(startObservation(stage))),
    shutdown: () => sdk.shutdown()
  };
}
