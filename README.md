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

`src/workflow/graph.ts` calls ParancU's `retrieveCandidatesFromPrepared(question, corpus, 5)` directly in process. No HTTP server is required for this path. The workflow remains Retrieve → Generate → Verify. Retrieval runs once; candidates are evaluated in rank order, one at a time. Each generation call receives only the question and current candidate's chunk. Multi-chunk evidence composition is not implemented yet.

The verifier requires both checks to pass:

1. **Evidence support:** the answer must be supported by the retrieved evidence in the current candidate's chunk.
2. **Question alignment:** the answer must actually answer the original user question without substituting concepts, answering a nearby question, or treating distinct terms as equivalent.

An answer that accurately summarizes a retrieved chunk but changes the meaning of the question is rejected.

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

`src/workflow/runWorkflow.test.ts` exercises the public wrapper and actual graph using injected async retrieval, generation and verification fakes. `src/web/web.test.ts` adds store, adapter and loopback HTTP integration tests. Neither suite requires API credentials, embedding inference or a Langfuse exporter. Tests cover empty retrieval, acceptance at ranks 1–5, exact evidence/provenance and call order, exhaustion, operational errors, preparation states and persistence, concurrent requests and HTTP input handling. They verify orchestration behavior, not LLM semantic accuracy.

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

## Local web application

The web application uses one Node/TypeScript process, the existing ParancU preparation functions and the unchanged LangGraph workflow. It serves static HTML/CSS/JavaScript and a JSON API on loopback. No React, Python backend, database or additional npm dependency is required.

Install dependencies from the repository root (use a current supported Node version compatible with the installed packages, Node 22+):

```sh
npm ci
npm --prefix services/parancu-api ci
```

The existing E5 files must be present in `services/parancu-api/assets/models/e5/`, including `model_int8.onnx`, `tokenizer.json` and `tokenizer_config.json`. Provision these as for the existing CLI; startup does not download them.

Configure environment variables in the launching shell; this application does not load `.env` files automatically:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Ignored by the web app; used only by CLI workflows |
| `EXPO_PUBLIC_OPENAI_MODEL` | Optional preparation model override; despite the inherited name, it is used only on the server here |
| `OPENAI_MODEL` | Optional generation/verifier model override |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Langfuse project credentials and endpoint |
| `WEB_PORT` | Optional local port, default `3000` |

The current code defaults both OpenAI model selections to `gpt-5.4-mini`. No keys are sent to the browser. Starting the web server does not prepare a document or ask questions; the existing tracing SDK initializes once for the server process. Upload/preparation and question submission trigger live OpenAI operations, and workflow traces contain full evidence and answers.

```sh
npm run web:local
# Open http://127.0.0.1:3000
```

1. Open **Settings** and enter an OpenAI key. The web app uses only the key entered here. Choose **Create from TXT**, select one nonempty UTF-8 `.txt` file up to 1 MiB, select English (default) or Italian, and click **Prepare document**. The browser reads the file and sends its unchanged text, name and language as JSON.
2. The application returns a corpus ID immediately and polls `preparing`, `ready` or `failed`. Preparation does not automatically ask any question. There is no per-chunk progress percentage because the existing enrichment function does not expose one.
3. When ready, enter a question and submit it. The server invokes `runWorkflow()` with a request-local adapter that delegates to the original retrieval, generation and verification functions. Retrieval executes once; the adapter preserves all returned candidates for inspection.
4. An accepted answer links to its supporting chunk. The candidate list distinguishes the accepted citation, rejected candidates and candidates not evaluated by the verifier. Scores are retrieval scores, not probabilities. `no_evidence` is shown as a completed search with insufficient support; operational failures are shown separately as errors.

`src/web/corpusStore.ts` persists each completed corpus as `{ info, corpus }` in `data/web/corpora/<server-generated-uuid>.json`, including source filename, language and SHA-256 of the uploaded text. Uploaded filenames never become filesystem paths. The browser remembers only the last corpus ID and can reload that saved corpus after refresh or server restart without enrichment. Choosing and explicitly preparing a new file creates a new corpus; old corpora are not overwritten. The web store is separate from the real-corpus CLI's fixed JSON file.

`src/web/server.ts` exposes `POST /api/corpora`, `GET /api/corpora/:id`, and `POST /api/questions`. It also exposes `POST /api/corpora/import`, `GET /api/corpora/:id/export`, and `GET/PUT/DELETE /api/settings/openai`. It serves allowlisted frontend assets, rejects foreign origins/hosts, and returns generic operational errors rather than upstream response bodies. It binds only to `127.0.0.1`; it is not an authenticated multi-user or public deployment. The UI treats filenames, questions, responses and evidence as untrusted text and does not use `innerHTML`.

Preparation is sequential within a document; one preparation is allowed at a time, and overlapping questions for the same corpus receive a conflict response. Completed corpora are atomically published after enrichment. Failed jobs remain visible in memory and require explicit retry; there is no resume/checkpoint mechanism. A forced server stop loses unfinished preparation, and retry repeats completed metadata calls. Ctrl+C / SIGTERM stops accepting requests, waits for active requests and preparation, and shuts down Langfuse. A primary execution error is preserved if Langfuse shutdown also fails.

The saved files are trusted local data; imported corpora also receive strict structural validation on reload. There is no corpus library/delete UI, conversation memory, token streaming or per-node live progress in this version. Question results are displayed in the browser and traced by the workflow, not saved as separate web result files. The generator/verifier prompts and retrieval logic are unchanged; only credential access and transport error sanitization are shared. The models still determine semantic grounding quality; model verification is not a proof. File contents are never silently refreshed from a changed source file.

### Keys and corpus exchange

Settings holds the key only in memory for this shared local workspace. The password field clears after submission or closing the dialog. A successful **Use key** submission closes the dialog and shows **OpenAI ready**. Keys are never returned by the API or stored in browser storage, corpus files, logs, or traces. **Remove key** clears the in-memory user key and immediately shows **OpenAI key missing**, disabling TXT preparation and questions. There is no environment fallback in the web app, even if the server process has `OPENAI_API_KEY` configured. Import and export remain available without a key. Readiness indicates configuration, not a live credential check. TXT preparation and questions require a key. Stopping the server clears the session key and prevents further requests with it; requests already sent may still finish. Imported documents, questions, and model responses are checked for known credentials and OpenAI-key-shaped strings before persistence or tracing.

**Import prepared corpus** accepts ParancU JSON up to 32 MiB without a key and without calling OpenAI or E5. Legacy files contain exactly `docId`, `sentences`, and `chunks`. Each chunk must include summary, guiding question, answer focus, and both 384-dimensional finite nonzero E5 vectors. Validation rejects unknown fields, invalid sentence IDs/offsets, broken references, inconsistent chunk text, missing metadata, and incompatible versioned exports. For legacy files without document metadata, the selected language, imported filename, and import date describe the local copy. Vector provenance cannot be proven from a legacy array; use corpora generated by the existing multilingual E5-small pipeline.

**Export corpus** downloads a version 1 wrapper containing `formatVersion`, `sourceFilename`, `language`, `createdAt`, `embedding: { model: "multilingual-e5-small", dimensions: 384 }`, and the exact `corpus` passed to the workflow. Reimport preserves these fields, document ID, sentence units, metadata and vectors. Export filenames are sanitized. Imported corpora use a separate server-generated storage ID, are marked as imported, and can be queried immediately once a key is configured. Import/export never regenerates metadata or embeddings. The stored hash identifies TXT content for created corpora and corpus JSON for imports.

Validation without OpenAI calls:

```sh
npm run typecheck
npm run test:deterministic
git diff --check
```
