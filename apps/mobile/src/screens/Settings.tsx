import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert, AccessibilityInfo } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { setOcrLang } from "../lib/lang";

// Local components & storage helpers
import GenEnginePicker from "../components/GenEnginePicker";
import { STORAGE_KEYS, getGenEngine } from "../constants/storage";
import type { GenEngine } from "../constants/genEngine";
import { setItemSafe, getItemSafe } from "../utils/storage";

type OcrEngine = "server" | "device";

const OCR_ENGINE_KEY = "OCR_ENGINE";

async function getOcrEngine(): Promise<OcrEngine> {
  const stored = await getItemSafe(OCR_ENGINE_KEY);
  return stored === "device" || stored === "server" ? stored : "server";
}

async function setOcrEngine(v: OcrEngine): Promise<void> {
  await setItemSafe(OCR_ENGINE_KEY, v);
}

// Keys & constants
const LANG_KEY = STORAGE_KEYS.APP_LANG;
const DEBUG_KEY = "@eco/debug_banner_hidden";

const SUPPORTED_LANGS = [
  { code: "en", label: "English" },
  { code: "it", label: "Italiano" },
];

type Props = {
  debugHidden: boolean;
  onSetDebugHidden: (v: boolean) => void;
};

export default function Settings({ debugHidden, onSetDebugHidden }: Props) {
  const { t } = useTranslation();

  // Language state (short code: "en" | "it")
  const [lang, setLang] = useState<string>(i18n.language?.slice(0, 2) || "en");

  // OCR + Gen engine choices
  const [ocrEngine, setOcrEngineState] = useState<OcrEngine>("server");
  const [genEngine, setGenEngineState] = useState<GenEngine>("server");

  // UI flags
  const [busy, setBusy] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);

