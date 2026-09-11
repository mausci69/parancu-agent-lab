import React, { useState } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { useTranslation } from "react-i18next";
import * as ImagePicker from "expo-image-picker";
import { getOcrEngine, type OcrEngine } from "../utils/storage";

// If you use a different ML Kit binding, adjust this import accordingly:
// yarn add @react-native-ml-kit/text-recognition
import TextRecognition from "@react-native-ml-kit/text-recognition";

export default function OcrAirplanePOC() {
  const { t, i18n } = useTranslation();
  const [img, setImg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string>("");

  async function pickImage() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert(t("common.error.requestFailed", "Request failed."), "Photos permission denied.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        base64: false,
        allowsMultipleSelection: false,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      setImg(res.assets[0].uri);
      setText("");
    } catch (e: any) {
      Alert.alert(t("common.error.requestFailed", "Request failed."), e?.message ?? "Image pick failed.");
    }
  }

  async function runOcr() {
    if (!img) return;
    try {
      setBusy(true);
      const engine: OcrEngine = await getOcrEngine();
      if (engine !== "mlkit") {
        Alert.alert(
          t("scan.backend.unreachableBadge", "Backend unreachable: offline"),
          t("settings.ocrEngine_mlkit", "On-device (ML Kit)") + " " + t("prepare.ready", "Ready to ask")
        );
        return;
      }
      // Airplane-mode OCR: entirely on-device via ML Kit
      const result = await TextRecognition.recognize(img);
      // `result.text` is the full text; blocks/lines available under result.blocks
      setText(result?.text ?? "");
    } catch (e: any) {
      Alert.alert(t("common.error.requestFailed", "Request failed."), e?.message ?? "OCR failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Airplane-mode OCR (ML Kit)</Text>
      <Text style={styles.note}>{t("settings.airplaneNote", "Airplane mode: on-device OCR works offline.")}</Text>

      <View style={styles.row}>
        <TouchableOpacity style={styles.button} onPress={pickImage}>
          <Text style={styles.buttonText}>{t("scan.addPageGallery", "+ Add Page (Gallery)")}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.button, !img && styles.disabled]} onPress={runOcr} disabled={!img || busy}>
          <Text style={styles.buttonText}>{busy ? t("scan.processing_one", "Processing {{count}} page (~{{kb}} KB)…", { count: 1, kb: "—" }) : t("scan.extractPages", "Extract text from pages")}</Text>
        </TouchableOpacity>
      </View>

      {busy && <ActivityIndicator style={{ marginTop: 12 }} />}

      <ScrollView style={styles.output}>
        {img ? <Text style={styles.path}>Image: {img}</Text> : null}
        <Text style={styles.outputTitle}>{t("scan.combinedTitle", "Combined text preview")}</Text>
        <Text style={styles.outputText}>{text || "—"}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 10, padding: 16 },
  title: { color: "#e6fff5", fontSize: 18, fontWeight: "800" },
  note: { color: "#8aa59d", fontSize: 12 },
  row: { flexDirection: "row", gap: 10, marginTop: 6 },
  button: {
    flex: 1,
    backgroundColor: "#0f3f30",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#1c6a52",
  },
  disabled: { opacity: 0.5 },
  buttonText: { color: "#9fd7c6", fontWeight: "700", textAlign: "center" },
  output: { flex: 1, marginTop: 12, borderTopWidth: 1, borderTopColor: "#1c6a52", paddingTop: 10 },
  outputTitle: { color: "#b9e8d9", fontSize: 14, marginBottom: 6 },
  outputText: { color: "#d6fff1", fontSize: 13, lineHeight: 20 },
  path: { color: "#8aa59d", fontSize: 11, marginBottom: 8 },
});

