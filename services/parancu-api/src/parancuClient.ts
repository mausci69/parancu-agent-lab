// services/parancu-api/src/parancuClient.ts

export type ParancuCorpusStatus =
  | {
      ready: false;
      environment_id: string;
      corpus: null;
    }
  | {
      ready: true;
      environment_id: string;
      corpus: {
        docId: string;
        sentences: number;
        chunks: number;
      };
    };

export type ParancuPrepareResponse = {
  ready: boolean;
  environment_id?: string;
  docId?: string;
  language?: "en" | "it";
  sentences?: number;
  chunks?: number;
  error?: string;
};

export type ParancuQueryCandidate = {
  chunk_index: number;
  guiding_question: string;
  answer_focus: string;
  chunk: string;
  summary: string;
  sentence_ids: number[];
  score: number;
  cosine_score: number;
};

export type ParancuQueryResponse = {
  environment_id: string;
  question: string;
  chunk_index: number;
  guiding_question: string;
  answer_focus: string;
  chunk: string;
  summary: string;
  sentence_ids: number[];
  score: number;
  cosine_score: number;
  candidates: ParancuQueryCandidate[];
  low_confidence: boolean;
};

export class ParancuClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl = "http://127.0.0.1:8000"
  ) {
    this.baseUrl =
      baseUrl.replace(/\/+$/, "");
  }

  async health(): Promise<unknown> {
    const response =
      await fetch(
        `${this.baseUrl}/health`
      );

    return this.readJson(
      response
    );
  }

  async corpus(
    environmentId = "default"
  ): Promise<ParancuCorpusStatus> {
    const params =
      new URLSearchParams({
        environment_id:
          environmentId,
      });

    const response =
      await fetch(
        `${this.baseUrl}/corpus?${params.toString()}`
      );

    return this.readJson(
      response
    ) as Promise<ParancuCorpusStatus>;
  }

  async prepare(
    text: string,
    language: "en" | "it" = "en",
    environmentId = "default"
  ): Promise<ParancuPrepareResponse> {
    const response =
      await fetch(
        `${this.baseUrl}/prepare`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              text,
              language,
              environment_id:
                environmentId,
            }),
        }
      );

    return this.readJson(
      response
    ) as Promise<ParancuPrepareResponse>;
  }

  async query(
    question: string,
    environmentId = "default"
  ): Promise<ParancuQueryResponse> {
    const response =
      await fetch(
        `${this.baseUrl}/query`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              question,
              environment_id:
                environmentId,
            }),
        }
      );

    return this.readJson(
      response
    ) as Promise<ParancuQueryResponse>;
  }

  private async readJson(
    response: Response
  ): Promise<unknown> {
    const body =
      await response.json();

    if (!response.ok) {
      const error =
        typeof body ===
          "object" &&
        body !== null &&
        "error" in body
          ? String(
              (
                body as {
                  error: unknown;
                }
              ).error
            )
          : `HTTP ${response.status}`;

      throw new Error(
        `ParancU API error: ${error}`
      );
    }

    return body;
  }
}