// /apps/mobile/App.tsx

import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useTranslation } from "react-i18next";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import {
  prepareCorpusFromText,
  type PrepareCorpusResponse,
  type QueryResponse,
} from "./src/lib/api";
import { retrieveCandidatesFromPrepared } from "./src/local/retrieval";
import {
  extractText,
  isAvailable as isPdfTextExtractAvailable,
} from "expo-pdf-text-extract";
import MultiPageScan from "./src/features/ocr/MultiPageScan";
import "./src/i18n";
import { initLocalGen } from "./src/lib/llm/localGen";
import ToastProvider from "./src/components/Toast";
import { setOcrLang as setGlobalOcrLang } from "./src/lib/lang";
import {
  clearActiveCorpus,
  getActiveLibraryId,
  listSavedCorpora,
  loadActiveCorpus,
  markCurrentCorpusAsUnsaved,
  saveCorpusToLibrary,
  setActiveCorpusFromLibrary,
} from "./src/local/corpusStore";
import {
  clearOpenAIKey,
  hasOpenAIKey,
  saveOpenAIKey,
} from "./src/local/openaiKeyStore";

function buildCorpusName(_text: string): string {
  const now = new Date();

  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");

  return `corpus_${dd}${mm}${yyyy}_${hh}${min}`;
}

type Mode = "ask" | "upload" | "scan";
type UploadInputMode = "manual" | "pdf" | null;

const manualTextAccessoryId = "manual-text-keyboard-accessory";
const askTextAccessoryId = "ask-text-keyboard-accessory";

let didClearActiveCorpusOnLaunch = false;

