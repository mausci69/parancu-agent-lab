import React, { useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, TextInput, Alert, ScrollView } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { pickImageAsFormData } from "../lib/imagePicker";
import { ocrExtract, prepareCorpusFromText } from "../lib/api";
import { generateSummaryLocal, generateQuestionsLocal } from "../lib/llm/localGen";

type Props = {
  /** Called when the user confirms the OCR text to use for querying */
  onProceed?: (text: string) => void;
  /** Default OCR language (e.g. "eng", "ita", "eng+ita") */
  defaultLang?: string;
};

export default function OCRScreen({ onProceed, defaultLang = "eng" }: Props) {
  const nav = useNavigation<any>();
  const { t } = useTranslation();
  const [lang, setLang] = useState<string>(defaultLang);
  const [text, setText] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  // Offline local generation state (test)
    const [offlineBusy, setOfflineBusy] = useState<boolean>(false);
    const [offlineOut, setOfflineOut] = useState<string>("");

    // Handlers for offline local generation (test)
    async function handleLocalSummary() {
      const src = text.trim();
      if (!src) {
        Alert.alert(t("ocr.offline.noTextAlertTitle"), t("ocr.offline.noTextAlertBody"));
        return;
      }
      try {
        setOfflineBusy(true);
        const out = await generateSummaryLocal(src);
        setOfflineOut(out ?? "(no summary produced)");
      } catch (e: any) {
        Alert.alert(t("ocr.offline.summaryFailTitle"), e?.message ?? String(e));
      } finally {
        setOfflineBusy(false);
      }
    }

    async function handleLocalQuestions() {
      const src = text.trim();
      if (!src) {
        Alert.alert(t("ocr.offline.noTextAlertTitle"), t("ocr.offline.noTextAlertBody"));
        return;
      }
      try {
        setOfflineBusy(true);
        const out = await generateQuestionsLocal(src);
        setOfflineOut(Array.isArray(out) ? out.join("\n• ") : String(out ?? t("ocr.offline.noQuestions")));
      } catch (e: any) {
        Alert.alert(t("ocr.offline.questionsFailTitle"), e?.message ?? String(e));
      } finally {
        setOfflineBusy(false);
      }
    }

    // Move handlers ABOVE the return; remove stray 'return (' here
    async function handlePick(source: "camera" | "library") {
      try {
        const form = await pickImageAsFormData(source);
        if (!form) return;
        setBusy(true);
        const res = await ocrExtract(form, { lang });
        if (res.error) {
          Alert.alert("OCR error", res.error);
        } else {
          setText(res.text || "");
          if (res.lang_used && res.lang_used !== lang) setLang(res.lang_used);
        }
      } catch (e: any) {
        Alert.alert("Error", String(e?.message || e));
      } finally {
        setBusy(false);
      }
    }

    async function handleProceed() {
      const cleaned = (text || "").trim();
      if (!cleaned) {
        Alert.alert("Nothing to use", "Extract text first, then proceed.");
        return;
      }
      try {
        setBusy(true);
        const res = await prepareCorpusFromText(cleaned, true, 300000);
        if (!res || res.status !== "Corpus prepared") {
          Alert.alert("Prepare failed", "Could not prepare the corpus.");
          return;
        }
        if (onProceed) {
          onProceed(cleaned);
        } else {
          nav.navigate("Query");
        }
      } catch (e: any) {
        Alert.alert("Error", String(e?.message || e));
      } finally {
        setBusy(false);
      }
    }

    return (

    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 18, fontWeight: "600" }}>OCR</Text>
      <Text style={{ opacity: 0.7 }}>
        Take a photo or choose an image, then we’ll extract text you can query.
      </Text>

      {/* Language selector (simple preset buttons for now) */}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8, marginBottom: 4 }}>
        {["eng", "ita", "eng+ita"].map((code) => (
          <TouchableOpacity
            key={code}
            onPress={() => setLang(code)}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: lang === code ? "#0b3d2e" : "#ccc",
              backgroundColor: lang === code ? "#e6f2ef" : "transparent",
            }}
          >
            <Text style={{ fontWeight: lang === code ? "700" : "400" }}>{code}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ flexDirection: "row", gap: 12 }}>
        <TouchableOpacity
          onPress={() => handlePick("camera")}
          style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: "#0b3d2e" }}
          disabled={busy}
        >
          <Text style={{ color: "white", textAlign: "center", fontWeight: "600" }}>
            {t("ocr.btn.takePhoto")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => handlePick("library")}
          style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: "#164e3f" }}
          disabled={busy}
        >
          <Text style={{ color: "white", textAlign: "center", fontWeight: "600" }}>
            {t("ocr.btn.chooseImage")}
          </Text>
        </TouchableOpacity>
      </View>

      {busy ? (
        <View style={{ paddingVertical: 20 }}>
          <ActivityIndicator />
          <Text style={{ textAlign: "center", marginTop: 8 }}>Extracting text…</Text>
        </View>
      ) : null}

      <Text style={{ marginTop: 8, fontWeight: "600" }}>Extracted text (editable)</Text>
      <View style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", borderRadius: 8, overflow: "hidden" }}>
        <ScrollView contentContainerStyle={{ padding: 10 }}>
          <TextInput
            multiline
            value={text}
            onChangeText={setText}
            placeholder="OCR text will appear here…"
            style={{ minHeight: 160, textAlignVertical: "top" }}
          />
        </ScrollView>
      </View>

      {/* Offline local generation (test) */}
      <View style={{ padding: 12, borderRadius: 12, backgroundColor: "#111", gap: 10 }}>
        <Text style={{ fontWeight: "700" }}>{t("ocr.offline.title")}</Text>
        <Text style={{ opacity: 0.7 }}>
          {t("ocr.offline.subtitle")}
        </Text>
        <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
          <TouchableOpacity
            style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: "#0b3d2e", opacity: offlineBusy ? 0.6 : 1 }}
            onPress={handleLocalSummary}
            disabled={offlineBusy}
          >
            {offlineBusy ? <ActivityIndicator /> : (
              <Text style={{ color: "white", textAlign: "center", fontWeight: "600" }}>
                {t("ocr.offline.genSummary")}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: "#164e3f", opacity: offlineBusy ? 0.6 : 1 }}
            onPress={handleLocalQuestions}
            disabled={offlineBusy}
          >
            {offlineBusy ? <ActivityIndicator /> : (
              <Text style={{ color: "white", textAlign: "center", fontWeight: "600" }}>
                {t("ocr.offline.genQuestions")}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {!!offlineOut && (
          <View style={{ marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: "#1b1b1b" }}>
            <Text style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{t("ocr.offline.outputLabel")}</Text>
            <Text>{offlineOut}</Text>
          </View>
        )}
      </View>

      <TouchableOpacity
        onPress={handleProceed}
        style={{ padding: 14, borderRadius: 10, backgroundColor: "#0b3d2e", marginTop: 8 }}
        disabled={busy}
      >
        <Text style={{ color: "white", textAlign: "center", fontWeight: "700" }}>
          Proceed to Query
        </Text>
      </TouchableOpacity>
    </View>
  );
}