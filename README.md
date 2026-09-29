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

On a coverage/concept diagnostic, once per workflow:
  verify → recover (new ParancU query → generate with two chunks → verify)
         → END if supported, otherwise resume advance/exhaustion
```

`src/workflow/graph.ts` calls ParancU's `retrieveCandidatesFromPrepared(question, corpus, 5)` directly in process. No HTTP server is required for this path. The normal workflow remains Retrieve → Generate → Verify, evaluating candidates in rank order, one at a time.

The diagnostic recovery prototype adds at most one extra attempt per workflow. A rejection may include `missingConcepts: ["closed-book question answering"]`. The first concept becomes a new ParancU query such as `What is closed-book question answering?`. Recovery ranks the original corpus with `k = corpus.chunks.length`, preserving positional chunk indices, then checks valid, untried candidates in rank order with a focused LLM support check. The first candidate that adds sufficient evidence for the missing concepts to the original evidence is selected; mere mentions, duplication and nearby concepts are insufficient. The structured verdict is `addsMissingSupport` (boolean) plus `reason`. This can make one extra model call per eligible candidate until acceptance or exhaustion; it does not change ParancU scores or order. It does not scan text for matching words. Generation and verification receive the original question and two labeled chunks. The second verifier must also confirm that **all** previously missing concepts are covered. Missing complementary evidence or a rejected recovery resumes ordinary candidate fallback; operational failures propagate. There is no general planner or composition beyond two chunks.

The verifier requires both checks to pass:

1. **Evidence support:** the answer must be supported by the supplied evidence (one candidate chunk, or the two-chunk recovery set).
2. **Question alignment:** the answer must actually answer the original user question without substituting concepts, answering a nearby question, or treating distinct terms as equivalent.

An answer that accurately summarizes a retrieved chunk but changes the meaning of the question is rejected.

State contains `question`, `corpus`, `candidates`, `candidateIndex`, `answer`, `supported`, `reason`, `missingConcepts`, `recoveryAttempted`, and `evidenceSet`. `src/workflow/runWorkflow.ts` returns either an accepted answer with structured `evidence` (`chunkIndex`, `text`, `candidateRank`, and `score`) and verification reason, or `no_evidence` without evidence when retrieval is empty or all attempts are rejected. Recovered answers additionally include `evidenceSet`, preserving both items and their `retrievalQuery`; ranks and scores belong to their respective queries. The existing single `evidence` field identifies the original candidate for compatibility, not the complete support for a recovered answer. Explicit retrieval, generation and verification errors propagate as errors. Empty recovery output is an operational error; normal-path empty-output handling is unchanged. LLM verification is a safeguard, not a proof of grounding.

## Run the synthetic workflow

Install the root and `services/parancu-api` dependencies using their existing lockfiles (`npm ci` in each directory). The workflow also requires the existing local E5 embedding assets/configuration used by ParancU; see `services/parancu-api/src/lib/embeddings.ts`.

Provide environment variables before launching:

- `OPENAI_API_KEY` for corpus enrichment, generation and verification.
- `OPENAI_MODEL` optionally overrides the generation/verifier model (code default: `gpt-5.4-mini`).
- Optional `PARANCU_OBSERVABILITY=true` plus Langfuse project credentials/endpoint for metadata-only tracing.

From the repository root:

```sh
npm run workflow
```

The entry point prepares a synthetic Atlas/Nova document, enriches it, asks a question and prints the result. It makes live OpenAI calls and uses local embeddings. It enables metadata-only Langfuse tracing only with explicit observability opt-in and shuts an enabled SDK down in a `finally` block.

## Privacy-safe observability

Observability is **disabled by default** for the web application and laboratory
runners. No Langfuse SDK or exporter is loaded or initialized while disabled,
even if Langfuse credentials are present. Only the exact environment value
`PARANCU_OBSERVABILITY=true` opts in; unset, `false`, `1`, and other values
remain disabled. This decision is made at process startup; restart to change it.
Missing credentials never affect disabled startup.

To enable metadata-only observability, set these variables in the launching
environment (the app does not load .env files):

```text
PARANCU_OBSERVABILITY=true
LANGFUSE_PUBLIC_KEY=<your project public key>
LANGFUSE_SECRET_KEY=<your project secret key>
LANGFUSE_BASE_URL=<your Langfuse endpoint>
```

Both credentials must be nonblank when enabled. The endpoint defaults to
`https://cloud.langfuse.com` if omitted or empty; the legacy `LANGFUSE_BASEURL`
alias is not used. If initialization fails, the application continues with
observability disabled and a fixed, content-free warning. There is no verbose
content-tracing mode, including in development.

