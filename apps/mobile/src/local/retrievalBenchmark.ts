// /apps/mobile/src/local/retrievalBenchmark.ts

import * as FileSystem from "expo-file-system/legacy";

import { loadActiveCorpus } from "./corpusStore";
import {
  retrieveCandidatesFromPrepared,
  type RetrieveResult,
} from "./retrieval";

const TOP_K = 5;
const MIN_REQUIRED_CORPUS_MARKERS = 4;

const NORMAN_SICILY_CORPUS_MARKERS = [
  "storia della sicilia normanna",
  "battaglia di cerami",
  "apostolica legazia",
  "regno normanno d africa",
  "siracusa",
];

export type BenchmarkCategory =
  | "direct"
  | "paraphrase"
  | "date"
  | "relationship";

export type BenchmarkStatus =
  | "PASS"
  | "PARTIAL"
  | "FAIL";

export type RetrievalBenchmarkCase = {
  id: string;
  category: BenchmarkCategory;
  question: string;
  expectedSentenceIds: number[];
  note: string;
};

export type RetrievalBenchmarkCaseResult = {
  id: string;
  category: BenchmarkCategory;
  question: string;
  expectedSentenceIds: number[];
  note: string;
  status: BenchmarkStatus;
  top1Hit: boolean;
  top3Hit: boolean;
  top1ChunkIndex: number;
  top1SentenceIds: number[];
  top1Score: number;
  top1CosineScore: number;
  candidates: Array<{
    rank: number;
    chunkIndex: number;
    sentenceIds: number[];
    score: number;
    cosineScore: number;
    guidingQuestion: string;
    summary: string;
    chunk: string;
  }>;
};

export type RetrievalBenchmarkSummary = {
  total: number;
  passed: number;
  partial: number;
  failed: number;
  top1Accuracy: number;
  top3Accuracy: number;
};

export type RetrievalBenchmarkCorpusValidation = {
  matchedMarkers: string[];
  missingMarkers: string[];
  requiredMarkerCount: number;
  valid: boolean;
};

export type RetrievalBenchmarkReport = {
  benchmarkId: string;
  corpusDocId: string;
  corpusValidation: RetrievalBenchmarkCorpusValidation;
  startedAt: string;
  completedAt: string;
  semanticWeight: number;
  topK: number;
  summary: RetrievalBenchmarkSummary;
  results: RetrievalBenchmarkCaseResult[];
  jsonFileUri: string;
  csvFileUri: string;
};

const BENCHMARK_CASES: RetrievalBenchmarkCase[] = [
  {
    id: "norman_direct_01",
    category: "direct",
    question:
      "Quando iniziò la conquista normanna della Sicilia?",
    expectedSentenceIds: [0],
    note:
      "La conquista normanna iniziò nel 1061 con lo sbarco a Messina.",
  },
  {
    id: "norman_date_01",
    category: "date",
    question:
      "Chi instaurò il Regno di Sicilia nel 1130?",
    expectedSentenceIds: [1, 53],
    note:
      "Ruggero II instaurò il regno e fu incoronato nel 1130.",
  },
  {
    id: "norman_paraphrase_01",
    category: "paraphrase",
    question:
      "Per chi combattevano i Normanni prima della conquista?",
    expectedSentenceIds: [3, 4, 5],
    note:
      "I Normanni operavano come mercenari e furono impiegati anche dai Bizantini.",
  },
  {
    id: "norman_date_02",
    category: "date",
    question:
      "Quale battaglia fu combattuta nel 1063?",
    expectedSentenceIds: [25],
    note:
      "Nel 1063 ebbe luogo la battaglia di Cerami.",
  },
  {
    id: "norman_direct_02",
    category: "direct",
    question:
      "Quali città conquistarono nel 1071 e nel 1072?",
    expectedSentenceIds: [27],
    note:
      "Catania fu conquistata nel 1071 e Palermo nel 1072.",
  },
  {
    id: "norman_relationship_01",
    category: "relationship",
    question:
      "Quale privilegio papale permetteva ai Normanni di scegliere i vescovi?",
    expectedSentenceIds: [31, 49],
    note:
      "Il privilegio era l'Apostolica legazia.",
  },
  {
    id: "norman_direct_03",
    category: "direct",
    question:
      "Quale geografo arabo lavorò alla corte di Ruggero?",
    expectedSentenceIds: [56, 82],
    note:
      "Il geografo arabo era al-Idrisi.",
  },
  {
    id: "norman_paraphrase_02",
    category: "paraphrase",
    question:
      "Fin dove si estese il dominio siciliano sulla costa africana?",
    expectedSentenceIds: [60, 61, 62],
    note:
      "Le conquiste si estesero da Tripoli a Capo Bon e Bona.",
  },
  {
    id: "norman_relationship_02",
    category: "relationship",
    question:
      "Che cosa aprì la strada alla conquista sveva?",
    expectedSentenceIds: [68],
    note:
      "Il matrimonio tra Enrico VI e Costanza d'Altavilla aprì la strada alla conquista sveva.",
  },
  {
    id: "norman_paraphrase_03",
    category: "paraphrase",
    question:
      "Perché Siracusa divenne una roccaforte militare?",
    expectedSentenceIds: [84, 85, 87, 88],
    note:
      "Siracusa divenne una roccaforte grazie alla sua posizione strategica.",
  },
];

