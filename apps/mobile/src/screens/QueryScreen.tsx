// /apps/mobile/src/screens/QueryScreen.tsx

import React, {
  useEffect,
  useState,
} from "react";

import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
} from "react-native";

import { useTranslation } from "react-i18next";

import { query } from "../lib/api";

import type {
  QueryResponse,
} from "../lib/api";

import {
  runNormanSicilyRetrievalBenchmark,
  type RetrievalBenchmarkReport,
  type RetrievalBenchmarkCaseResult,
} from "../local/retrievalBenchmark";

type ScreenResponse = QueryResponse & {
  evidence_text?: string;
  evidence_type?: string;
};

function norm(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPercentage(
  value: number
): string {
  return `${(value * 100).toFixed(1)}%`;
}

function benchmarkStatusLabel(
  result: RetrievalBenchmarkCaseResult
): string {
  if (result.status === "PASS") {
    return "PASS";
  }

  if (result.status === "PARTIAL") {
    return "PARTIAL";
  }

  return "FAIL";
}

function benchmarkStatusColours(
  result: RetrievalBenchmarkCaseResult
): {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
} {
  if (result.status === "PASS") {
    return {
      backgroundColor: "#e8f5e9",
      borderColor: "#2e7d32",
      textColor: "#1b5e20",
    };
  }

  if (result.status === "PARTIAL") {
    return {
      backgroundColor: "#fff8e1",
      borderColor: "#f9a825",
      textColor: "#8d6e00",
    };
  }

  return {
    backgroundColor: "#ffebee",
    borderColor: "#c62828",
    textColor: "#b71c1c",
  };
}

console.log(
  "[QueryScreen] module loaded"
);

export default function QueryScreen() {
  const { t } = useTranslation();

  const [
    question,
    setQuestion,
  ] = useState<string>("");

  const [
    busy,
    setBusy,
  ] = useState<boolean>(false);

  const [
    res,
    setRes,
  ] = useState<ScreenResponse | null>(
    null
  );

  const [
    benchmarkBusy,
    setBenchmarkBusy,
  ] = useState<boolean>(false);

  const [
    benchmarkReport,
    setBenchmarkReport,
  ] =
    useState<RetrievalBenchmarkReport | null>(
      null
    );

  useEffect(() => {
    console.log(
      "[QueryScreen] component mounted"
    );
  }, []);

  async function handleAsk(): Promise<void> {
    const q = question.trim();

    if (!q) {
      Alert.alert(
        t(
          "ask.alert.emptyTitle",
          "Question required"
        ),
        t(
          "ask.alert.emptyBody",
          "Please type a question before retrieving."
        )
      );

      return;
    }

    try {
      setBusy(true);
      setRes(null);

      const out = await query(q);

      console.log(
        "[Ask] /evidence response:",
        out
      );

      if ((out as any)?.ready === false) {
        const message =
          (out as any)?.error ||
          t(
            "ask.notReadyBody",
            "No active corpus found. Run 'Prepare corpus from text' on the Scan tab first."
          );

        Alert.alert(
          t(
            "ask.notReadyTitle",
            "Corpus not ready"
          ),
          message
        );

        setRes(null);
        return;
      }

      const chunk =
        (out as any)?.evidence_text ??
        (out as any)?.chunk;

      const hasChunk =
        typeof chunk === "string" &&
        chunk.trim().length > 0;

      if (!out || !hasChunk) {
        Alert.alert(
          t(
            "ask.noMatchTitle",
            "No match found"
          ),
          t(
            "ask.noMatchBody",
            "I could not find a relevant passage in the current corpus."
          )
        );

        setRes(null);
        return;
      }

      setRes(out as ScreenResponse);
    } catch (error: any) {
      Alert.alert(
        t(
          "ask.errorTitle",
          "Error"
        ),
        String(
          error?.message || error
        )
      );

      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleRunBenchmark(): Promise<void> {
    try {
      setBenchmarkBusy(true);
      setBenchmarkReport(null);

      const report =
        await runNormanSicilyRetrievalBenchmark();

      setBenchmarkReport(report);

      Alert.alert(
        "Benchmark completed",
        [
          `Top 1: ${formatPercentage(
            report.summary.top1Accuracy
          )}`,
          `Top 3: ${formatPercentage(
            report.summary.top3Accuracy
          )}`,
          `PASS: ${report.summary.passed}`,
          `PARTIAL: ${report.summary.partial}`,
          `FAIL: ${report.summary.failed}`,
        ].join("\n")
      );
    } catch (error: any) {
      Alert.alert(
        "Benchmark error",
        String(
          error?.message || error
        )
      );
    } finally {
      setBenchmarkBusy(false);
    }
  }

  const disabled =
    busy || benchmarkBusy;

  return (
    <ScrollView
      contentContainerStyle={{
        padding: 16,
        gap: 12,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Text
        style={{
          fontSize: 18,
          fontWeight: "600",
        }}
      >
        {t(
          "ask.screenTitle",
          "Ask the document"
        )}
      </Text>

      <TextInput
        placeholder={t(
          "ask.placeholder",
          "Type your question…"
        )}
        value={question}
        onChangeText={setQuestion}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          borderRadius: 8,
          padding: 12,
        }}
        editable={!disabled}
      />

      <TouchableOpacity
        onPress={handleAsk}
        style={{
          padding: 14,
          borderRadius: 10,
          backgroundColor: disabled
            ? "#4b7a68"
            : "#0b3d2e",
        }}
        disabled={disabled}
      >
        <Text
          style={{
            color: "white",
            textAlign: "center",
            fontWeight: "700",
          }}
        >
          {t("tabs.ask", "Ask")}
        </Text>
      </TouchableOpacity>

      {busy && (
        <View
          style={{
            paddingVertical: 16,
          }}
        >
          <ActivityIndicator />

          <Text
            style={{
              textAlign: "center",
              marginTop: 8,
            }}
          >
            {t(
              "ask.searching",
              "Searching…"
            )}
          </Text>
        </View>
      )}

      {res &&
        (() => {
          const evidenceText =
            res.evidence_text ??
            res.chunk;

          const hasChunk =
            typeof evidenceText ===
              "string" &&
            evidenceText.trim().length > 0;

          const low =
            res.low_confidence === true ||
            res.evidence_type ===
              "sentence_span";

          const guidingQuestionMismatch =
            Boolean(
              res.guiding_question
            ) &&
            norm(
              res.guiding_question
            ) !== norm(question);

          console.log(
            "[Render][Ask]",
            {
              low,
              guidingQuestionMismatch,
              hasChunk,
              questionNow: question,
              guiding:
                res.guiding_question,
            }
          );

          if (!hasChunk) {
            return null;
          }

          return (
            <View
              style={{
                gap: 8,
                marginTop: 10,
              }}
            >
              {low && (
                <View
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    backgroundColor:
                      "#fff4e5",
                    borderWidth: 1,
                    borderColor:
                      "#f0ad4e",
                  }}
                >
                  <Text
                    style={{
                      fontWeight: "600",
                    }}
                  >
                    {t(
                      "ask.lowConfidence",
                      "Low confidence – consider refining your question or preparing the corpus again."
                    )}
                  </Text>
                </View>
              )}

              <Text
                style={{
                  fontWeight: "600",
                }}
              >
                {t(
                  "ask.topPassage",
                  "Top passage"
                )}
              </Text>

              <View
                style={{
                  borderWidth: 1,
                  borderColor: "#ddd",
                  borderRadius: 8,
                }}
              >
                <Text
                  style={{
                    padding: 10,
                    lineHeight: 20,
                  }}
                >
                  {evidenceText}
                </Text>
              </View>
            </View>
          );
        })()}

      <View
        style={{
          height: 1,
          backgroundColor: "#ddd",
          marginVertical: 10,
        }}
      />

      <Text
        style={{
          fontSize: 18,
          fontWeight: "600",
        }}
      >
        Retrieval benchmark
      </Text>

      <Text
        style={{
          lineHeight: 20,
          color: "#444",
        }}
      >
        Run ten local retrieval tests
        against the active Norman Sicily
        corpus. Results are evaluated at
        Top 1 and Top 3 and saved as JSON
        and CSV.
      </Text>

      <TouchableOpacity
        onPress={handleRunBenchmark}
        style={{
          padding: 14,
          borderRadius: 10,
          backgroundColor: disabled
            ? "#777"
            : "#263238",
        }}
        disabled={disabled}
      >
        <Text
          style={{
            color: "white",
            textAlign: "center",
            fontWeight: "700",
          }}
        >
          Run benchmark
        </Text>
      </TouchableOpacity>

      {benchmarkBusy && (
        <View
          style={{
            paddingVertical: 16,
          }}
        >
          <ActivityIndicator />

          <Text
            style={{
              textAlign: "center",
              marginTop: 8,
            }}
          >
            Running local E5 retrieval
            tests…
          </Text>
        </View>
      )}

      {benchmarkReport && (
        <View
          style={{
            gap: 12,
            marginBottom: 24,
          }}
        >
          <View
            style={{
              padding: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#b0bec5",
              backgroundColor: "#eceff1",
              gap: 4,
            }}
          >
            <Text
              style={{
                fontWeight: "700",
                fontSize: 16,
              }}
            >
              Benchmark summary
            </Text>

            <Text>
              Top 1 accuracy:{" "}
              {formatPercentage(
                benchmarkReport.summary
                  .top1Accuracy
              )}
            </Text>

            <Text>
              Top 3 accuracy:{" "}
              {formatPercentage(
                benchmarkReport.summary
                  .top3Accuracy
              )}
            </Text>

            <Text>
              PASS:{" "}
              {
                benchmarkReport.summary
                  .passed
              }
            </Text>

            <Text>
              PARTIAL:{" "}
              {
                benchmarkReport.summary
                  .partial
              }
            </Text>

            <Text>
              FAIL:{" "}
              {
                benchmarkReport.summary
                  .failed
              }
            </Text>
          </View>

          {benchmarkReport.results.map(
            (result) => {
              const colours =
                benchmarkStatusColours(
                  result
                );

              const topCandidate =
                result.candidates[0];

              return (
                <View
                  key={result.id}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor:
                      colours.borderColor,
                    backgroundColor:
                      colours.backgroundColor,
                    gap: 6,
                  }}
                >
                  <Text
                    style={{
                      fontWeight: "700",
                      color:
                        colours.textColor,
                    }}
                  >
                    {benchmarkStatusLabel(
                      result
                    )}{" "}
                    · {result.category}
                  </Text>

                  <Text
                    style={{
                      fontWeight: "600",
                    }}
                  >
                    {result.question}
                  </Text>

                  <Text>
                    Expected sentences:{" "}
                    {result.expectedSentenceIds.join(
                      ", "
                    )}
                  </Text>

                  <Text>
                    Top 1 chunk:{" "}
                    {result.top1ChunkIndex}
                  </Text>

                  <Text>
                    Top 1 sentences:{" "}
                    {result.top1SentenceIds.join(
                      ", "
                    ) || "none"}
                  </Text>

                  <Text>
                    Final score:{" "}
                    {result.top1Score.toFixed(
                      4
                    )}
                  </Text>

                  <Text>
                    Semantic score:{" "}
                    {result.top1CosineScore.toFixed(
                      4
                    )}
                  </Text>

                  {topCandidate && (
                    <>
                      <Text
                        style={{
                          fontWeight: "600",
                          marginTop: 4,
                        }}
                      >
                        Retrieved guiding
                        question
                      </Text>

                      <Text>
                        {
                          topCandidate.guidingQuestion
                        }
                      </Text>

                      <Text
                        style={{
                          fontWeight: "600",
                          marginTop: 4,
                        }}
                      >
                        Retrieved summary
                      </Text>

                      <Text>
                        {topCandidate.summary}
                      </Text>
                    </>
                  )}
                </View>
              );
            }
          )}

          <View
            style={{
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: "#ddd",
              gap: 4,
            }}
          >
            <Text
              style={{
                fontWeight: "700",
              }}
            >
              Saved files
            </Text>

            <Text selectable>
              JSON:{" "}
              {
                benchmarkReport.jsonFileUri
              }
            </Text>

            <Text selectable>
              CSV:{" "}
              {
                benchmarkReport.csvFileUri
              }
            </Text>
          </View>
        </View>
      )}
    </ScrollView>
  );
}