Enabled traces contain fixed stage names (`parancu-workflow`, `retrieve`,
`generate`, `verify`, `advance`, `diagnostic-recovery`, `complement-selection`,
`verifier-decision`, and the manual diagnostic `parancu-langfuse-test`),
timestamps/durations, SDK-generated trace/span IDs and parent relationships,
and only these application metadata fields:

- Nonnegative finite numbers: `chunkCount`, `candidateCount`, `candidateRank`,
  `chunkIndex`, `currentCandidateRank`, `nextCandidateRank`,
  `missingConceptCount`, `evidenceCount`, `claimCount`, `failedCheckCount`,
  `durationMs`.
- Booleans: `supported`, `evidenceSupported`, `accepted`, `recovered`,
  `answered`, `failed`.

The transport also supplies the fixed service name `parancu-agent-lab`, SDK
name/language/version and instrumentation scope, span type/status/flags, a
metadata-only marker, empty environment/release labels, and protocol bookkeeping.
No original exception messages, stacks, or causes are sent. Failure is a boolean
flag, not verifier prose. Token/cost accounting is not added here.

Questions, document IDs, filenames, raw documents, evidence, answers, summaries,
guiding questions, verifier reasons/claims/quotes, missing-concept text,
credentials, and browser session IDs never enter observation updates. Langfuse
project credentials are used only to authenticate requests to the configured
Langfuse endpoint (HTTP authorization/public-key headers); they are not trace
payloads. OpenAI keys are never passed to this transport. A second
allowlist at the transport boundary rejects unknown/nested/text attributes.
Manual span lifecycle management avoids automatic callback return/error capture.
Only application-marked metadata spans are selected for export; HTTP, log, media,
and automatic resource instrumentation are not enabled by this integration.
Span creation ignores ambient OpenTelemetry/Langfuse context attributes and
session baggage, retaining only the explicit application parent relationships.
SDK console diagnostics are disabled even with debug environment settings;
`LANGFUSE_RELEASE`, `LANGFUSE_TRACING_ENVIRONMENT`, `OTEL_SERVICE_NAME`, and
`OTEL_RESOURCE_ATTRIBUTES` cannot add arbitrary labels or identifiers here.

Console diagnostics remain metadata-only whether tracing is on or off:
preparation chunk counts/indices, retrieval keyword/candidate counts and numeric
scores, and existing E5 loading/tokenizer/model diagnostics. The public server
uses sanitized operation-error messages. No environment switch enables content
logging in the web path. Standalone CLI runners still print their deliberately
requested results to the invoking terminal; these are not public server logs.

Disabling observability does not disable the OpenAI calls explicitly requested
with a session key. Key-free retrieval still runs locally on the application
server and does not invoke the generation/verifier workflow.

Privacy regression coverage is included in `npm run test:deterministic`: exact
opt-in and SDK loading, metadata filtering, return/error privacy, successful and
rejected recovery, unchanged workflow results, retrieval/preparation diagnostics,
and the real Langfuse transport with an in-memory exporter (no Langfuse requests).
Run deterministic checks with `PARANCU_OBSERVABILITY=false`, regardless of any
credentials in your shell. The console regression exercises ranking with an
empty query and empty-corpus enrichment to avoid E5 inference and OpenAI calls;
it separately checks rejection of content-bearing diagnostic fields.

