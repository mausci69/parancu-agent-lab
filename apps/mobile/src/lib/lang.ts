// apps/mobile/src/lib/lang.ts
// Single source of truth for OCR language in the app.

import i18n from "../i18n";
import AsyncStorage from "@react-native-async-storage/async-storage";

const OCR_LANG_KEY = "OCR_LANG";

export async function setOcrLang(lang: string) {
  // Persist OCR language and align i18n UI language.
  await AsyncStorage.setItem(OCR_LANG_KEY, lang);
  if (i18n.language !== lang) {
    await i18n.changeLanguage(lang);
  }
}

export async function getOcrLang(): Promise<string> {
  // Return stored OCR language or fall back to current UI language.
  const stored = await AsyncStorage.getItem(OCR_LANG_KEY);
  return stored || i18n.language || "en";
}

