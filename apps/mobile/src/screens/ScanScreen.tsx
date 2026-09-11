import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";

import { mlkitExtractPages } from "../lib/ocrLocal";
import { prepareCorpusFromText } from "../lib/api";
import { getOcrLang } from "../lib/lang";

type PageAsset = {
  uri: string;
  name: string;
};

export default function ScanScreen() {
  const { t } = useTranslation();

  const [pages, setPages] = useState<PageAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [status, setStatus] = useState("No corpus prepared yet.");

  const pageCount = pages.length;

  const canRun = useMemo(() => pageCount > 0 && !busy, [pageCount, busy]);

  async function addFromGallery() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert("Permission needed", "Photo library permission is required.");
        return;
      }

      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        base64: false,
        allowsMultipleSelection: true,
      });

      if (res.canceled || !res.assets?.length) return;

      const next = res.assets
        .filter((asset) => !!asset.uri)
        .map((asset, index) => ({
          uri: asset.uri,
          name: asset.fileName ?? `page-${pages.length + index + 1}.jpg`,
        }));

      setPages((prev) => [...prev, ...next]);
      setStatus(`${pages.length + next.length} page(s) ready for OCR.`);
    } catch (e: any) {
      Alert.alert("Gallery error", e?.message ?? "Could not pick images.");
    }
  }

  async function addFromCamera() {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert("Permission needed", "Camera permission is required.");
        return;
      }

      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        base64: false,
      });

      if (res.canceled || !res.assets?.[0]?.uri) return;

      const next = {
        uri: res.assets[0].uri,
        name: res.assets[0].fileName ?? `page-${pages.length + 1}.jpg`,
      };

      setPages((prev) => [...prev, next]);
      setStatus(`${pages.length + 1} page(s) ready for OCR.`);
    } catch (e: any) {
      Alert.alert("Camera error", e?.message ?? "Could not take photo.");
    }
  }

  async function scanAndPrepare() {
    if (!pages.length) return;

    try {
      setBusy(true);
      setStatus("Running on-device OCR...");

      const langRaw = await getOcrLang().catch(() => "en");
      const lang = langRaw.slice(0, 2) === "it" ? "it" : "en";

      const ocr = await mlkitExtractPages(
        pages.map((page) => page.uri),
        lang
      );

      const extracted = ocr.text.trim();
      setOcrText(extracted);

      if (!extracted) {
        setStatus("OCR returned no usable text.");
        Alert.alert("OCR empty", "No usable text was extracted.");
        return;
      }

      setStatus("Preparing local EcoSearch corpus...");

      const prep = await prepareCorpusFromText(extracted, 300000, undefined, {
        corpusLanguage: lang,
      });

      if (!prep.ready) {
        setStatus(prep.message || "Prepare failed.");
        Alert.alert("Prepare failed", prep.message || "Could not prepare corpus.");
        return;
      }

      setStatus(`Ready to ask. Chunks: ${prep.chunks}.`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setStatus(`Error: ${msg}`);
      Alert.alert("Scan failed", msg);
    } finally {
      setBusy(false);
    }
  }

  function clearAll() {
    setPages([]);
    setOcrText("");
    setStatus("No corpus prepared yet.");
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Scan document</Text>
      <Text style={styles.note}>
        Add one or more pages, run local OCR, then prepare the local EcoSearch corpus.
      </Text>

      <View style={styles.row}>
        <TouchableOpacity style={styles.button} onPress={addFromCamera} disabled={busy}>
          <Text style={styles.buttonText}>Camera</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.button} onPress={addFromGallery} disabled={busy}>
          <Text style={styles.buttonText}>Gallery</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.primaryButton, !canRun && styles.disabled]}
        onPress={scanAndPrepare}
        disabled={!canRun}
      >
        <Text style={styles.primaryButtonText}>
          {busy ? "Working..." : "Scan & prepare corpus"}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.clearButton} onPress={clearAll} disabled={busy}>
        <Text style={styles.clearButtonText}>Clear</Text>
      </TouchableOpacity>

      {busy ? <ActivityIndicator style={{ marginTop: 14 }} /> : null}

      <Text style={styles.status}>{status}</Text>
      <Text style={styles.meta}>Pages: {pageCount}</Text>

      <ScrollView style={styles.preview}>
        <Text style={styles.previewTitle}>Extracted text preview</Text>
        <Text style={styles.previewText}>{ocrText || "—"}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#0b2b23",
    borderWidth: 1,
    borderColor: "#1c6a52",
    borderRadius: 18,
    padding: 14,
    gap: 12,
  },
  title: {
    color: "#f4fff9",
    fontSize: 20,
    fontWeight: "800",
  },
  note: {
    color: "#b9d8ce",
    fontSize: 13,
    lineHeight: 19,
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  button: {
    flex: 1,
    borderRadius: 14,
    backgroundColor: "#123d32",
    borderWidth: 1,
    borderColor: "#2a7a63",
    paddingVertical: 13,
    alignItems: "center",
  },
  buttonText: {
    color: "#d7f7ec",
    fontWeight: "800",
  },
  primaryButton: {
    borderRadius: 14,
    backgroundColor: "#1f8f6d",
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "900",
    fontSize: 15,
  },
  clearButton: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#2a7a63",
    paddingVertical: 11,
    alignItems: "center",
  },
  clearButtonText: {
    color: "#b9d8ce",
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.45,
  },
  status: {
    color: "#e8fff5",
    fontSize: 14,
    fontWeight: "700",
  },
  meta: {
    color: "#b9d8ce",
    fontSize: 12,
  },
  preview: {
    maxHeight: 260,
    borderTopWidth: 1,
    borderTopColor: "#1c6a52",
    paddingTop: 10,
  },
  previewTitle: {
    color: "#b9e8d9",
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 6,
  },
  previewText: {
    color: "#d6fff1",
    fontSize: 13,
    lineHeight: 20,
  },
});