## Deterministic tests

```sh
npm run test:deterministic
# Equivalent:
npm test
```

`src/workflow/runWorkflow.test.ts` exercises the public wrapper and actual graph using injected async retrieval, generation and verification fakes. `src/web/web.test.ts` adds store, adapter and loopback HTTP integration tests. Neither suite requires API credentials, embedding inference or a Langfuse exporter. Tests cover empty retrieval, acceptance at ranks 1–5, exact evidence/provenance and call order, exhaustion, operational errors, preparation states and persistence, concurrent requests and HTTP input handling. They verify orchestration behavior, not LLM semantic accuracy.

The optional third `runWorkflow` argument accepts `WorkflowDependencies`; normal callers use the default graph, including the bounded `recover` node. Recovery tests mock retrieval and OpenAI responses and exercise the real graph and verifier; they do not establish live retrieval or model accuracy.

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

Both live modes use the optional metadata-only observability facade and attempt shutdown in `finally`. A workflow failure remains the primary error if shutdown also fails. Live OpenAI execution still processes document content, but optional Langfuse observations exclude it. Preparation does not add workflow observations. Implementation/help/preflight validation does not perform these live operations.

## Public runtime contract (deployment milestone 1)

`npm start` runs the same TypeScript web entry point as `npm run web:local`.
There is no compilation step or separate service process. Keep the repository
layout intact: root workflow code imports the nested ParancU service in process.
Use Node 22 or newer compatible with the locked dependencies, and pin the exact
Node/npm versions in your deployment environment.

Install from both committed lockfiles on the target operating system/architecture:

```sh
npm ci --include=dev
npm --prefix services/parancu-api ci --omit=dev
```

The root intentionally retains development dependencies at runtime because its
existing `tsx` executable launches TypeScript. Do not prune root dev dependencies
or install the root with `--omit=dev`. This explicit install contract avoids
changing dependency resolution or introducing a build system. The nested install
provides `@huggingface/tokenizers` and native `onnxruntime-node`; do not copy a
developer machine's `node_modules` into a deployment on a different platform.

Provision the existing validated ParancU E5 bundle (`intfloat/multilingual-e5-small`),
identical to the mobile app bundle, at these paths:

```text
services/parancu-api/assets/models/e5/model_int8.onnx
services/parancu-api/assets/models/e5/sentencepiece.bpe.model
services/parancu-api/assets/models/e5/special_tokens_map.json
services/parancu-api/assets/models/e5/tokenizer.json
services/parancu-api/assets/models/e5/tokenizer_config.json
services/parancu-api/assets/models/e5/tokenizer.onnx
```

Paths are resolved relative to `services/parancu-api/src/lib/embeddings.ts`, not the
shell working directory. The model must produce 384-dimensional
`sentence_embedding` output using the matching tokenizer. These locally supplied
assets, including model binaries, remain intentionally outside Git and are not
downloaded at startup or provided by npm. Before startup, run `npm run e5:verify`
to check all six files against the tracked SHA-256 manifest at
`services/parancu-api/assets/e5-manifest.json`. Include
`apps/web/` and `apps/mobile/assets/icon.png`. The process still needs write access
to `data/web/corpora`; storage lifecycle is unchanged by this milestone.

Configure variables in the process environment; `.env` files are not loaded:

| Variable | Contract |
| --- | --- |
| `WEB_PUBLIC_ORIGIN` | Enables public mode, e.g. `https://lab.example`. Must be a canonical HTTPS origin, optionally ending in `/`; no credentials, path, query, or fragment. A non-default HTTPS port is allowed. |
| `NODE_ENV` | Set to `production` for deployment. Startup refuses this mode without `WEB_PUBLIC_ORIGIN`. |
| `PORT` | Platform port; takes precedence over `WEB_PORT`. |
| `WEB_PORT` | Port when `PORT` is absent; otherwise defaults to `3000`. Ports must be decimal integers from 1 through 65535. |
| `WEB_HOST` | Bind IP address or `localhost`; defaults to `127.0.0.1`. Use `0.0.0.0` only when required for private platform/container ingress. Binding does not change the allowed public origin. |

