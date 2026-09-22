# ParancU Agent Lab

LangGraph is the canonical orchestration path for this laboratory. ParancU remains the retrieval component; generation and verification operate on its returned evidence.

## Workflow

```text
src/testWorkflow.ts
  prepareCorpusLocal → enrichPreparedCorpusWithOpenAI
  → runWorkflow(question, corpus)
    → retrieve → generate → verify → END (supported)
                   ↑           |
                   └─ advance ←┘ (rejected, candidates remain)
                               └─ END (exhausted)
```

`src/workflow/graph.ts` calls ParancU's `retrieveCandidatesFromPrepared(question, corpus, 5)` directly in process. No HTTP server is required for this path. Retrieval runs once; candidates are tried in rank order, one at a time. Each generation call receives only the question and current candidate's chunk. The existing OpenAI verifier checks the generated answer against that same chunk.

State contains `question`, `corpus`, `candidates`, `candidateIndex`, `answer`, `supported`, and `reason`. `src/workflow/runWorkflow.ts` returns either an accepted answer with evidence, rank, chunk index, score and verification reason, or `no_evidence` when retrieval is empty or all candidates are rejected. Explicit retrieval, generation and verification errors propagate as errors. Empty model-output handling is outside this hardening step and remains unchanged. LLM verification is a safeguard, not a proof of grounding.

## Run the synthetic workflow

Install the root and `services/parancu-api` dependencies using their existing lockfiles (`npm ci` in each directory). The workflow also requires the existing local E5 embedding assets/configuration used by ParancU; see `services/parancu-api/src/lib/embeddings.ts`.

Provide environment variables before launching:

- `OPENAI_API_KEY` for corpus enrichment, generation and verification.
- `OPENAI_MODEL` optionally overrides the generation/verifier model (code default: `gpt-5.4-mini`).
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` for the Langfuse project.

From the repository root:

```sh
npm run workflow
```

The entry point prepares a synthetic Atlas/Nova document, enriches it, asks a question and prints the result. It makes live OpenAI calls and uses local embeddings. It initializes the Langfuse SDK before loading the workflow and shuts the SDK down in a `finally` block, including on failure.

## Tracing

`src/observability/langfuse.ts` configures OpenTelemetry with a Langfuse span processor. The workflow records a parent `parancu-workflow` observation and `retrieve`, `generate`, `verify`, and `advance` observations. Full evidence and answers are recorded, as approved for synthetic laboratory data. Explicit model/token/cost generation metadata is not currently recorded. Corpus preparation is outside the workflow observation.

## Deterministic tests

```sh
npm run test:deterministic
# Equivalent:
npm test
```

`src/workflow/runWorkflow.test.ts` exercises the public wrapper and actual graph using injected async retrieval, generation and verification fakes. It requires no API credentials, HTTP server, embedding inference or Langfuse exporter. Tests cover empty retrieval, acceptance at ranks 1–5, exact evidence/provenance and call order, exhaustion, and propagation of operational errors. They verify orchestration behavior, not LLM semantic accuracy.

The optional third `runWorkflow` argument accepts the existing `WorkflowDependencies`; normal callers continue using the default graph. No graph nodes or edges change.

## Other existing paths

`src/agent/orchestrator.ts` retains an imperative orchestration implementation with a greeting coordinator and an in-memory event trace. It is separate from the canonical LangGraph path.

The HTTP API and Slack/tool agents under `services/parancu-api` remain available as separate integrations. Their agents use `askParancu` → `ParancuClient` → HTTP `/query`; they do not currently invoke this LangGraph workflow. Mobile and other inherited application code are not part of the laboratory runner.
