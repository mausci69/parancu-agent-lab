import React, { useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { ocrExtract } from "../api/ocr";
import { savePdfBlob } from "../utils/savePdf";
import { pickImageAsFormData } from "../utils/pickImage";

export default function OcrPdfDemo() {
  const [busy, setBusy] = useState(false);

  const onAssemblePdf = async () => {
    try {
      setBusy(true);
      const form = await pickImageAsFormData("camera");
      if (!form) return;

      // Ask backend to assemble multi-page PDF when applicable
      const pdfBlob = (await ocrExtract(form, true)) as Blob;

      const uri = await savePdfBlob(pdfBlob, `ocr_${Date.now()}.pdf`, true);
      Alert.alert("PDF saved", `Saved to: ${uri}`);
    } catch (err: any) {
      Alert.alert("OCR error", String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, padding: 24, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: 18, marginBottom: 16, textAlign: "center" }}>
        OCR → Assemble PDF (demo)
      </Text>

      <TouchableOpacity
        onPress={onAssemblePdf}
        disabled={busy}
        style={{
          backgroundColor: "#0b3d2e",
          paddingVertical: 12,
          paddingHorizontal: 20,
          borderRadius: 12,
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator />
        ) : (
          <Text style={{ color: "white", fontSize: 16 }}>Scan & assemble PDF</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