Example behind an HTTPS reverse proxy (replace the example origin):

```sh
NODE_ENV=production WEB_PUBLIC_ORIGIN=https://lab.example WEB_HOST=0.0.0.0 PORT=8080 npm start
```

Run exactly one Node process/instance. Configure TLS at the proxy, redirect public
HTTP to HTTPS there, preserve the canonical public `Host` header including any
non-default port, and preserve the browser's `Origin` and `Sec-Fetch-Site` headers.
The application accepts only that Host and, when supplied, that exact Origin;
cross-site fetches remain rejected. Requests without Origin remain supported for
navigation and same-origin GETs. `Forwarded` and `X-Forwarded-*` headers never
establish trust or alter cookie flags. Public-mode cookies are always Secure,
HttpOnly, SameSite=Strict, host-only and Path=/, even over the proxy's HTTP backend
connection. Keep that backend connection private and prevent direct internet
access to the Node port. The application does not terminate TLS itself.

For local development leave `WEB_PUBLIC_ORIGIN` unset and do not set
`NODE_ENV=production`. The default remains `127.0.0.1:3000`; both localhost and
127.0.0.1 Host headers with the actual port work, with matching origins required.
Session keys and corpus ownership remain memory-only and are lost on process
restart. No shared `OPENAI_API_KEY` is needed for the web app. Existing model and
Langfuse credentials alone do not enable tracing; see the explicit opt-in above.
Runtime/origin support, privacy-safe observability, and bounded process-local resource
admission are implemented. Retention/cleanup and other operational milestones remain separate work.

## Bounded resources (public-release milestone 3)

Limits are centralized in `src/web/resourceLimits.ts` and read once at startup.
All overrides must be positive decimal safe integers; invalid configuration fails
startup. Restart to change limits. The production server shares one
`WebResources` instance across its store, HTTP handlers, and workflow service.
These limits are **process-local**, for the intended single-instance deployment.
They do not coordinate multiple processes or replicas.

| Environment variable | Default | What is bounded |
| --- | ---: | --- |
| `WEB_MAX_TEXT_BYTES` | 1,048,576 (1 MiB) | Decoded TXT content, measured in UTF-8 bytes |
| `WEB_MAX_IMPORT_BYTES` | 8,388,608 (8 MiB) | Entire imported JSON HTTP body, including the request envelope; direct store imports also check corpus JSON bytes |
| `WEB_MAX_CHUNKS` | 256 | Chunks per created, imported, or reloaded corpus |
| `WEB_MAX_CORPORA` | 32 | Retained corpus records plus in-flight import/reload reservations in this process |
| `WEB_MAX_PREPARATIONS` | 1 | Simultaneous TXT preparation jobs; also the size of a separate shared upload/import request-admission gate |
| `WEB_MAX_QUESTIONS` | 2 | Simultaneous question requests, including retrieval-only mode |
| `WEB_MAX_RETRIEVALS` | 2 | Simultaneous retrieval calls across keyed workflows, retrieval-only requests, and diagnostic recovery |

Static assets and unmatched routes do not create browser sessions. Corpus reads,
exports and questions require an existing session; they do not allocate a new
one for an unknown or expired cookie. Settings and import/upload routes retain
their session behavior. There are no health/readiness endpoints in this runtime.
The existing session cap remains 256, with its existing 30-minute idle expiry;
full session capacity now returns 429, without evicting another browser's keys.