function normaliseText(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCorpusSearchText(
  corpus: Awaited<ReturnType<typeof loadActiveCorpus>>
): string {
  if (!corpus) {
    return "";
  }

  const sentenceText = corpus.sentences
    .map((sentence) => sentence.text)
    .join("\n");

  const chunkMetadata = corpus.chunks
    .map((chunk) =>
      [
        chunk.text,
        chunk.summary,
        chunk.guiding_question,
        chunk.answer_focus,
      ]
        .map((value) => String(value ?? ""))
        .join("\n")
    )
    .join("\n");

  return normaliseText(
    `${sentenceText}\n${chunkMetadata}`
  );
}

function validateNormanSicilyCorpus(
  corpus: NonNullable<
    Awaited<ReturnType<typeof loadActiveCorpus>>
  >
): RetrievalBenchmarkCorpusValidation {
  const corpusText =
    buildCorpusSearchText(corpus);

  const matchedMarkers =
    NORMAN_SICILY_CORPUS_MARKERS.filter(
      (marker) =>
        corpusText.includes(
          normaliseText(marker)
        )
    );

  const missingMarkers =
    NORMAN_SICILY_CORPUS_MARKERS.filter(
      (marker) =>
        !matchedMarkers.includes(marker)
    );

  return {
    matchedMarkers,
    missingMarkers,
    requiredMarkerCount:
      MIN_REQUIRED_CORPUS_MARKERS,
    valid:
      matchedMarkers.length >=
      MIN_REQUIRED_CORPUS_MARKERS,
  };
}

function hasSentenceIntersection(
  actualSentenceIds: number[],
  expectedSentenceIds: number[]
): boolean {
  const expected = new Set(
    expectedSentenceIds
  );

  return actualSentenceIds.some(
    (sentenceId) =>
      expected.has(sentenceId)
  );
}

function evaluateCandidates(
  candidates: RetrieveResult[],
  expectedSentenceIds: number[]
): {
  status: BenchmarkStatus;
  top1Hit: boolean;
  top3Hit: boolean;
} {
  const top1 = candidates[0];

  const top1Hit = top1
    ? hasSentenceIntersection(
        top1.sentence_ids,
        expectedSentenceIds
      )
    : false;

  const top3Hit = candidates
    .slice(0, 3)
    .some((candidate) =>
      hasSentenceIntersection(
        candidate.sentence_ids,
        expectedSentenceIds
      )
    );

  if (top1Hit) {
    return {
      status: "PASS",
      top1Hit,
      top3Hit,
    };
  }

  if (top3Hit) {
    return {
      status: "PARTIAL",
      top1Hit,
      top3Hit,
    };
  }

  return {
    status: "FAIL",
    top1Hit,
    top3Hit,
  };
}

function makeSummary(
  results: RetrievalBenchmarkCaseResult[]
): RetrievalBenchmarkSummary {
  const total = results.length;

  const passed = results.filter(
    (result) =>
      result.status === "PASS"
  ).length;

  const partial = results.filter(
    (result) =>
      result.status === "PARTIAL"
  ).length;

  const failed = results.filter(
    (result) =>
      result.status === "FAIL"
  ).length;

  const top1Hits = results.filter(
    (result) => result.top1Hit
  ).length;

  const top3Hits = results.filter(
    (result) => result.top3Hit
  ).length;

  return {
    total,
    passed,
    partial,
    failed,
    top1Accuracy:
      total > 0
        ? top1Hits / total
        : 0,
    top3Accuracy:
      total > 0
        ? top3Hits / total
        : 0,
  };
}

function escapeCsv(
  value: unknown
): string {
  const text = String(value ?? "");

  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(
  results: RetrievalBenchmarkCaseResult[]
): string {
  const headers = [
    "id",
    "category",
    "question",
    "status",
    "expected_sentence_ids",
    "top1_hit",
    "top3_hit",
    "top1_chunk_index",
    "top1_sentence_ids",
    "top1_score",
    "top1_cosine_score",
    "top1_guiding_question",
    "top1_summary",
    "note",
  ];

  const rows = results.map(
    (result) => {
      const topCandidate =
        result.candidates[0];

      return [
        result.id,
        result.category,
        result.question,
        result.status,
        result.expectedSentenceIds.join(
          "|"
        ),
        result.top1Hit,
        result.top3Hit,
        result.top1ChunkIndex,
        result.top1SentenceIds.join("|"),
        result.top1Score,
        result.top1CosineScore,
        topCandidate?.guidingQuestion ??
          "",
        topCandidate?.summary ?? "",
        result.note,
      ]
        .map(escapeCsv)
        .join(",");
    }
  );

  return [
    headers.map(escapeCsv).join(","),
    ...rows,
  ].join("\n");
}

async function saveBenchmarkReport(
  reportWithoutUris: Omit<
    RetrievalBenchmarkReport,
    "jsonFileUri" | "csvFileUri"
  >
): Promise<{
  jsonFileUri: string;
  csvFileUri: string;
}> {
  const outputDirectory =
    `${FileSystem.documentDirectory}` +
    "ecosearch-benchmarks/";

  const directoryInfo =
    await FileSystem.getInfoAsync(
      outputDirectory
    );

  if (!directoryInfo.exists) {
    await FileSystem.makeDirectoryAsync(
      outputDirectory,
      {
        intermediates: true,
      }
    );
  }

  const timestamp =
    reportWithoutUris.completedAt.replace(
      /[:.]/g,
      "-"
    );

  const baseName =
    `retrieval-benchmark-${timestamp}`;

  const jsonFileUri =
    `${outputDirectory}${baseName}.json`;

  const csvFileUri =
    `${outputDirectory}${baseName}.csv`;

  await FileSystem.writeAsStringAsync(
    jsonFileUri,
    JSON.stringify(
      reportWithoutUris,
      null,
      2
    ),
    {
      encoding:
        FileSystem.EncodingType.UTF8,
    }
  );

  await FileSystem.writeAsStringAsync(
    csvFileUri,
    buildCsv(
      reportWithoutUris.results
    ),
    {
      encoding:
        FileSystem.EncodingType.UTF8,
    }
  );

  return {
    jsonFileUri,
    csvFileUri,
  };
}

export async function runNormanSicilyRetrievalBenchmark(): Promise<RetrievalBenchmarkReport> {
  const corpus =
    await loadActiveCorpus();

  if (!corpus) {
    throw new Error(
      "No active corpus is available. Prepare or load the Norman Sicily corpus first."
    );
  }

  const corpusValidation =
    validateNormanSicilyCorpus(corpus);

  if (!corpusValidation.valid) {
    throw new Error(
      [
        "The active corpus does not appear to be the Norman Sicily benchmark corpus.",
        `Matched ${corpusValidation.matchedMarkers.length} of ${NORMAN_SICILY_CORPUS_MARKERS.length} identifying markers.`,
        `Required: ${MIN_REQUIRED_CORPUS_MARKERS}.`,
        `Missing markers: ${corpusValidation.missingMarkers.join(", ") || "none"}.`,
      ].join(" ")
    );
  }

  const startedAt =
    new Date().toISOString();

  const results:
    RetrievalBenchmarkCaseResult[] = [];

  for (
    const benchmarkCase of
    BENCHMARK_CASES
  ) {
    console.log(
      "[RETRIEVAL BENCHMARK] Running:",
      benchmarkCase.id,
      benchmarkCase.question
    );

    const candidates =
      await retrieveCandidatesFromPrepared(
        benchmarkCase.question,
        corpus,
        TOP_K
      );

    const evaluation =
      evaluateCandidates(
        candidates,
        benchmarkCase.expectedSentenceIds
      );

    const topCandidate =
      candidates[0];

    results.push({
      id: benchmarkCase.id,
      category:
        benchmarkCase.category,
      question:
        benchmarkCase.question,
      expectedSentenceIds:
        benchmarkCase.expectedSentenceIds,
      note: benchmarkCase.note,
      status: evaluation.status,
      top1Hit:
        evaluation.top1Hit,
      top3Hit:
        evaluation.top3Hit,
      top1ChunkIndex:
        topCandidate?.chunk_index ??
        -1,
      top1SentenceIds:
        topCandidate?.sentence_ids ??
        [],
      top1Score:
        topCandidate?.score ?? 0,
      top1CosineScore:
        topCandidate?.cosine_score ??
        0,
      candidates: candidates.map(
        (candidate, index) => ({
          rank: index + 1,
          chunkIndex:
            candidate.chunk_index,
          sentenceIds:
            candidate.sentence_ids,
          score: candidate.score,
          cosineScore:
            candidate.cosine_score,
          guidingQuestion:
            candidate.guiding_question,
          summary:
            candidate.summary,
          chunk:
            candidate.chunk,
        })
      ),
    });
  }

  const completedAt =
    new Date().toISOString();

  const reportWithoutUris = {
    benchmarkId:
      "norman-sicily-retrieval-v1",
    corpusDocId: corpus.docId,
    corpusValidation,
    startedAt,
    completedAt,
    semanticWeight: 0.65,
    topK: TOP_K,
    summary:
      makeSummary(results),
    results,
  };

  const {
    jsonFileUri,
    csvFileUri,
  } = await saveBenchmarkReport(
    reportWithoutUris
  );

  const report:
    RetrievalBenchmarkReport = {
      ...reportWithoutUris,
      jsonFileUri,
      csvFileUri,
    };

  console.log(
    "[RETRIEVAL BENCHMARK] Corpus validation:",
    JSON.stringify(
      corpusValidation,
      null,
      2
    )
  );

  console.log(
    "[RETRIEVAL BENCHMARK] Completed:",
    JSON.stringify(
      report.summary,
      null,
      2
    )
  );

  console.log(
    "[RETRIEVAL BENCHMARK] JSON:",
    jsonFileUri
  );

  console.log(
    "[RETRIEVAL BENCHMARK] CSV:",
    csvFileUri
  );

  return report;
}