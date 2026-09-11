// Resolve configuration once, without hardcoding IP addresses that may change.

import Constants from "expo-constants";

export const OFFLINE_MODE = process.env.EXPO_PUBLIC_OFFLINE === "1";

function resolveBackendUrl(): string {
  // 1. If an environment value is defined, it always wins.
  if (process.env.EXPO_PUBLIC_API_BASE_URL) {
    return process.env.EXPO_PUBLIC_API_BASE_URL;
  }

  // 2. Keep backwards compatibility with the older variable name.
  if (process.env.EXPO_PUBLIC_BACKEND_URL) {
    return process.env.EXPO_PUBLIC_BACKEND_URL;
  }

  // 3. Try to use the Expo host from Metro.
  //    Examples:
  //    - "192.168.1.32:8081"
  //    - "192.168.1.32:19000"
  const hostUri =
    (Constants as any).expoConfig?.hostUri ||
    (Constants as any).manifest2?.extra?.expoGo?.debuggerHost ||
    (Constants as any).manifest?.debuggerHost;

  if (typeof hostUri === "string" && hostUri.length > 0) {
    const host = hostUri.split(":")[0];
    if (host && host !== "127.0.0.1" && host !== "localhost") {
      // Backend exposed on the same machine on port 8000.
      return `http://${host}:8000`;
    }
  }

  // 4. Fallback: simulator talking to a backend on the same machine.
  return "http://127.0.0.1:8000";
}

export const BACKEND_URL = resolveBackendUrl();
export const API_BASE_URL = BACKEND_URL;