Admission is fail-fast, before buffering upload/import/question bodies. The
upload/import gate bounds slow body readers and imports through persistence;
TXT preparation has its own job slot lasting through enrichment and persistence.
Known Content-Length overflow is rejected before reading, and streaming bodies
are counted independently. The TXT request envelope is bounded to
`6 * WEB_MAX_TEXT_BYTES + 4096` bytes to allow JSON escaping; the decoded text
limit still applies. Question JSON is capped at 32 KiB, alongside the existing
4,000-character question limit; key-setting JSON remains capped at 2 KiB.
The existing browser file-size guards are unchanged: lower server limits are
reported by the API, while increasing a server limit does not raise a browser guard.

TXT is split locally once to check the exact chunk count before returning 202
and before any enrichment/OpenAI work. Import chunk counts are checked before
credential scanning and structural/vector validation. The prepared-corpus
schema, embeddings, and import/export representation are unchanged; limits are
an additional admission policy. Above-limit bytes/chunks return **413**. Full
admission capacity returns **429**, with no waiting queue. **503** remains for
an unavailable service (the existing closed session manager), not ordinary load.

All transient permits and import/reload reservations are released in `finally`,
on validation errors, success, and failures. Preparation transfers its permit
to the background job and releases it when that job settles. Retrieval releases
its permit after each actual retrieval call, before Generate/Verify continues.
The existing per-corpus question lock is likewise released in `finally`.

Corpus records in preparing, ready, and failed states count toward the retained
record cap, preserving status polling and preventing unbounded failed-job
metadata. Successful imports/reloads exchange their transient reservation for
one retained record; unsuccessful imports/reloads release the reservation.
The record cap stays full until process restart; sessions expiring do not evict
records. Existing owned corpora remain readable/queryable at capacity. This is
not a disk quota, retention policy, or corpus cleanup mechanism. Restart clears
the in-memory registry and sessions, but does not delete saved files or restore
browser ownership.

Deterministic web tests cover resource configuration, session-free routes,
UTF-8 and streamed-body limits, chunk/record limits, concurrent reservations,
preparation/question/retrieval saturation, recovery retrieval, and permit
release on validation, storage, OpenAI-stage and retrieval failures.

## Local web application

The web application uses one Node/TypeScript process, the existing ParancU preparation functions and the canonical LangGraph workflow. It serves static HTML/CSS/JavaScript and a JSON API on loopback. No React, Python backend, database or additional npm dependency is required.

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
| `PARANCU_OBSERVABILITY` | Only `true` enables metadata-only observability; disabled by default |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Used only after explicit observability opt-in |
| `WEB_PORT` | Optional local port, default `3000`; platform `PORT` takes precedence |

The current code defaults both OpenAI model selections to `gpt-5.4-mini`. No keys are sent to the browser. Starting the web server does not prepare a document or ask questions; observability remains disabled unless explicitly enabled. TXT preparation and keyed questions trigger live OpenAI operations; optional workflow telemetry contains operational metadata only.

```sh
npm run web:local
# Open http://127.0.0.1:3000
```

1. Open **Settings** and enter an OpenAI key. The web app uses only the key entered here. Choose **Create from TXT**, select one nonempty UTF-8 `.txt` file up to 1 MiB, select English (default) or Italian, and click **Prepare document**. The browser reads the file and sends its unchanged text, name and language as JSON.
2. The application returns a corpus ID immediately and polls `preparing`, `ready` or `failed`. Preparation does not automatically ask any question. There is no per-chunk progress percentage because the existing enrichment function does not expose one.
3. When ready, enter a question and submit it. The server invokes `runWorkflow()` with a request-local adapter. The adapter preserves the initial retrieval candidates and any complementary chunk evaluated during diagnostic recovery.
4. An accepted answer cites its supporting chunk, or both chunks after successful recovery. Recovery evidence includes the new retrieval query. The candidate list distinguishes accepted citations, rejected attempts and candidates not evaluated by the verifier. Scores are retrieval scores for their respective queries, not probabilities. `no_evidence` is shown as a completed search with insufficient support; operational failures are shown separately as errors.

