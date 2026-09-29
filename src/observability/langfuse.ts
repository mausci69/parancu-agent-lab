import { AsyncLocalStorage } from "node:async_hooks";

const stages = ["parancu-workflow", "retrieve", "generate", "verify", "advance",
  "diagnostic-recovery", "complement-selection", "verifier-decision", "parancu-langfuse-test"] as const;
export type Stage = typeof stages[number];
export type Metadata = Record<string, number | boolean>;
const numbers = new Set(["chunkCount", "candidateCount", "candidateRank", "chunkIndex",
  "currentCandidateRank", "nextCandidateRank", "missingConceptCount", "evidenceCount",
  "claimCount", "failedCheckCount", "durationMs"]);
const booleans = new Set(["supported", "evidenceSupported", "accepted", "recovered", "answered", "failed"]);

/** Flat allowlist: no text, identifiers, nested objects, or arbitrary attribute names. */
export function safeMetadata(value: unknown): Metadata {
  const result: Metadata = {};
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    if (numbers.has(key) && typeof item === "number" && Number.isFinite(item) && item >= 0) result[key] = item;
    if (booleans.has(key) && typeof item === "boolean") result[key] = item;
  }
  return result;
}

export interface ObservationHandle {
  update(metadata: Metadata): void;
  end(): void;
  child(stage: Stage): ObservationHandle;
}
export interface TelemetryTransport {
  start(stage: Stage): ObservationHandle;
  shutdown(): Promise<void>;
}

export function createObservability(
  env: NodeJS.ProcessEnv = process.env,
  initialize: (env: NodeJS.ProcessEnv) => TelemetryTransport = environment =>
    // Do not load SDK/exporter modules unless the explicit switch is true.
    require("./langfuseTransport").createLangfuseTransport(environment)
) {
  let transport: TelemetryTransport | undefined;
  if (env.PARANCU_OBSERVABILITY === "true") {
    try { transport = initialize(env); }
    catch { console.warn("Observability unavailable: initialization failed."); }
  }
  const active = new AsyncLocalStorage<ObservationHandle>();
  const ignoreFailure = (work: () => void) => { try { work(); } catch { /* Telemetry cannot change application results. */ } };
  return {
    get enabled() { return Boolean(transport); },
    startActiveObservation<T>(stage: Stage, work: (span: { update(value: unknown): void }) => T): T {
      if (!transport || !stages.includes(stage)) return work({ update() {} });
      let handle: ObservationHandle;
      try { handle = active.getStore()?.child(stage) ?? transport.start(stage); }
      catch { return work({ update() {} }); }
      const started = performance.now();
      const span = { update(value: unknown) { ignoreFailure(() => handle.update(safeMetadata(value))); } };
      const finish = (failed: boolean) => {
        span.update({ failed, durationMs: performance.now() - started });
        ignoreFailure(() => handle.end());
      };
      try {
        const result = active.run(handle, () => work(span));
        if (
          result &&
          typeof (result as unknown as PromiseLike<unknown>).then === "function"
        ) {
          return Promise.resolve(result).then(value => { finish(false); return value; }, error => {
            finish(true); throw error;
          }) as T;
        }
        finish(false);
        return result;
      } catch (error) { finish(true); throw error; }
    },
    async shutdown() {
      const current = transport;
      transport = undefined;
      if (current) await current.shutdown();
    }
  };
}

export const langfuseSdk = createObservability();
export function startActiveObservation<T>(stage: Stage, work: (span: { update(value: unknown): void }) => T): T {
  return langfuseSdk.startActiveObservation(stage, work);
}
