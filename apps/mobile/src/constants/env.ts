// Environment/config for local LLM bridge.
// Uses EXPO_PUBLIC_* so values are available at runtime in Expo.
// British English in comments.

export const LOCAL_LLM_URL =
  process.env.EXPO_PUBLIC_LOCAL_LLM_URL ?? "http://127.0.0.1:8089";

export const LOCAL_LLM_TIMEOUT_MS = Number(
  process.env.EXPO_PUBLIC_LOCAL_LLM_TIMEOUT_MS ?? 120000 // 120s sensible default for on-device models
);

// When set, always route to simulator regardless of server/local status.
// Useful for UI testing and offline demos.
export const DEBUG_FORCE_SIM =
  (process.env.EXPO_PUBLIC_DEBUG_FORCE_SIM || "").toString() === "1";

