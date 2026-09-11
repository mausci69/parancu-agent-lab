// /New_EcoSearch/EcoSearch_v1_mobile_llm/apps/mobile/src/local/openaiKeyStore.ts

// British English comments.
// Local OpenAI key storage for EcoSearch Mobile.
// This is intended for personal/internal use: the key is stored on the device.

import * as FileSystem from "expo-file-system/legacy";

const SETTINGS_DIR = `${FileSystem.documentDirectory}ecosearch-settings/`;
const OPENAI_KEY_FILE_URI = `${SETTINGS_DIR}openai-key.txt`;

async function ensureSettingsDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(SETTINGS_DIR);

  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(SETTINGS_DIR, {
      intermediates: true,
    });
  }
}

export async function saveOpenAIKey(key: string): Promise<void> {
  const cleanKey = String(key || "").trim();

  if (!cleanKey) {
    throw new Error("OpenAI key cannot be empty.");
  }

  await ensureSettingsDir();

  await FileSystem.writeAsStringAsync(OPENAI_KEY_FILE_URI, cleanKey, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

export async function loadOpenAIKey(): Promise<string> {
  try {
    await ensureSettingsDir();

    const info = await FileSystem.getInfoAsync(OPENAI_KEY_FILE_URI);
    if (!info.exists) return "";

    const raw = await FileSystem.readAsStringAsync(OPENAI_KEY_FILE_URI, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    return String(raw || "").trim();
  } catch {
    return "";
  }
}

export async function hasOpenAIKey(): Promise<boolean> {
  const key = await loadOpenAIKey();
  return key.length > 0;
}

export async function clearOpenAIKey(): Promise<void> {
  try {
    await ensureSettingsDir();

    const info = await FileSystem.getInfoAsync(OPENAI_KEY_FILE_URI);
    if (info.exists) {
      await FileSystem.deleteAsync(OPENAI_KEY_FILE_URI, {
        idempotent: true,
      });
    }
  } catch {
    // Ignore cleanup errors.
  }
}
