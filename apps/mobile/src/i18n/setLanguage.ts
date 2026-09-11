import i18n from "./index";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Apply the language immediately and persist it for future launches.
 * Use: await applyAndPersistLanguage("en") or ("it").
 */
export async function applyAndPersistLanguage(lang: "en" | "it") {
  // Change UI language now
  await i18n.changeLanguage(lang);
  // Persist choice
  try {
    await AsyncStorage.setItem("app.lang", lang);
  } catch {
    // Non-fatal: if saving fails, the current session still uses the selected language
  }
}

