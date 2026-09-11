import React, { useMemo, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, ScrollView } from "react-native";
import { useTranslation } from "react-i18next";
import { useLocalEmbeddings } from "../hooks/useLocalEmbeddings";

/**
 * Simple screen to prepare & persist a local offline corpus.
 * Paste text, we split into passages, embed locally, and save to device.
 * British English comments.
 */
export default function PrepareOffline() {
  const { t } = useTranslation();
  const { prepare, busy, ready, texts, embeddings } = useLocalEmbeddings();

  const [raw, setRaw] = useState<string>("");

  // Very simple splitter: split on blank lines; trim; drop very short lines.
  const passages = useMemo(() => {
    return raw
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/g)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }, [raw]);

  const count = passages.length;

  async function handlePrepare() {
    const n = passages.length;
    if (n === 0) {
      Alert.alert(
        t("prepare.emptyTitle", "Nothing to embed"),
        t("prepare.emptyBody", "Paste some text first.")
      );
      return;
    }
    try {
      await prepare(passages);
      Alert.alert(
        t("prepare.doneTitle", "Offline corpus ready"),
        t("prepare.doneBody", "Embeddings have been saved on this device.")
      );
    } catch (e: any) {
      Alert.alert(t("prepare.errorTitle", "Error"), String(e?.message || e));
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 18, fontWeight: "700", marginBottom: 8 }}>
        {t("prepare.title", "Prepare Offline Corpus")}
      </Text>
      <Text style={{ color: "#666", marginBottom: 12 }}>
        {t(
          "prepare.subtitle",
          "Paste text below. We will split it into passages, compute local embeddings, and store them for offline search."
        )}
      </Text>

      <Text style={{ fontWeight: "600", marginBottom: 6 }}>
        {t("prepare.inputLabel", "Text to embed")}
      </Text>
      <TextInput
        value={raw}
        onChangeText={setRaw}
        placeholder={t("prepare.placeholder", "Paste or type your content here…")}
        multiline
        numberOfLines={10}
        style={{
          minHeight: 160,
          borderWidth: 1,
          borderColor: "#ddd",
          borderRadius: 8,
          padding: 12,
          textAlignVertical: "top",
        }}
        editable={!busy}
      />

      <View style={{ marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: "#f7f7f7" }}>
        <Text style={{ fontSize: 12, color: "#444" }}>
          {t("prepare.passages", "Passages to embed")}: {count}
        </Text>
        <Text style={{ fontSize: 12, color: "#444", marginTop: 4 }}>
          {t("prepare.currentStatus", "Current stored")} — {texts.length} {t("prepare.passagesWord", "passages")},{" "}
          {embeddings.length > 0 ? embeddings[0].length : 0} {t("prepare.dim", "dims")}
        </Text>
        <Text style={{ fontSize: 12, color: ready ? "#0a7" : "#a00", marginTop: 4 }}>
          {ready ? t("prepare.ready", "Local model ready") : t("prepare.notReady", "Local model not ready")}
        </Text>
      </View>

      <TouchableOpacity
        onPress={handlePrepare}
        disabled={busy || count === 0}
        style={{
          marginTop: 12,
          paddingVertical: 14,
          borderRadius: 10,
          backgroundColor: busy || count === 0 ? "#789" : "#0a7",
        }}
      >
        {busy ? (
          <ActivityIndicator />
        ) : (
          <Text style={{ color: "white", fontWeight: "700", textAlign: "center" }}>
            {t("prepare.btn", "Prepare & Save Offline")}
          </Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}
