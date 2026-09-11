import React, { useEffect, useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { useTranslation } from "react-i18next";
import { health as localHealth } from "../lib/gen/localBridge";

// Small inline status pill for the local LLM: ready / loading / error.
// Polls occasionally so the user sees when models finish loading.
// British English in comments.

type Props = {
  pollMs?: number;         // how often to refresh (default 10s)
  style?: any;             // optional container override
  showLabel?: boolean;     // show "Local LLM:" label
};

export default function LocalStatusInline({ pollMs = 10_000, style, showLabel = true }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<boolean>(true);

  useEffect(() => {
    let on = true;
    let timer: any;

    const run = async () => {
      try {
        setBusy(true);
        const h = await localHealth();
        if (!on) return;
        setStatus(h.status);
      } finally {
        if (on) setBusy(false);
      }
    };

    run();
    timer = setInterval(run, Math.max(3000, pollMs));

    return () => {
      on = false;
      if (timer) clearInterval(timer);
    };
  }, [pollMs]);

  const colour =
    status === "ready" ? "#22c55e" : status === "loading" ? "#f59e0b" : "#ef4444";
  const labelKey =
    status === "ready"
      ? "status.local.ready"
      : status === "loading"
      ? "status.local.loading"
      : "status.local.error";

  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 4,
        },
        style,
      ]}
    >
      {showLabel ? (
        <Text style={{ opacity: 0.8 }}>{t("status.local.label", "Local LLM")}: </Text>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingVertical: 4,
          paddingHorizontal: 8,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colour,
        }}
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: colour,
          }}
        />
        <Text>{t(labelKey)}</Text>
        {busy && status !== "ready" ? <ActivityIndicator size="small" /> : null}
      </View>
    </View>
  );
}