`src/web/corpusStore.ts` persists each completed corpus as `{ info, corpus }` in `data/web/corpora/<server-generated-uuid>.json`, including source filename, language and SHA-256 of the uploaded text. Uploaded filenames never become filesystem paths. The browser remembers only the last corpus ID and can reload that saved corpus after refresh or server restart without enrichment. Choosing and explicitly preparing a new file creates a new corpus; old corpora are not overwritten. The web store is separate from the real-corpus CLI's fixed JSON file.

`src/web/server.ts` exposes `POST /api/corpora`, `GET /api/corpora/:id`, and `POST /api/questions`. It also exposes `POST /api/corpora/import`, `GET /api/corpora/:id/export`, and `GET/PUT/DELETE /api/settings/openai`. It serves allowlisted frontend assets, rejects foreign origins/hosts, and returns generic operational errors rather than upstream response bodies. It binds only to `127.0.0.1`; it is not an authenticated multi-user or public deployment. The UI treats filenames, questions, responses and evidence as untrusted text and does not use `innerHTML`.

Preparation is sequential within a document; by default one preparation and two questions are allowed at a time. Full admission capacity and overlapping questions for the same corpus receive HTTP 429. Completed corpora are atomically published after enrichment. Failed jobs remain visible in memory and require explicit retry; there is no resume/checkpoint mechanism. A forced server stop loses unfinished preparation, and retry repeats completed metadata calls. Ctrl+C / SIGTERM stops accepting requests, waits for active requests and preparation, and shuts down Langfuse. A primary execution error is preserved if Langfuse shutdown also fails.

The saved files are trusted local data; imported corpora also receive strict structural validation on reload. There is no corpus library/delete UI, conversation memory, token streaming or per-node live progress in this version. Question results are displayed in the browser, not saved as separate web result files or exported in telemetry. The generator/verifier prompts and retrieval logic are unchanged; only credential access and transport error sanitization are shared. The models still determine semantic grounding quality; model verification is not a proof. File contents are never silently refreshed from a changed source file.

### Keys and corpus exchange

Settings holds the key only in memory for this shared local workspace. The password field clears after submission or closing the dialog. A successful **Use key** submission closes the dialog and shows **OpenAI ready**. Keys are never returned by the API or stored in browser storage, corpus files, logs, or traces. **Remove key** clears the in-memory user key and immediately shows **OpenAI key missing**, disabling TXT preparation and questions. There is no environment fallback in the web app, even if the server process has `OPENAI_API_KEY` configured. Import and export remain available without a key. Readiness indicates configuration, not a live credential check. TXT preparation and questions require a key. Stopping the server clears the session key and prevents further requests with it; requests already sent may still finish. Imported documents, questions, and model responses are checked for known credentials and OpenAI-key-shaped strings before persistence or tracing.

**Import prepared corpus** accepts ParancU JSON within the configured HTTP request limit (8 MiB by default, including the JSON request envelope) without a key and without calling OpenAI or E5. Legacy files contain exactly `docId`, `sentences`, and `chunks`. Each chunk must include summary, guiding question, answer focus, and both 384-dimensional finite nonzero E5 vectors. Validation rejects unknown fields, invalid sentence IDs/offsets, broken references, inconsistent chunk text, missing metadata, and incompatible versioned exports. For legacy files without document metadata, the selected language, imported filename, and import date describe the local copy. Vector provenance cannot be proven from a legacy array; use corpora generated by the existing multilingual E5-small pipeline.

**Export corpus** downloads a version 1 wrapper containing `formatVersion`, `sourceFilename`, `language`, `createdAt`, `embedding: { model: "multilingual-e5-small", dimensions: 384 }`, and the exact `corpus` passed to the workflow. Reimport preserves these fields, document ID, sentence units, metadata and vectors. Export filenames are sanitized. Imported corpora use a separate server-generated storage ID, are marked as imported, and can be queried immediately once a key is configured. Import/export never regenerates metadata or embeddings. The stored hash identifies TXT content for created corpora and corpus JSON for imports.

Validation without OpenAI calls:

```sh
npm run typecheck
npm run test:deterministic
git diff --check
```