export default function App() {
  const { t, i18n } = useTranslation();

  const [mode, setMode] = useState<Mode>("ask");
  const [ocrLang, setOcrLangState] = useState<"en" | "it">("en");

  const [question, setQuestion] = useState("");
  const [semanticWeight, setSemanticWeight] = useState(0.65);
  const [sliderTrackWidth, setSliderTrackWidth] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0);
  const [candidatePickerOpen, setCandidatePickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [manualText, setManualText] = useState("");
  const [pdfText, setPdfText] = useState("");
  const [selectedPdfName, setSelectedPdfName] = useState<string | null>(null);
  const [uploadInputMode, setUploadInputMode] =
    useState<UploadInputMode>(null);

  const [prepBusy, setPrepBusy] = useState(false);
  const [prepMsg, setPrepMsg] = useState<string | null>(null);

  const [savedCorpusPickerOpen, setSavedCorpusPickerOpen] = useState(false);
  const [manageCorpusOpen, setManageCorpusOpen] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [corpusInfoOpen, setCorpusInfoOpen] = useState(false);

  const [savedCorpora, setSavedCorpora] = useState<
    Array<{ id: string; name: string; savedAt?: string }>
  >([]);

  const [hasActiveCorpus, setHasActiveCorpus] = useState(false);
  const [activeCorpusName, setActiveCorpusName] =
    useState<string>("No active corpus");
  const [activeCorpusChunks, setActiveCorpusChunks] = useState<number | null>(
    null
  );
  const [activeCorpusReady, setActiveCorpusReady] = useState(false);
  const [uploadCorpusPrepared, setUploadCorpusPrepared] = useState(false);
  const [openAIKeyReady, setOpenAIKeyReady] = useState(false);

  const activeDraftText =
    uploadInputMode === "manual"
      ? manualText
      : uploadInputMode === "pdf"
        ? pdfText
        : "";

  const activeDraftLabel =
    uploadInputMode === "manual"
      ? "Manual text"
      : selectedPdfName || "PDF selected";

  const activeDraftReady = activeDraftText.trim().length >= 20;

  function resetDraftWorkspace() {
    setManualText("");
    setPdfText("");
    setSelectedPdfName(null);
    setUploadInputMode(null);
    setUploadCorpusPrepared(false);
    setPrepMsg(null);
  }

  const setOcrLang = async (lang: "en" | "it") => {
    if (ocrLang === lang) return;

    setOcrLangState(lang);
    await setGlobalOcrLang(lang);
    await i18n.changeLanguage(lang);
  };

  async function refreshOpenAIKeyState() {
    const ok = await hasOpenAIKey();
    setOpenAIKeyReady(ok);
  }

  useEffect(() => {
    initLocalGen({
      mode: { kind: "stub" },
      defaultSummary: { maxSentences: 2 },
      defaultQuestions: { count: 1, language: "en" },
    });

    (async () => {
      const lang = i18n.language?.slice(0, 2) === "it" ? "it" : "en";

      setOcrLangState(lang);
      await setGlobalOcrLang(lang);
      await refreshOpenAIKeyState();
    })();
  }, [i18n.language]);

  async function refreshActiveCorpusState() {
    try {
      const active = await loadActiveCorpus();

      if (!active) {
        setHasActiveCorpus(false);
        setActiveCorpusName("No active corpus");
        setActiveCorpusChunks(null);
        setActiveCorpusReady(false);
        return;
      }

      const activeLibraryId = await getActiveLibraryId();
      const saved = await listSavedCorpora();
      const savedMeta = saved.find((item) => item.id === activeLibraryId);

      const chunks = Array.isArray((active as any).chunks)
        ? (active as any).chunks.length
        : null;

      setHasActiveCorpus(true);
      setActiveCorpusName(savedMeta?.name || "Unsaved corpus");
      setActiveCorpusChunks(chunks);
      setActiveCorpusReady(true);
    } catch {
      setHasActiveCorpus(false);
      setActiveCorpusName("No active corpus");
      setActiveCorpusChunks(null);
      setActiveCorpusReady(false);
    }
  }

  useEffect(() => {
    (async () => {
      if (!didClearActiveCorpusOnLaunch) {
        didClearActiveCorpusOnLaunch = true;
        await clearActiveCorpus();
      }

      await refreshActiveCorpusState();
      await refreshOpenAIKeyState();
    })();
  }, []);

  async function onAsk() {
    const q = question.trim();

    if (!q) return;

    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const activeCorpus = await loadActiveCorpus();

      if (!activeCorpus) {
        const msg = t(
          "ask.notReadyBody",
          "No active corpus found. Run 'Prepare corpus from text' on the Upload or Scan tab first."
        );

        Alert.alert(t("ask.notReadyTitle", "Corpus not ready"), msg);
        setResult(null);
        return;
      }

      const candidates = await retrieveCandidatesFromPrepared(
        q,
        activeCorpus as any,
        5,
        { semanticWeight }
      );

      console.log("[App/Ask] local retrieval candidates:", candidates);
      console.log("[App/Ask] semantic-anchor balance:", semanticAnchorLabel);

      const top = candidates[0];
      const hasChunk = !!top?.chunk && String(top.chunk).trim().length > 0;

      if (!hasChunk) {
        Alert.alert(
          t("ask.noMatchTitle", "No match found"),
          t(
            "ask.noMatchBody",
            "I could not find a relevant passage in the current corpus."
          )
        );

        setResult(null);
        return;
      }

      const data = {
        ready: true,
        chunk_index: top.chunk_index,
        guiding_question: top.guiding_question,
        answer_focus: "",
        chunk: top.chunk,
        summary: top.summary,
        sentence_ids: top.sentence_ids,
        score: top.score,
        cosine_score: top.cosine_score,
        candidates: candidates.map((candidate) => ({
          ...candidate,
          answer_focus: "",
        })),
      } as any as QueryResponse;

      setSelectedCandidateIndex(0);
      setResult(data);
    } catch (e: any) {
      console.error("[App/Ask] error:", e);

      const msg =
        e?.message || t("common.error.requestFailed", "Request failed.");

      setError(msg);
      Alert.alert(t("ask.failedTitle", "Ask failed"), msg);
    } finally {
      setBusy(false);
    }
  }

  async function onPrepare() {
    if (hasActiveCorpus) {
      Alert.alert(
        "Active corpus exists",
        "Clear the active corpus before adding new content."
      );
      return;
    }

    const txt = activeDraftText.trim();

    if (txt.length < 20) {
      setPrepMsg(
        t("upload.tooShort", "Text too short. Paste a few sentences at least.")
      );
      return;
    }

    setPrepBusy(true);
    setPrepMsg(null);
    setSavedCorpusPickerOpen(false);

    try {
      const data: PrepareCorpusResponse = await prepareCorpusFromText(
        txt,
        60000,
        undefined,
        { corpusLanguage: ocrLang }
      );

      console.log("[App/Upload] /prepare_corpus response:", data);

      if (!data.ready) {
        const msg =
          data.message ||
          t(
            "upload.prepareFailed",
            "Prepare failed. Please check the text and try again."
          );

        setPrepMsg(msg);
        Alert.alert(t("upload.prepareFailedTitle", "Prepare failed"), msg);
        await refreshActiveCorpusState();
        return;
      }

      await markCurrentCorpusAsUnsaved();

      resetDraftWorkspace();
      await refreshActiveCorpusState();

      const chunksLabel =
        typeof data.chunks === "number" ? ` (chunks: ${data.chunks})` : "";

      const msg =
        data.message ||
        t("upload.prepared", "Prepared successfully{{chunks}}", {
          chunks: chunksLabel,
        });

      Alert.alert(msg);
    } catch (e: any) {
      const msg = e?.message || t("upload.prepareFailed", "Prepare failed.");

      setPrepMsg(msg);
      Alert.alert(t("upload.prepareFailedTitle", "Prepare failed"), msg);
      await refreshActiveCorpusState();
    } finally {
      setPrepBusy(false);
    }
  }

  async function askCorpusName(defaultName: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (Platform.OS === "ios" && Alert.prompt) {
        Alert.prompt(
          t("scan.saveNameTitle", "Save corpus"),
          t("scan.saveNameMessage", "Choose a name for this corpus."),
          [
            {
              text: t("common.cancel", "Cancel"),
              style: "cancel",
              onPress: () => resolve(null),
            },
            {
              text: t("common.save", "Save"),
              onPress: (value) => {
                const name = String(value || "").trim();
                resolve(name || null);
              },
            },
          ],
          "plain-text",
          defaultName
        );

        return;
      }

      resolve(defaultName);
    });
  }

  async function askOpenAIKey(): Promise<string | null> {
    await Linking.openURL("https://platform.openai.com/api-keys");

    return new Promise((resolve) => {
      if (Platform.OS === "ios" && Alert.prompt) {
        Alert.prompt(
          "OpenAI API key",
          "Paste your OpenAI API key. It will be stored locally on this device.",
          [
            {
              text: "Cancel",
              style: "cancel",
              onPress: () => resolve(null),
            },
            {
              text: "Save",
              onPress: (value) => {
                const key = String(value || "").trim();
                resolve(key || null);
              },
            },
          ],
          "secure-text"
        );

        return;
      }

      Alert.alert(
        "OpenAI API key",
        "Key entry is currently available through the iOS prompt."
      );
      resolve(null);
    });
  }

  async function onSaveOpenAIKey() {
    setPrepBusy(true);
    setPrepMsg(null);

    try {
      const key = await askOpenAIKey();

      if (!key) {
        setPrepMsg("OpenAI key setup cancelled.");
        return;
      }

      await saveOpenAIKey(key);
      await refreshOpenAIKeyState();

      Alert.alert("OpenAI key saved", "ParancU can now prepare corpora.");
    } catch (e: any) {
      const msg = e?.message || "Could not save OpenAI key.";

      setPrepMsg(msg);
      Alert.alert("OpenAI key setup failed", msg);
    } finally {
      setPrepBusy(false);
    }
  }

  async function onClearOpenAIKey() {
    Alert.alert(
      "Remove OpenAI key?",
      "ParancU will no longer be able to prepare new corpora until you add a key again.",
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setPrepBusy(true);
            setPrepMsg(null);

            try {
              await clearOpenAIKey();
              await refreshOpenAIKeyState();

              Alert.alert("OpenAI key removed");
            } catch (e: any) {
              const msg = e?.message || "Could not remove OpenAI key.";

              setPrepMsg(msg);
              Alert.alert("OpenAI key removal failed", msg);
            } finally {
              setPrepBusy(false);
            }
          },
        },
      ]
    );
  }

  async function onSaveCurrentCorpus() {
    setPrepBusy(true);
    setPrepMsg(null);
    setSavedCorpusPickerOpen(false);

    try {
      const active = await loadActiveCorpus();

      if (!active) {
        await refreshActiveCorpusState();

        const msg = t(
          "scan.noActiveCorpusToSave",
          "No active prepared corpus to save."
        );

        setPrepMsg(msg);
        Alert.alert(msg);
        return;
      }

      const activeLibraryId = await getActiveLibraryId();
      const id = activeLibraryId || `corpus-${Date.now()}`;

      const saved = await listSavedCorpora();
      const existingMeta = saved.find((item) => item.id === id);
      const defaultName = buildCorpusName(activeDraftText);
      const name = await askCorpusName(existingMeta?.name || defaultName);

      if (!name) {
        setPrepMsg(t("scan.saveCancelled", "Save cancelled."));
        return;
      }

      await saveCorpusToLibrary({
        id,
        name,
        corpus: active,
      });

      await setActiveCorpusFromLibrary(id);
      resetDraftWorkspace();
      await refreshActiveCorpusState();

      const msg = t("scan.savedCorpusShort", "Prepared corpus saved: {{name}}", {
        name,
      });

      Alert.alert(msg);
    } catch (e: any) {
      const msg = e?.message || t("scan.saveFailed", "Save failed.");

      setPrepMsg(msg);
      Alert.alert(t("scan.saveFailedTitle", "Save failed"), msg);
      await refreshActiveCorpusState();
    } finally {
      setPrepBusy(false);
    }
  }

  async function onLoadLatestSavedCorpus() {
    setPrepBusy(true);
    setPrepMsg(null);

    try {
      const rawSaved = await listSavedCorpora();

      console.log("[App/LoadCorpus] saved corpora count:", rawSaved.length);
      console.log(
        "[App/LoadCorpus] saved corpora index:",
        JSON.stringify(rawSaved, null, 2)
      );

      const saved = rawSaved.sort((a, b) =>
        String(b.savedAt || "").localeCompare(String(a.savedAt || ""))
      );

      setSavedCorpora(saved);

      if (!saved.length) {
        const msg = t("scan.noSavedCorpus", "No saved prepared corpus found.");

        setSavedCorpusPickerOpen(false);
        setPrepMsg(msg);
        Alert.alert(msg);
        return;
      }

      setSavedCorpusPickerOpen(true);
    } catch (e: any) {
      const msg = e?.message || t("scan.loadFailed", "Load failed.");

      setSavedCorpusPickerOpen(false);
      setPrepMsg(msg);
      Alert.alert(t("scan.loadFailedTitle", "Load failed"), msg);
    } finally {
      setPrepBusy(false);
    }
  }

  async function onSelectSavedCorpus(item: { id: string; name: string }) {
    setPrepBusy(true);
    setPrepMsg(null);

    try {
      const ok = await setActiveCorpusFromLibrary(item.id);

      if (!ok) {
        await refreshActiveCorpusState();

        const msg = t("scan.loadFailed", "Load failed.");

        setPrepMsg(msg);
        Alert.alert(t("scan.loadFailedTitle", "Load failed"), msg);
        return;
      }

      resetDraftWorkspace();
      setSavedCorpora([]);
      setSavedCorpusPickerOpen(false);
      setManageCorpusOpen(false);

      await refreshActiveCorpusState();
    } catch (e: any) {
      const msg = e?.message || t("scan.loadFailed", "Load failed.");

      setPrepMsg(msg);
      Alert.alert(t("scan.loadFailedTitle", "Load failed"), msg);
      await refreshActiveCorpusState();
    } finally {
      setPrepBusy(false);
    }
  }

  async function onImportCorpus() {
    setPrepBusy(true);
    setPrepMsg(null);
    setSavedCorpusPickerOpen(false);

    try {
      const DocumentPickerModule: any = await import("expo-document-picker");

      const DocumentPicker =
        DocumentPickerModule.default ?? DocumentPickerModule;

      const picked = await DocumentPicker.getDocumentAsync({
        type: "application/json",
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (picked.canceled) {
        return;
      }

      const file = picked.assets?.[0];

      if (!file?.uri) {
        throw new Error("No JSON file selected.");
      }

      const raw = await FileSystem.readAsStringAsync(file.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      const parsed = JSON.parse(raw);

      const isValidCorpus =
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.docId === "string" &&
        Array.isArray(parsed.sentences) &&
        Array.isArray(parsed.chunks) &&
        parsed.chunks.every(
          (chunk: any) =>
            chunk &&
            typeof chunk === "object" &&
            typeof chunk.text === "string" &&
            Array.isArray(chunk.sentence_ids)
        );

      if (!isValidCorpus) {
        throw new Error("This JSON file is not a valid ParancU corpus.");
      }

      const defaultName =
        file.name?.replace(/\.json$/i, "") || buildCorpusName("");

      const name = await askCorpusName(defaultName);

      if (!name) {
        setPrepMsg("Import cancelled.");
        return;
      }

      const id = `corpus-${Date.now()}`;

      await saveCorpusToLibrary({
        id,
        name,
        corpus: parsed,
      });

      await setActiveCorpusFromLibrary(id);

      resetDraftWorkspace();
      setManageCorpusOpen(false);

      await refreshActiveCorpusState();

      const msg = `Imported corpus: ${name}`;

      Alert.alert("Import complete", msg);
    } catch (e: any) {
      const msg = e?.message || "Import failed.";

      setPrepMsg(msg);
      Alert.alert("Import failed", msg);
      await refreshActiveCorpusState();
    } finally {
      setPrepBusy(false);
    }
  }

  async function onExportActiveCorpus() {
    setPrepBusy(true);
    setPrepMsg(null);
    setSavedCorpusPickerOpen(false);

    try {
      const active = await loadActiveCorpus();

      if (!active) {
        await refreshActiveCorpusState();

        const msg = "No active prepared corpus to export.";

        setPrepMsg(msg);
        Alert.alert(msg);
        return;
      }

      const fileName = `${buildCorpusName("")}.json`;
      const fileUri = `${FileSystem.documentDirectory}${fileName}`;

      await FileSystem.writeAsStringAsync(
        fileUri,
        JSON.stringify(active, null, 2)
      );

      const canShare = await Sharing.isAvailableAsync();

      if (!canShare) {
        const msg = `Corpus exported here: ${fileUri}`;

        setPrepMsg(msg);
        Alert.alert("Export complete", msg);
        return;
      }

      await Sharing.shareAsync(fileUri, {
        mimeType: "application/json",
        dialogTitle: "Export ParancU corpus",
        UTI: "public.json",
      });

      setPrepMsg(`Corpus exported: ${fileName}`);
      setManageCorpusOpen(false);
    } catch (e: any) {
      const msg = e?.message || "Export failed.";

      setPrepMsg(msg);
      Alert.alert("Export failed", msg);
      await refreshActiveCorpusState();
    } finally {
      setPrepBusy(false);
    }
  }

  async function onClear() {
    setPrepBusy(true);
    setPrepMsg(null);
    setSavedCorpusPickerOpen(false);

    try {
      await clearActiveCorpus();

      resetDraftWorkspace();
      setSelectedCandidateIndex(0);
      setResult(null);
      setError(null);
      setManageCorpusOpen(false);
      setCorpusInfoOpen(false);

      await refreshActiveCorpusState();
    } catch (e: any) {
      const msg = e?.message || t("upload.clearFailed", "Clear failed.");

      setPrepMsg(msg);
      Alert.alert(t("upload.clearFailedTitle", "Clear failed"), msg);
      await refreshActiveCorpusState();
    } finally {
      setPrepBusy(false);
    }
  }

  async function importPdfText(uri: string): Promise<string> {
    if (!isPdfTextExtractAvailable()) {
      throw new Error("PDF import is not available in this build.");
    }

    const importedText = await extractText(uri);
    const cleaned = String(importedText || "").trim();

    if (cleaned.length < 20) {
      throw new Error(
        "No usable text found in this PDF. If it is a scanned PDF, use Scan/OCR instead."
      );
    }

    return cleaned;
  }

  const askButtonDisabled = busy || !question.trim();

  const corpusStatus = hasActiveCorpus
    ? `${activeCorpusChunks ?? "—"} chunks · ${
        activeCorpusReady ? "embeddings ready" : "not ready"
      }`
    : "No active corpus";

  const openAIKeyStatus = openAIKeyReady ? "OpenAI key saved" : "No OpenAI key";
  const anchorWeight = 1 - semanticWeight;

  const semanticAnchorLabel = `${Math.round(
    semanticWeight * 100
  )}/${Math.round(anchorWeight * 100)}`;

  function setSemanticWeightFromTrack(locationX: number) {
    const raw = locationX / sliderTrackWidth;
    const snapped = Math.round(raw / 0.05) * 0.05;
    const clamped = Math.min(Math.max(snapped, 0), 1);
    const nextSemanticWeight = Number(clamped.toFixed(2));

    setSemanticWeight(nextSemanticWeight);
    setResult(null);
    setSelectedCandidateIndex(0);
    setCandidatePickerOpen(false);
  }

  const sliderProgress = semanticWeight;

  const sliderPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !busy,
        onMoveShouldSetPanResponder: () => !busy,
        onPanResponderGrant: (event) => {
          setSemanticWeightFromTrack(event.nativeEvent.locationX);
        },
        onPanResponderMove: (event) => {
          setSemanticWeightFromTrack(event.nativeEvent.locationX);
        },
      }),
    [busy, sliderTrackWidth]
  );

  return (
    <ToastProvider>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.select({
          ios: "padding",
          android: undefined,
        })}
      >
        <StatusBar style="light" />

        <View style={styles.headerRow}>
          <Text style={styles.title}>
            {t("app.title", "ParancU")}
          </Text>

          <TouchableOpacity
            style={styles.langPill}
            onPress={() => setLanguagePickerOpen(true)}
            disabled={prepBusy}
          >
            <Text style={styles.langPillText}>{ocrLang.toUpperCase()}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.tabs}>
          <TouchableOpacity
            style={[styles.tab, mode === "ask" && styles.tabActive]}
            onPress={() => setMode("ask")}
            disabled={mode === "ask"}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === "ask" }}
          >
            <Text
              style={[styles.tabText, mode === "ask" && styles.tabTextActive]}
            >
              💬 {t("tabs.ask", "Ask")}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, mode === "upload" && styles.tabActive]}
            onPress={() => setMode("upload")}
            disabled={mode === "upload"}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === "upload" }}
          >
            <Text
              style={[
                styles.tabText,
                mode === "upload" && styles.tabTextActive,
              ]}
            >
              ☁️ {t("tabs.uploadText", "Upload")}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, mode === "scan" && styles.tabActive]}
            onPress={() => setMode("scan")}
            disabled={mode === "scan"}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === "scan" }}
          >
            <Text
              style={[styles.tabText, mode === "scan" && styles.tabTextActive]}
            >
              📷 {t("tabs.scanPdf", "Scan")}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.corpusRow}>
          <TouchableOpacity
            style={styles.corpusMeta}
            onPress={() => setCorpusInfoOpen(true)}
            activeOpacity={0.75}
          >
            <Text style={styles.corpusIcon}>▣</Text>

            <Text style={styles.corpusName} numberOfLines={1}>
              {activeCorpusName}
            </Text>

            {hasActiveCorpus ? <Text style={styles.corpusCheck}>✓</Text> : null}

            <Text style={styles.corpusStatus} numberOfLines={1}>
              · {corpusStatus}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.manageButton}
            onPress={() => {
              setSavedCorpusPickerOpen(false);
              setManageCorpusOpen(true);
            }}
            disabled={prepBusy}
          >
            <Text style={styles.manageButtonText}>⚙ Manage corpus</Text>
          </TouchableOpacity>
        </View>

        <View style={mode === "ask" ? styles.visiblePanel : styles.hiddenPanel}>
          <ScrollView
            style={styles.askScroll}
            contentContainerStyle={styles.askScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            <View style={styles.tabPanel}>
              <View style={styles.sliderCard}>
                <View style={styles.sliderHeaderRow}>
                  <Text style={styles.sliderTitle}>
                    {i18n.language?.slice(0, 2) === "it"
                      ? "Rapporto semantico-lessicale"
                      : "Semantic-Lexical Ratio"}
                  </Text>

                  <Text style={styles.sliderValue}>
                    {semanticAnchorLabel}
                  </Text>
                </View>

                <View style={styles.semanticSliderRow}>
                <View
                  style={styles.semanticSliderTrack}
                  onLayout={(event) => {
                    setSliderTrackWidth(event.nativeEvent.layout.width || 1);
                  }}
                  {...sliderPanResponder.panHandlers}
                >
                  <View
                    style={[
                      styles.semanticSliderFill,
                      { width: `${sliderProgress * 100}%` },
                    ]}
                  />

                  <View
                    style={[
                      styles.semanticSliderThumb,
                      { left: `${sliderProgress * 100}%` },
                    ]}
                  />
                </View>
                </View>
              </View>

              <Text style={styles.tabTitle}>
                {t("ask.yourQuestion", "Your question")}
              </Text>

            <View style={{ position: "relative" }}>
              <TextInput
                style={[styles.input, { paddingRight: 44 }]}
                placeholder={t("ask.placeholder", "Type your question…")}
                placeholderTextColor="#8aa59d"
                value={question}
                onChangeText={setQuestion}
                editable={!busy}
                inputAccessoryViewID={
                  Platform.OS === "ios" ? askTextAccessoryId : undefined
                }
                returnKeyType="send"
                onSubmitEditing={() => {
                  onAsk();
                  Keyboard.dismiss();
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />

              {!!question.trim() && (
                <TouchableOpacity
                  onPress={() => {
                    setQuestion("");
                    setSelectedCandidateIndex(0);
                    setResult(null);
                    setError(null);
                  }}
                  disabled={busy}
                  style={{
                    position: "absolute",
                    right: 10,
                    top: 9,
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "rgba(255, 255, 255, 0.12)",
                  }}
                >
                  <Text
                    style={{
                      color: "#dffcf2",
                      fontSize: 18,
                      fontWeight: "900",
                      lineHeight: 20,
                    }}
                  >
                    ×
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {Platform.OS === "ios" ? (
              <InputAccessoryView nativeID={askTextAccessoryId}>
                <View style={styles.keyboardAccessory}>
                  <TouchableOpacity
                    style={styles.keyboardAccessoryButton}
                    onPress={Keyboard.dismiss}
                    disabled={busy}
                  >
                    <Text style={styles.keyboardAccessoryButtonText}>
                      Done
                    </Text>
                  </TouchableOpacity>
                </View>
              </InputAccessoryView>
            ) : null}

            <TouchableOpacity
              style={[styles.button, askButtonDisabled && styles.buttonDisabled]}
              onPress={onAsk}
              disabled={askButtonDisabled}
            >
              {busy ? (
                <ActivityIndicator />
              ) : (
                <Text style={styles.buttonText}>
                  ✧ {t("ask.retrieve", "Retrieve best chunk")}
                </Text>
              )}
            </TouchableOpacity>

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          {(() => {
            if (!result) return null;

            const candidates = Array.isArray(result.candidates)
              ? result.candidates
              : [];

            const safeSelectedCandidateIndex =
              candidates.length > 0
                ? Math.min(selectedCandidateIndex, candidates.length - 1)
                : 0;

            const selectedCandidate =
              candidates.length > 0
                ? candidates[safeSelectedCandidateIndex]
                : result;

            const hasChunk =
              !!selectedCandidate.chunk &&
              String(selectedCandidate.chunk).trim().length > 0;

            const low = result.low_confidence === true;

            const badScore =
              typeof selectedCandidate.score === "number" &&
              selectedCandidate.score < 0;

            if (!hasChunk || badScore) {
              return null;
            }

            return (
              <View style={{ marginTop: 8, gap: 8 }}>
                {low ? (
                  <View
                    style={{
                      backgroundColor: "#fff4e5",
                      borderColor: "#f0ad4e",
                      borderWidth: 1,
                      borderRadius: 10,
                      padding: 10,
                    }}
                  >
                    <Text style={{ color: "#3d2f1b", fontWeight: "700" }}>
                      {t(
                        "ask.lowConfidence",
                        "Low confidence – consider refining your question or preparing the corpus again."
                      )}
                    </Text>
                  </View>
                ) : null}

                <View style={styles.cardLarge}>
                  {candidates.length > 1 ? (
                    <>
                      <Text style={styles.sectionTitle}>
                        {t("ask.candidatePassages", "Candidate passages")}
                      </Text>

                      <TouchableOpacity
                        activeOpacity={0.85}
                        style={styles.candidatePickerButton}
                        onPress={() => setCandidatePickerOpen(true)}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.candidatePickerLabel}>
                            {t("ask.selectedCandidate", "Selected candidate")}{" "}
                            {safeSelectedCandidateIndex + 1}/{candidates.length}
                          </Text>

                          <Text
                            style={styles.candidatePickerValue}
                            numberOfLines={1}
                          >
                            {typeof selectedCandidate.score === "number"
                              ? `${selectedCandidate.score.toFixed(3)} · `
                              : ""}
                            {selectedCandidate.guiding_question ||
                              t("ask.candidate", "Candidate")}
                          </Text>
                        </View>

                        <Text style={styles.candidatePickerChevron}>⌄</Text>
                      </TouchableOpacity>

                      <Modal
                        visible={candidatePickerOpen}
                        transparent
                        animationType="fade"
                        onRequestClose={() => setCandidatePickerOpen(false)}
                      >
                        <Pressable
                          style={styles.candidatePickerBackdrop}
                          onPress={() => setCandidatePickerOpen(false)}
                        />

                        <View style={styles.candidatePickerMenu}>
                          <Text style={styles.candidatePickerTitle}>
                            {t("ask.chooseCandidate", "Choose candidate")}
                          </Text>

                          <ScrollView
                            style={styles.candidatePickerList}
                            showsVerticalScrollIndicator
                          >
                            {candidates.slice(0, 5).map((candidate, index) => {
                              const selected =
                                index === safeSelectedCandidateIndex;

                              return (
                                <TouchableOpacity
                                  key={`${candidate.chunk_index}-${index}`}
                                  activeOpacity={0.85}
                                  style={[
                                    styles.candidatePickerOption,
                                    selected &&
                                      styles.candidatePickerOptionSelected,
                                  ]}
                                  onPress={() => {
                                    setSelectedCandidateIndex(index);
                                    setCandidatePickerOpen(false);
                                  }}
                                >
                                  <Text
                                    style={[
                                      styles.candidatePickerOptionText,
                                      selected &&
                                        styles.candidatePickerOptionTextSelected,
                                    ]}
                                    numberOfLines={2}
                                  >
                                    {typeof candidate.score === "number"
                                      ? `${candidate.score.toFixed(3)} · `
                                      : ""}
                                    {candidate.guiding_question ||
                                      t("ask.candidate", "Candidate")}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </ScrollView>
                        </View>
                      </Modal>
                    </>
                  ) : null}

                  {selectedCandidate.guiding_question ? (
                    <>
                      <Text style={styles.sectionTitle}>
                        {t("ask.guidingQuestion", "Guiding question")}
                      </Text>

                      <Text style={styles.chunkText}>
                        {selectedCandidate.guiding_question}
                      </Text>
                    </>
                  ) : null}

                  {selectedCandidate.summary ? (
                    <>
                      <Text style={[styles.sectionTitle, { marginTop: 8 }]}>
                        {t("ask.summary", "Summary")}
                      </Text>

                      <Text style={styles.chunkText}>
                        {selectedCandidate.summary}
                      </Text>
                    </>
                  ) : null}

                  <Text style={[styles.sectionTitle, { marginTop: 8 }]}>
                    {t("ask.topPassage", "Selected passage")}
                  </Text>

                  <ScrollView
                    style={styles.chunkBox}
                    contentContainerStyle={styles.chunkBoxContent}
                    nestedScrollEnabled
                    showsVerticalScrollIndicator
                  >
                    <Text style={styles.chunkText}>
                      {selectedCandidate.chunk}
                    </Text>
                  </ScrollView>

                  {typeof selectedCandidate.score === "number" ? (
                    <Text style={styles.muted}>
                      {t("ask.scoreLabel", "Score")}:{" "}
                      {selectedCandidate.score.toFixed(4)} · Semantic:{" "}
                      {typeof selectedCandidate.cosine_score === "number"
                        ? Number(selectedCandidate.cosine_score).toFixed(4)
                        : "—"}{" "}
                      · Balance: {semanticAnchorLabel}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })()}
          </ScrollView>
        </View>

        <View
          style={mode === "upload" ? styles.visiblePanel : styles.hiddenPanel}
        >
          <ScrollView
            style={styles.uploadScroll}
            contentContainerStyle={styles.uploadScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {hasActiveCorpus ? (
              <View style={styles.lockedPanel}>
                <Text style={styles.lockedTitle}>Active corpus loaded</Text>

                <Text style={styles.lockedText}>
                  Clear the active corpus before adding new text or importing a
                  PDF.
                </Text>
              </View>
            ) : (
              <View style={styles.tabPanel}>
                <Text style={styles.tabTitle}>
                  {t("upload.pasteLabel", "Paste text to index")}
                </Text>

                <View style={styles.uploadChoiceRow}>
                  <TouchableOpacity
                    style={[
                      styles.uploadChoiceButton,
                      prepBusy && styles.buttonDisabled,
                    ]}
                    onPress={() => {
                      setUploadInputMode("manual");
                      setUploadCorpusPrepared(false);
                      setPrepMsg(null);
                    }}
                    disabled={prepBusy}
                  >
                    <Text style={styles.uploadChoiceIcon}>✍️</Text>
                    <Text style={styles.uploadChoiceLabel}>Paste text</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.uploadChoiceButton,
                      prepBusy && styles.buttonDisabled,
                    ]}
                     onPress={async () => {
                      Keyboard.dismiss();
                      setPrepMsg(null);

                      try {
                        const DocumentPickerModule: any = await import(
                          "expo-document-picker"
                        );

                        const DocumentPicker =
                          DocumentPickerModule.default ?? DocumentPickerModule;

                        const pickerResult =
                          await DocumentPicker.getDocumentAsync({
                            type: "*/*",
                            copyToCacheDirectory: true,
                            multiple: false,
                          });

                        if (pickerResult.canceled) {
                          return;
                        }

                        const pdf = pickerResult.assets?.[0];

                        if (!pdf?.uri) {
                          Alert.alert(
                            "PDF import failed",
                            "No file URI was returned by the document picker."
                          );
                          return;
                        }

                        const name = pdf.name || "document.pdf";

                        if (!name.toLowerCase().endsWith(".pdf")) {
                          Alert.alert(
                            "PDF import failed",
                            `Selected file is not a PDF: ${name}`
                          );
                          return;
                        }

                        let importedText = "";

                        try {
                          importedText = await importPdfText(pdf.uri);
                        } catch (extractError: any) {
                          console.error("[PDF TEXT EXTRACTION FAILED]", {
                            name,
                            uri: pdf.uri,
                            error: String(
                              extractError?.message ?? extractError
                            ),
                          });

                          Alert.alert(
                            "PDF text extraction failed",
                            String(extractError?.message ?? extractError)
                          );
                          return;
                        }

                        if (!importedText.trim()) {
                          Alert.alert(
                            "PDF text extraction failed",
                            "The PDF was selected, but no text was extracted."
                          );
                          return;
                        }

                        setUploadInputMode("pdf");
                        setSelectedPdfName(name);
                        setPdfText(importedText);
                        setUploadCorpusPrepared(false);

                        Alert.alert("PDF imported", `Selected: ${name}`);
                      } catch (pickerError: any) {
                        console.error("[PDF PICKER FAILED]", {
                          error: String(pickerError?.message ?? pickerError),
                        });

                        Alert.alert(
                          "PDF picker failed",
                          String(pickerError?.message ?? pickerError)
                        );
                      }
                    }}
                    disabled={prepBusy}
                  >
                    <Text style={styles.uploadChoiceIcon}>📄</Text>
                    <Text style={styles.uploadChoiceLabel}>Import PDF</Text>
                  </TouchableOpacity>
                </View>

                {uploadInputMode === "manual" && (
                  <>
                    <View style={{ position: "relative" }}>
                      <ScrollView
                        style={styles.chunkBox}
                        keyboardShouldPersistTaps="handled"
                      >
                        <TextInput
                          style={[
                            styles.chunkText,
                            styles.textArea,
                            { paddingRight: 36 },
                          ]}
                          multiline
                          value={manualText}
                          onChangeText={(value) => {
                            setManualText(value);
                            setUploadCorpusPrepared(false);
                          }}
                          placeholder={t(
                            "upload.placeholder",
                            "Paste content here…"
                          )}
                          placeholderTextColor="#8aa59d"
                          editable={!prepBusy}
                          inputAccessoryViewID={
                            Platform.OS === "ios"
                              ? manualTextAccessoryId
                              : undefined
                          }
                        />
                      </ScrollView>

                      {!!manualText.trim() && (
                        <TouchableOpacity
                          onPress={() => {
                            setManualText("");
                            setUploadCorpusPrepared(false);
                            setPrepMsg(null);
                          }}
                          disabled={prepBusy}
                          style={{
                            position: "absolute",
                            right: 10,
                            top: 10,
                            width: 28,
                            height: 28,
                            borderRadius: 14,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: "rgba(255, 255, 255, 0.12)",
                          }}
                        >
                          <Text
                            style={{
                              color: "#dffcf2",
                              fontSize: 18,
                              fontWeight: "900",
                              lineHeight: 20,
                            }}
                          >
                            ×
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {Platform.OS === "ios" ? (
                      <InputAccessoryView nativeID={manualTextAccessoryId}>
                        <View style={styles.keyboardAccessory}>
                          <TouchableOpacity
                            style={styles.keyboardAccessoryButton}
                            onPress={Keyboard.dismiss}
                            disabled={prepBusy}
                          >
                            <Text style={styles.keyboardAccessoryButtonText}>
                              Done
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </InputAccessoryView>
                    ) : (
                      <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={Keyboard.dismiss}
                        disabled={prepBusy}
                      >
                        <Text style={styles.secondaryButtonText}>Done</Text>
                      </TouchableOpacity>
                    )}

                    {!!manualText.trim() && !uploadCorpusPrepared && (
                      <View style={styles.chunkBox}>
                        <Text style={styles.muted}>
                          Draft content: {activeDraftLabel}
                        </Text>

                        <Text style={[styles.muted, { marginTop: 8 }]}>
                          {activeDraftReady
                            ? "Not active yet. Prepare Corpus to ask."
                            : "Text too short. Paste a few sentences to continue."}
                        </Text>
                      </View>
                    )}
                  </>
                )}

                {uploadInputMode === "pdf" && !uploadCorpusPrepared && (
                  <View style={styles.chunkBox}>
                    <Text style={styles.muted}>
                      Draft content: {activeDraftLabel}
                    </Text>

                    <Text style={[styles.muted, { marginTop: 8 }]}>
                      {activeDraftReady
                        ? "Not active yet. Prepare Corpus to ask."
                        : "PDF import pending. Select a readable PDF to continue."}
                    </Text>
                  </View>
                )}

                {uploadInputMode !== null && !uploadCorpusPrepared && (
                  <TouchableOpacity
                    style={[
                      styles.button,
                      (prepBusy || !activeDraftReady) && styles.buttonDisabled,
                    ]}
                    onPress={onPrepare}
                    disabled={prepBusy || !activeDraftReady}
                  >
                    {prepBusy ? (
                      <ActivityIndicator />
                    ) : (
                      <Text style={styles.buttonText}>
                        {t("upload.prepareBtn", "Prepare Corpus")}
                      </Text>
                    )}
                  </TouchableOpacity>
                )}

                {prepMsg ? <Text style={styles.muted}>{prepMsg}</Text> : null}
              </View>
            )}
          </ScrollView>
        </View>

        <View style={mode === "scan" ? styles.visiblePanel : styles.hiddenPanel}>
          {hasActiveCorpus ? (
            <View style={styles.lockedPanel}>
              <Text style={styles.lockedTitle}>Active corpus loaded</Text>

              <Text style={styles.lockedText}>
                Clear the active corpus before scanning or importing new images.
              </Text>
            </View>
          ) : (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 40 }}
              keyboardShouldPersistTaps="handled"
            >
              <MultiPageScan
                styles={styles}
                ocrLang={ocrLang}
                setOcrLang={setOcrLang}
                onCorpusPrepared={async () => {
                  resetDraftWorkspace();
                  await refreshActiveCorpusState();
                }}
              />
            </ScrollView>
          )}
        </View>

        <Modal
          visible={corpusInfoOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setCorpusInfoOpen(false)}
        >
          <Pressable
            style={styles.corpusInfoBackdrop}
            onPress={() => setCorpusInfoOpen(false)}
          />

          <View style={styles.corpusInfoMenu}>
            <Text style={styles.corpusInfoTitle}>
              {hasActiveCorpus ? "Active corpus" : "Corpus status"}
            </Text>

            <Text style={styles.corpusInfoName}>{activeCorpusName}</Text>

            <Text style={styles.corpusInfoStatus}>{corpusStatus}</Text>
          </View>
        </Modal>

        <Modal
          visible={languagePickerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setLanguagePickerOpen(false)}
        >
          <Pressable
            style={styles.languageBackdrop}
            onPress={() => setLanguagePickerOpen(false)}
          />

          <View style={styles.languageMenu}>
            <Text style={styles.languageTitle}>Language</Text>

            <TouchableOpacity
              style={styles.languageOption}
              onPress={async () => {
                await setOcrLang("en");
                setLanguagePickerOpen(false);
              }}
            >
              <Text style={styles.languageOptionText}>
                {ocrLang === "en" ? "✓ " : ""}English
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.languageOption}
              onPress={async () => {
                await setOcrLang("it");
                setLanguagePickerOpen(false);
              }}
            >
              <Text style={styles.languageOptionText}>
                {ocrLang === "it" ? "✓ " : ""}Italiano
              </Text>
            </TouchableOpacity>
          </View>
        </Modal>

        <Modal
          visible={manageCorpusOpen}
          transparent
          animationType="slide"
          onRequestClose={() => setManageCorpusOpen(false)}
        >
          <Pressable
            style={styles.sheetBackdrop}
            onPress={() => setManageCorpusOpen(false)}
          />

          <View style={styles.bottomSheet}>
            <View style={styles.sheetHandle} />

            <View style={styles.sheetHeaderRow}>
              <Text style={styles.sheetTitle}>Manage corpus</Text>

              <TouchableOpacity
                style={styles.sheetCloseButton}
                onPress={() => setManageCorpusOpen(false)}
              >
                <Text style={styles.sheetCloseText}>×</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.sheetCorpusSummary}>
              <Text style={styles.sheetCorpusIcon}>▣</Text>

              <View style={{ flex: 1 }}>
                <Text style={styles.sheetCorpusName} numberOfLines={1}>
                  {activeCorpusName}
                </Text>

                <Text style={styles.sheetCorpusStatus}>{corpusStatus}</Text>
                <Text style={styles.sheetCorpusStatus}>{openAIKeyStatus}</Text>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.sheetAction, prepBusy && styles.buttonDisabled]}
              onPress={onLoadLatestSavedCorpus}
              disabled={prepBusy}
            >
              <Text style={styles.sheetActionIcon}>▭</Text>
              <Text style={styles.sheetActionText}>Load saved corpus</Text>
              <Text style={styles.sheetActionChevron}>›</Text>
            </TouchableOpacity>

            {savedCorpusPickerOpen && (
              <View style={styles.savedCorpusSheetBox}>
                <ScrollView style={{ maxHeight: 180 }}>
                  {savedCorpora.map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.savedCorpusRow}
                      onPress={() => onSelectSavedCorpus(item)}
                    >
                      <Text style={styles.chunkText}>{item.name}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}

            <TouchableOpacity
              style={[styles.sheetAction, prepBusy && styles.buttonDisabled]}
              onPress={onImportCorpus}
              disabled={prepBusy}
            >
              <Text style={styles.sheetActionIcon}>⇧</Text>
              <Text style={styles.sheetActionText}>Import corpus</Text>
              <Text style={styles.sheetActionChevron}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sheetAction, prepBusy && styles.buttonDisabled]}
              onPress={onSaveOpenAIKey}
              disabled={prepBusy}
            >
              <Text style={styles.sheetActionIcon}>◇</Text>
              <Text style={styles.sheetActionText}>
                {openAIKeyReady ? "Replace OpenAI key" : "Add OpenAI key"}
              </Text>
              <Text style={styles.sheetActionChevron}>›</Text>
            </TouchableOpacity>

            {openAIKeyReady ? (
              <TouchableOpacity
                style={[
                  styles.sheetAction,
                  styles.sheetDangerAction,
                  prepBusy && styles.buttonDisabled,
                ]}
                onPress={onClearOpenAIKey}
                disabled={prepBusy}
              >
                <Text style={[styles.sheetActionIcon, styles.sheetDangerText]}>
                  ◇
                </Text>
                <Text style={[styles.sheetActionText, styles.sheetDangerText]}>
                  Remove OpenAI key
                </Text>
                <Text
                  style={[styles.sheetActionChevron, styles.sheetDangerText]}
                >
                  ›
                </Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity
              style={[
                styles.sheetAction,
                (!hasActiveCorpus || prepBusy) && styles.buttonDisabled,
              ]}
              onPress={onSaveCurrentCorpus}
              disabled={!hasActiveCorpus || prepBusy}
            >
              <Text style={styles.sheetActionIcon}>＋</Text>
              <Text style={styles.sheetActionText}>Save corpus</Text>
              <Text style={styles.sheetActionChevron}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.sheetAction,
                (!hasActiveCorpus || prepBusy) && styles.buttonDisabled,
              ]}
              onPress={onExportActiveCorpus}
              disabled={!hasActiveCorpus || prepBusy}
            >
              <Text style={styles.sheetActionIcon}>⇩</Text>
              <Text style={styles.sheetActionText}>Export corpus</Text>
              <Text style={styles.sheetActionChevron}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.sheetAction,
                styles.sheetDangerAction,
                (!hasActiveCorpus || prepBusy) && styles.buttonDisabled,
              ]}
              onPress={onClear}
              disabled={!hasActiveCorpus || prepBusy}
            >
              <Text style={[styles.sheetActionIcon, styles.sheetDangerText]}>
                ⌫
              </Text>

              <Text style={[styles.sheetActionText, styles.sheetDangerText]}>
                Clear active corpus
              </Text>

              <Text style={[styles.sheetActionChevron, styles.sheetDangerText]}>
                ›
              </Text>
            </TouchableOpacity>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </ToastProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#062d24",
    alignItems: "stretch",
    justifyContent: "flex-start",
    paddingHorizontal: 16,
    paddingTop: 24,
    gap: 14,
  },
  visiblePanel: {
    flex: 1,
  },
  hiddenPanel: {
    display: "none",
  },
  headerRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
  },
  title: {
    fontSize: 29,
    color: "#ffffff",
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  langPill: {
    minWidth: 56,
    height: 42,
    borderRadius: 13,
    backgroundColor: "rgba(31, 117, 91, 0.45)",
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  langPillText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  tabs: {
    flexDirection: "row",
    width: "100%",
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.28)",
    backgroundColor: "rgba(6, 45, 36, 0.8)",
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRightWidth: 1,
    borderRightColor: "rgba(70, 199, 157, 0.18)",
  },
  tabActive: {
    backgroundColor: "rgba(39, 159, 119, 0.52)",
  },
  tabText: {
    color: "#aacdc2",
    fontWeight: "700",
    fontSize: 15,
  },
  tabTextActive: {
    color: "#ffffff",
  },
  corpusRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  corpusMeta: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    gap: 6,
    paddingVertical: 6,
  },
  corpusIcon: {
    color: "#28c894",
    fontSize: 21,
    fontWeight: "700",
  },
  corpusName: {
    color: "#28c894",
    fontSize: 16,
    fontWeight: "800",
    maxWidth: 150,
  },
  corpusCheck: {
    color: "#28c894",
    fontSize: 17,
    fontWeight: "900",
  },
  corpusStatus: {
    color: "#b9d8ce",
    fontSize: 14,
    flexShrink: 1,
  },
  manageButton: {
    borderWidth: 1,
    borderColor: "#259b78",
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 10,
    backgroundColor: "rgba(10, 62, 49, 0.7)",
  },
  manageButtonText: {
    color: "#4ad49f",
    fontSize: 14,
    fontWeight: "800",
  },
  tabPanel: {
    gap: 10,
  },
  askScroll: {
    flex: 1,
  },
  askScrollContent: {
    paddingBottom: 260,
  },
  tabTitle: {
    color: "#e6fff5",
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 2,
  },
  sliderCard: {
    backgroundColor: "rgba(18, 76, 58, 0.66)",
    borderRadius: 16,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.2)",
  },
  sliderHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sliderTitle: {
    color: "#e6fff5",
    fontSize: 15,
    fontWeight: "900",
  },
  sliderValue: {
    color: "#4ad49f",
    fontSize: 15,
    fontWeight: "900",
  },
  sliderHint: {
    color: "#b9e8d9",
    fontSize: 13,
    fontWeight: "600",
  },
  semanticSliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  semanticSliderTrack: {
    flex: 1,
    height: 28,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.16)",
    justifyContent: "center",
    overflow: "visible",
  },
  semanticSliderFill: {
    position: "absolute",
    left: 0,
    height: 8,
    borderRadius: 999,
    backgroundColor: "#4ad49f",
  },
  semanticSliderThumb: {
    position: "absolute",
    width: 22,
    height: 22,
    marginLeft: -11,
    borderRadius: 11,
    backgroundColor: "#e6fff5",
    borderWidth: 2,
    borderColor: "#1fb47e",
  },
  uploadScroll: {
    flex: 1,
  },
  uploadScrollContent: {
    paddingBottom: 280,
  },
  lockedPanel: {
    backgroundColor: "rgba(18, 76, 58, 0.56)",
    borderRadius: 18,
    padding: 18,
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.18)",
  },
  lockedTitle: {
    color: "#e6fff5",
    fontSize: 18,
    fontWeight: "900",
  },
  lockedText: {
    color: "#b9e8d9",
    fontSize: 15,
    lineHeight: 22,
  },
  input: {
    backgroundColor: "#0a3329",
    color: "#ffffff",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#1c6a52",
    fontSize: 16,
  },
  button: {
    backgroundColor: "#1fb47e",
    borderRadius: 13,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 6,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#eafff7",
    fontWeight: "800",
    fontSize: 17,
  },
  secondaryButton: {
    alignSelf: "flex-end",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  secondaryButtonText: {
    color: "#b9e8d9",
    fontSize: 14,
    fontWeight: "800",
  },
  keyboardAccessory: {
    height: 44,
    backgroundColor: "#0b3f33",
    borderTopWidth: 1,
    borderTopColor: "rgba(70, 199, 157, 0.25)",
    alignItems: "flex-end",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  keyboardAccessoryButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  keyboardAccessoryButtonText: {
    color: "#4ad49f",
    fontSize: 16,
    fontWeight: "900",
  },
  error: {
    color: "#ffd6d6",
    backgroundColor: "#3a0f0f",
    borderRadius: 8,
    padding: 8,
    marginTop: 8,
  },
  cardLarge: {
    backgroundColor: "rgba(18, 76, 58, 0.86)",
    borderRadius: 18,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.18)",
  },
  sectionTitle: {
    color: "#e6fff5",
    fontSize: 17,
    fontWeight: "700",
  },
  candidatePickerButton: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.28)",
    backgroundColor: "rgba(6, 45, 36, 0.68)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  candidatePickerLabel: {
    color: "#b9e8d9",
    fontSize: 12,
    fontWeight: "800",
  },
  candidatePickerValue: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
    marginTop: 2,
  },
  candidatePickerChevron: {
    color: "#dffcf2",
    fontSize: 22,
    fontWeight: "900",
  },
  candidatePickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  candidatePickerMenu: {
    position: "absolute",
    left: 18,
    right: 18,
    top: "28%",
    borderRadius: 18,
    backgroundColor: "#07362b",
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.3)",
    padding: 14,
  },
  candidatePickerTitle: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "900",
    marginBottom: 10,
  },
  candidatePickerList: {
    maxHeight: 320,
  },
  candidatePickerOption: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.16)",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    marginBottom: 8,
  },
  candidatePickerOptionSelected: {
    borderColor: "#4ad49f",
    backgroundColor: "rgba(74, 212, 159, 0.14)",
  },
  candidatePickerOptionText: {
    color: "#dffcf2",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },
  candidatePickerOptionTextSelected: {
    color: "#ffffff",
    fontWeight: "900",
  },
  chunkBox: {
    backgroundColor: "#0a3329",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1c6a52",
    minHeight: 150,
    maxHeight: 260,
  },
  chunkBoxContent: {
    paddingBottom: 8,
  },
  chunkText: {
    color: "#ffffff",
    fontSize: 16,
    lineHeight: 23,
  },
  textArea: {
    minHeight: 140,
    textAlignVertical: "top",
  },
  muted: {
    color: "#b9e8d9",
    fontSize: 14,
    marginTop: 6,
  },
  savedCorpusRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(70, 199, 157, 0.14)",
  },
  uploadChoiceRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 4,
    marginBottom: 4,
  },
  uploadChoiceButton: {
    flex: 1,
    height: 116,
    borderRadius: 18,
    backgroundColor: "transparent",
    borderWidth: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  uploadChoiceIcon: {
    fontSize: 72,
    fontWeight: "700",
    lineHeight: 76,
  },
  uploadChoiceLabel: {
    color: "#dffcf2",
    fontSize: 15,
    fontWeight: "800",
    marginTop: 6,
  },
  ocrRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
    marginBottom: 8,
  },
  ocrLabel: {
    color: "#e6fff5",
    fontSize: 14,
    fontWeight: "700",
  },
  ocrButton: {
    flex: 1,
    backgroundColor: "#0f3f30",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#1c6a52",
  },
  ocrButtonActive: {
    backgroundColor: "#1aa673",
  },
  ocrButtonText: {
    color: "#9fd7c6",
    fontWeight: "700",
  },
  ocrButtonTextActive: {
    color: "#07271d",
  },
  corpusInfoBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.26)",
  },
  corpusInfoMenu: {
    position: "absolute",
    top: 138,
    left: 16,
    right: 16,
    borderRadius: 18,
    padding: 14,
    backgroundColor: "#0b3f33",
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.25)",
    gap: 8,
  },
  corpusInfoTitle: {
    color: "#b9d8ce",
    fontSize: 13,
    fontWeight: "800",
  },
  corpusInfoName: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 24,
  },
  corpusInfoStatus: {
    color: "#b9d8ce",
    fontSize: 14,
    fontWeight: "600",
  },
  languageBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.26)",
  },
  languageMenu: {
    position: "absolute",
    top: 82,
    right: 16,
    width: 190,
    borderRadius: 18,
    padding: 12,
    backgroundColor: "#0b3f33",
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.25)",
    gap: 8,
  },
  languageTitle: {
    color: "#b9d8ce",
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 2,
  },
  languageOption: {
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 12,
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  languageOptionText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.34)",
  },
  bottomSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "88%",
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 34,
    backgroundColor: "#0b3f33",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.25)",
    gap: 10,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 56,
    height: 6,
    borderRadius: 99,
    backgroundColor: "rgba(255, 255, 255, 0.28)",
    marginBottom: 6,
  },
  sheetHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sheetTitle: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "900",
  },
  sheetCloseButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  sheetCloseText: {
    color: "#ffffff",
    fontSize: 36,
    lineHeight: 38,
  },
  sheetCorpusSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  },
  sheetCorpusIcon: {
    color: "#41d49d",
    fontSize: 30,
    fontWeight: "900",
  },
  sheetCorpusName: {
    color: "#41d49d",
    fontSize: 22,
    fontWeight: "900",
  },
  sheetCorpusStatus: {
    color: "#b9d8ce",
    fontSize: 17,
  },
  sheetAction: {
    minHeight: 58,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.2)",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    gap: 14,
  },
  sheetDangerAction: {
    borderColor: "rgba(255, 111, 98, 0.35)",
    backgroundColor: "rgba(255, 111, 98, 0.08)",
  },
  sheetActionIcon: {
    color: "#ffffff",
    fontSize: 27,
    width: 30,
    textAlign: "center",
  },
  sheetActionText: {
    flex: 1,
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
  },
  sheetActionChevron: {
    color: "#ffffff",
    fontSize: 36,
    lineHeight: 38,
  },
  sheetDangerText: {
    color: "#ff6f62",
  },
  savedCorpusSheetBox: {
    backgroundColor: "#0a3329",
    borderRadius: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "rgba(70, 199, 157, 0.18)",
  },
});