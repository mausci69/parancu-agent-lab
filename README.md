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

State contains `question`, `corpus`, `candidates`, `candidateIndex`, `answer`, `supported`, and `reason`. `src/workflow/runWorkflow.ts` returns either an accepted answer with structured `evidence` (`chunkIndex`, `text`, `candidateRank`, and `score`) and verification reason, or `no_evidence` without evidence when retrieval is empty or all candidates are rejected. Explicit retrieval, generation and verification errors propagate as errors. Empty model-output handling is outside this hardening step and remains unchanged. LLM verification is a safeguard, not a proof of grounding.

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


## Real-document laboratory runner

`src/testRealCorpus.ts` reads the root `QuestionAnswering.txt` unchanged. Paths are resolved relative to the runner's project directory. This source remains local and is not added by the runner. Preparation and question execution are separate, explicitly selected live operations:

```sh
npm run workflow:real -- --help
npm run workflow:real -- prepare
npm run workflow:real -- run --question lunar-domain
npm run workflow:real -- run --all
# Explicitly replace an existing prepared corpus:
npm run workflow:real -- prepare --overwrite
```

`run` requires exactly one of `--question <id>` or `--all`. Unknown options, missing arguments, conflicting selections and unknown IDs fail before Langfuse initialization. Help also returns without initializing Langfuse or making external calls.

| Question ID | Question | Expected action |
| --- | --- | --- |
| `lunar-domain` | What did LUNAR answer questions about? | `answer` |
| `retriever-reader` | What are the respective roles of the retriever and reader in a retriever-reader architecture? | `answer` |
| `mathqa-languages` | Which input languages does MathQA accept? | `answer` |
| `lunar-cost` | What was the total development cost of LUNAR in US dollars? | `no_evidence` |

`prepare` uses the existing default chunking and English metadata enrichment, including local E5 embeddings. For the current unchanged baseline, local preparation yields 75 chunks; fresh enrichment makes one OpenAI metadata request per chunk. The preparation model uses `EXPO_PUBLIC_OPENAI_MODEL` (default `gpt-5.4-mini`), independently of the generation/verifier `OPENAI_MODEL` setting. The other credentials and local model assets described above are also required.

The enriched corpus is saved to `data/corpora/question-answering.prepared.json`. If this path exists, preparation refuses before external initialization unless `--overwrite` is supplied. Preparation never executes questions. The completed corpus is written to a temporary file and published atomically; the overwrite path uses rename, while the non-overwrite path uses an exclusive hard link so a concurrent preparation cannot silently replace a corpus. First publication requires hard-link support within the same local filesystem; the temporary file and destination are in the same directory. An existing corpus is retained if enrichment fails. Temporary-file cleanup is attempted after writing or publication succeeds or fails. A cleanup failure is reported separately without replacing a writing/publication error; after successful publication it is a cleanup warning, and the saved corpus remains available.

There is no checkpoint/resume support: the enrichment function holds completed chunks in memory. A failure partway through preparation loses that progress; rerunning starts at the first chunk and repeats completed OpenAI calls. No partial corpus is saved.

`run` treats the saved corpus as trusted runner-generated data and performs partial structural validation, including nonempty metadata and finite, nonzero 384-dimensional E5 embeddings. Missing files, invalid JSON and failures of these checks stop execution before Langfuse initialization and require explicit preparation. These checks do not reject every inconsistent corpus: they do not establish unique chunk IDs, consistent chunk boundaries, or agreement between chunk text and referenced sentences. Execution never regenerates metadata, even if the TXT has changed; use `prepare --overwrite` intentionally to refresh it.

Questions run sequentially through the existing `runWorkflow`. Each completed result is printed and saved under `data/results/question-answering/<timestamp-and-uuid>/<question-id>.json`, including its expected action for manual comparison. Expectations do not override actual model results or constitute automatic semantic grading. If a later question fails, earlier saved results remain; the error propagates and subsequent questions are not run. All generated corpora and results are under the already ignored `data/` directory.

Both live modes initialize the existing Langfuse SDK before loading preparation/workflow modules and attempt shutdown in `finally`. A workflow failure remains the primary error if shutdown also fails; shutdown failure is reported separately. A shutdown-only failure propagates. Running questions exports full evidence and answers through the existing workflow instrumentation; preparation does not add new observations. Live execution sends real document content to OpenAI and, for workflow observations, Langfuse. Implementation/help/preflight validation does not perform these live operations.