// Load current settings on mount (guarded)
useEffect(() => {
  let mounted = true;

  (async () => {
    try {
      const storedLang = await AsyncStorage.getItem(LANG_KEY);
      const storedDebug = await AsyncStorage.getItem(DEBUG_KEY);

      // OCR and Gen with safe fallbacks
      let storedOcr: OcrEngine = "server";
      try {
        storedOcr = await getOcrEngine();
      } catch (e) {
        console.warn("getOcrEngine failed, defaulting to 'server':", e);
      }
      let storedGen: GenEngine | null = null;
      try {
        storedGen = await getGenEngine();
      } catch (e) {
        console.warn("getGenEngine failed:", e);
      }

      if (!mounted) return;

      if (storedLang && SUPPORTED_LANGS.some((l) => l.code === storedLang)) {
        setLang(storedLang);
      } else {
        await AsyncStorage.setItem(LANG_KEY, lang);
      }

      setOcrEngineState(storedOcr);
      if (storedGen) setGenEngineState(storedGen);

      if (storedDebug != null) {
        onSetDebugHidden(storedDebug === "1" || storedDebug === "true");
      }
    } catch (err) {
      console.warn("Settings load error:", err);
    }
  })();

  return () => {
    mounted = false;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

  // Persist + announce small helper
  function toastNow(msg: string) {
    setToast(msg);
    AccessibilityInfo.announceForAccessibility?.(msg);
    setTimeout(() => setToast(null), 1500);
  }

  // Save handler
  async function handleSave() {
    try {
      setBusy(true);

      // Single source of truth for app + OCR language
      await setOcrLang(lang);
      // Keep legacy app language key in sync (harmless but useful)
      await AsyncStorage.setItem(LANG_KEY, lang);

      // Persist OCR + Gen engines using safe helpers
      await setOcrEngine(ocrEngine);
      await setItemSafe(STORAGE_KEYS.GEN_ENGINE, genEngine);

      toastNow(t("settings.saved", "Settings saved"));
    } catch (err) {
      Alert.alert(t("settings.saveErrorTitle", "Could not save"), t("settings.saveErrorBody", "Please try again."));
    } finally {
      setBusy(false);
    }
  }

  // Toggle debug banner visibility
  async function handleToggleDebug(nextHidden: boolean) {
    onSetDebugHidden(nextHidden);
    try {
      await AsyncStorage.setItem(DEBUG_KEY, nextHidden ? "1" : "0");
      toastNow(
        nextHidden
          ? t("settings.debugHidden", "Debug banner hidden")
          : t("settings.debugShown", "Debug banner shown")
      );
    } catch {
      // non-blocking
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t("settings.title", "Settings")}</Text>

      {/* Language picker */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{t("settings.language", "Language")}</Text>
        <View style={styles.row}>
          {SUPPORTED_LANGS.map((l) => (
            <TouchableOpacity
              key={l.code}
              style={[styles.toggle, lang === l.code ? styles.toggleActive : null]}
              onPress={() => setLang(l.code)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ selected: lang === l.code }}
            >
              <Text style={[styles.toggleText, lang === l.code ? styles.toggleTextActive : null]}>
                {l.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.muted}>{t("settings.languageHint", "Applies to app text and messages.")}</Text>
      </View>

      {/* OCR engine picker */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{t("settings.ocrEngine", "OCR engine")}</Text>
        <View style={styles.row}>
          {(["server", "device"] as OcrEngine[]).map((opt) => (
            <TouchableOpacity
              key={opt}
              style={[styles.toggle, ocrEngine === opt ? styles.toggleActive : null]}
              onPress={() => setOcrEngineState(opt)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ selected: ocrEngine === opt }}
            >
              <Text style={[styles.toggleText, ocrEngine === opt ? styles.toggleTextActive : null]}>
                {opt === "server" ? t("settings.server", "Server") : t("settings.device", "On-device")}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.muted}>
          {t("settings.ocrHint", "On-device may be slower but can work offline; server is faster when online.")}
        </Text>
      </View>

      {/* Generation engine picker */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{t("settings.genEngineTitle", "Generation engine")}</Text>
        <GenEnginePicker value={genEngine} onChange={(next: GenEngine) => setGenEngineState(next)} disabled={busy} />
        <Text style={styles.muted}>
          {t("settings.genHint", "Choose your preferred model. Some options require internet connectivity.")}
        </Text>
      </View>

      {/* Debug banner toggle */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{t("settings.debug", "Debug banner")}</Text>
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.toggle, !debugHidden ? styles.toggleActive : null]}
            onPress={() => handleToggleDebug(false)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ selected: !debugHidden }}
          >
            <Text style={[styles.toggleText, !debugHidden ? styles.toggleTextActive : null]}>
              {t("settings.show", "Show")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggle, debugHidden ? styles.toggleActive : null]}
            onPress={() => handleToggleDebug(true)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ selected: debugHidden }}
          >
            <Text style={[styles.toggleText, debugHidden ? styles.toggleTextActive : null]}>
              {t("settings.hide", "Hide")}
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.muted}>
          {t("settings.debugHint", "Hide the developer banner at the bottom (applies in debug builds).")}
        </Text>
      </View>

      {/* Save button */}
      <TouchableOpacity
        style={[styles.button, busy ? styles.buttonDisabled : null]}
        onPress={handleSave}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>{busy ? t("settings.saving", "Saving…") : t("settings.save", "Save")}</Text>
      </TouchableOpacity>

      {/* Lightweight toast */}
      {toast && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </View>
  );
}

/* Minimal styles with a clean look (British English comments) */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 16,
    backgroundColor: "#0b0b0b",
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "white",
  },
  card: {
    backgroundColor: "#111",
    borderRadius: 16,
    padding: 16,
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2a2a2a",
  },
  sectionTitle: {
    color: "white",
    fontWeight: "700",
    fontSize: 16,
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  toggle: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2f2f2f",
    backgroundColor: "#151515",
  },
  toggleActive: {
    borderColor: "#4ade80",
    backgroundColor: "#0f172a",
  },
  toggleText: {
    color: "#d4d4d4",
    fontWeight: "600",
  },
  toggleTextActive: {
    color: "white",
  },
  muted: {
    color: "#9ca3af",
    fontSize: 12,
  },
  button: {
    marginTop: 4,
    backgroundColor: "#22c55e",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "black",
    fontWeight: "700",
    fontSize: 16,
  },
  toast: {
    position: "absolute",
    bottom: 20,
    left: 20,
    right: 20,
    backgroundColor: "#1f2937",
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#374151",
  },
  toastText: {
    color: "white",
    fontWeight: "600",
  },
});