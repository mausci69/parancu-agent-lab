// Centralised AsyncStorage keys used across the app.
// Keep these as the single source of truth.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { getItemSafe } from "../utils/storage";
import type { GenEngine } from "./genEngine";

export const STORAGE_KEYS = {
  APP_LANG: "app.lang",
  OCR_LANG: "app.ocr_lang",
  OCR_ENGINE: "app.ocr_engine", // "server" | "mlkit"
  GEN_ENGINE: "app.gen_engine", // "server" | "local" | "auto" | "sim"
} as const;

export type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];
export type OcrEngine = "server" | "mlkit";

/** Read persisted OCR engine, defaulting to "server" if unset/invalid. */
export async function getOcrEngine(): Promise<OcrEngine> {
  const v = await getItemSafe(STORAGE_KEYS.OCR_ENGINE);
  return v === "mlkit" || v === "server" ? v : "server";
}

/** Persist OCR engine choice. */
export async function setOcrEngine(engine: OcrEngine): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.OCR_ENGINE, engine);
}

/** Read persisted Generation engine, defaulting to "server" if unset/invalid. */
export async function getGenEngine(): Promise<GenEngine> {
  const v = await getItemSafe(STORAGE_KEYS.GEN_ENGINE);
  return v === "local" || v === "auto" || v === "sim" || v === "server" ? (v as GenEngine) : "server";
}

/** Persist Generation engine choice. */
export async function setGenEngine(engine: GenEngine): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.GEN_ENGINE, engine);
}
