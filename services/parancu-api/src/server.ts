// services/parancu-api/src/server.ts

import http from "node:http";

import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";

import path from "node:path";

import {
  fileURLToPath,
} from "node:url";

import {
  prepareCorpusLocal,
  type PrepareResult,
} from "./local/prepareCorpus.js";

import {
  retrieveFromPrepared,
  retrieveCandidatesFromPrepared,
} from "./local/retrieval.js";

import {
  enrichPreparedCorpusWithOpenAI,
  type CorpusLanguage,
} from "./lib/gen/openaiPrepare.js";

const HOST =
  "127.0.0.1";

const PORT =
  8000;

const __filename =
  fileURLToPath(
    import.meta.url
  );

const __dirname =
  path.dirname(
    __filename
  );

const CORPORA_DIR =
  path.resolve(
    __dirname,
    "../data/corpora"
  );

const corpora =
  new Map<
    string,
    PrepareResult
  >();

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown
): void {
  res.statusCode =
    statusCode;

  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.end(
    JSON.stringify(
      body,
      null,
      2
    )
  );
}

function readBody(
  req: http.IncomingMessage
): Promise<string> {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      let body =
        "";

      req.on(
        "data",
        (chunk) => {
          body +=
            chunk;
        }
      );

      req.on(
        "end",
        () => {
          resolve(
            body
          );
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

function parseCorpusLanguage(
  value: unknown
): CorpusLanguage {
  return value ===
    "it"
    ? "it"
    : "en";
}

function parseEnvironmentId(
  value: unknown
): string {
  const environmentId =
    String(
      value ??
        "default"
    ).trim();

  return (
    environmentId ||
    "default"
  );
}

function getCorpusPath(
  environmentId: string
): string {
  const filename =
    `${encodeURIComponent(
      environmentId
    )}.json`;

  return path.join(
    CORPORA_DIR,
    filename
  );
}

async function saveCorpus(
  environmentId: string,
  corpus: PrepareResult
): Promise<void> {
  await mkdir(
    CORPORA_DIR,
    {
      recursive:
        true,
    }
  );

  await writeFile(
    getCorpusPath(
      environmentId
    ),
    JSON.stringify(
      corpus
    ),
    "utf8"
  );
}

async function getCorpus(
  environmentId: string
): Promise<
  PrepareResult | null
> {
  const cached =
    corpora.get(
      environmentId
    );

  if (cached) {
    return cached;
  }

  try {
    const raw =
      await readFile(
        getCorpusPath(
          environmentId
        ),
        "utf8"
      );

    const corpus =
      JSON.parse(
        raw
      ) as PrepareResult;

    corpora.set(
      environmentId,
      corpus
    );

    console.log(
      "CORPUS LOADED:",
      environmentId
    );

    return corpus;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code ===
        "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      if (
        req.method ===
          "GET" &&
        req.url ===
          "/health"
      ) {
        sendJson(
          res,
          200,
          {
            status:
              "ok",

            service:
              "ParancU API",

            version:
              "0.1.0",

            environments:
              corpora.size,
          }
        );

        return;
      }

      if (
        req.method ===
          "GET" &&
        req.url?.startsWith(
          "/corpus"
        )
      ) {
        try {
          const url =
            new URL(
              req.url,
              `http://${HOST}:${PORT}`
            );

          const environmentId =
            parseEnvironmentId(
              url.searchParams.get(
                "environment_id"
              )
            );

          const corpus =
            await getCorpus(
              environmentId
            );

          if (!corpus) {
            sendJson(
              res,
              200,
              {
                ready:
                  false,

                environment_id:
                  environmentId,

                corpus:
                  null,
              }
            );

            return;
          }

          sendJson(
            res,
            200,
            {
              ready:
                true,

              environment_id:
                environmentId,

              corpus: {
                docId:
                  corpus.docId,

                sentences:
                  corpus
                    .sentences
                    .length,

                chunks:
                  corpus
                    .chunks
                    .length,
              },
            }
          );
        } catch (error) {
          sendJson(
            res,
            500,
            {
              error:
                error instanceof Error
                  ? error.message
                  : String(
                      error
                    ),
            }
          );
        }

        return;
      }

      if (
        req.method ===
          "POST" &&
        req.url ===
          "/prepare"
      ) {
        try {
          const rawBody =
            await readBody(
              req
            );

          const body =
            JSON.parse(
              rawBody
            );

          const text =
            String(
              body?.text ??
                ""
            ).trim();

          if (!text) {
            sendJson(
              res,
              400,
              {
                ready:
                  false,

                error:
                  "Text is required.",
              }
            );

            return;
          }

          const environmentId =
            parseEnvironmentId(
              body
                ?.environment_id
            );

          const corpusLanguage =
            parseCorpusLanguage(
              body
                ?.language
            );

          const prepared =
            prepareCorpusLocal(
              text,
              {
                sentencesPerChunk:
                  3,

                overlap:
                  2,
              }
            );

          const enriched =
            await enrichPreparedCorpusWithOpenAI(
              prepared,
              {
                corpusLanguage,
              }
            );

          corpora.set(
            environmentId,
            enriched
          );

          await saveCorpus(
            environmentId,
            enriched
          );

          console.log(
            "CORPUS SAVED:",
            environmentId
          );

          sendJson(
            res,
            200,
            {
              ready:
                true,

              environment_id:
                environmentId,

              docId:
                enriched.docId,

              language:
                corpusLanguage,

              sentences:
                enriched
                  .sentences
                  .length,

              chunks:
                enriched
                  .chunks
                  .length,
            }
          );
        } catch (error) {
          sendJson(
            res,
            500,
            {
              ready:
                false,

              error:
                error instanceof Error
                  ? error.message
                  : String(
                      error
                    ),
            }
          );
        }

        return;
      }

      if (
        req.method ===
          "POST" &&
        req.url ===
          "/query"
      ) {
        try {
          const rawBody =
            await readBody(
              req
            );

          const body =
            JSON.parse(
              rawBody
            );

          const environmentId =
            parseEnvironmentId(
              body
                ?.environment_id
            );

          const corpus =
            await getCorpus(
              environmentId
            );

          if (!corpus) {
            sendJson(
              res,
              409,
              {
                ready:
                  false,

                environment_id:
                  environmentId,

                error:
                  "No corpus found for this environment. Call /prepare first.",
              }
            );

            return;
          }

          const question =
            String(
              body
                ?.question ??
                ""
            ).trim();

          if (!question) {
            sendJson(
              res,
              400,
              {
                error:
                  "Question is required",
              }
            );

            return;
          }

          const result =
            await retrieveFromPrepared(
              question,
              corpus
            );

          const candidates =
            await retrieveCandidatesFromPrepared(
              question,
              corpus,
              5
            );

          sendJson(
            res,
            200,
            {
              environment_id:
                environmentId,

              question,

              ...result,

              candidates,

              low_confidence:
                result.score <
                0.08,
            }
          );
        } catch (error) {
          sendJson(
            res,
            500,
            {
              error:
                error instanceof Error
                  ? error.message
                  : String(
                      error
                    ),
            }
          );
        }

        return;
      }

      sendJson(
        res,
        404,
        {
          error:
            "Not found",
        }
      );
    }
  );

server.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `ParancU API listening on http://${HOST}:${PORT}`
    );
  }
);