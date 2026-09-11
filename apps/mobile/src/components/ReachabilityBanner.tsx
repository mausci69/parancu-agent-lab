import React, { useEffect, useState, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { BASE_URL } from "../lib/client";
import { health } from "../lib/api";

export default function ReachabilityBanner() {
  return null;
  const [ok, setOk] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [okFlash, setOkFlash] = useState(false); // brief green flash

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const r = await health();
      const isOk = r?.status === "ok";

      setOk(isOk);
      setError(isOk ? undefined : "Server not responding");

      if (isOk) {
        setOkFlash(true);
        setTimeout(() => setOkFlash(false), 1200);
      }
    } catch (e: any) {
      console.log("[Reachability] health check error", e?.message || e);
      setOk(false);                 // airplane mode / network error => show red banner
      setError("Network unreachable");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // Periodic health check every 8s to detect going offline/online
  useEffect(() => {
    const id = setInterval(() => {
      void check();
    }, 8000);
    return () => clearInterval(id);
  }, [check]);

  // Hide entirely when healthy and flash finished
  if (ok === true && !okFlash) return null;

  // Colours: yellow (checking), red (offline), green (flash online)
  const bg = checking ? "#b58900" : ok === false ? "#B00020" : "#137333";
  const title =
    ok === true ? "Connected" : checking ? "Checking backend…" : "Backend unreachable";
  const subtitle =
    ok === true ? BASE_URL : `${BASE_URL}${error ? ` — ${error}` : ""}`;

  return (
    <View style={styles.container}>
      <View style={[styles.banner, { backgroundColor: bg }]} accessibilityRole="alert">
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text>
        </View>
        <TouchableOpacity onPress={check} disabled={checking} style={styles.btn}>
          <Text style={styles.btnText}>{checking ? "…" : "Retry"}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
  },
  banner: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
  },

  title: { color: "white", fontWeight: "700", marginBottom: 2 },
  subtitle: { color: "white", opacity: 0.9, maxWidth: 260 },
  btn: {
    marginLeft: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  btnText: { color: "white", fontWeight: "700" },
});