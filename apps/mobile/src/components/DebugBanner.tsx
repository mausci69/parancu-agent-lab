import React, { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { BASE_URL } from "../lib/client";
import { health, HealthResponse } from "../lib/api";
import { getOcrLang } from "../lib/lang";

export default function DebugBanner({ hidden = false }: { hidden?: boolean }) {
  return null;
  const { t } = useTranslation();
  const [info, setInfo] = useState<HealthResponse | null>(null);
  const [ocrLang, setOcrLangState] = useState<string>("?");

  useEffect(() => {
    let mounted = true;
    (async () => { 
      try {
        const h = await health();
        if (mounted) setInfo(h);
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const lang = await getOcrLang();
        if (mounted) setOcrLangState(lang.slice(0, 2));
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (!__DEV__ || hidden) return null;

  const reachable = !!info;
  const effectiveLang = (info?.ocr_lang || ocrLang || "?").slice(0, 2);

  const label = reachable
    ? t("scan.backend.okBadge", { status: BASE_URL, lang: effectiveLang })
    : t("scan.backend.unreachableBadge", { status: BASE_URL });

  return (
    <View
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        paddingVertical: 8,
        paddingHorizontal: 12,
        backgroundColor: "rgba(0,0,0,0.7)",
      }}
    >
      <Text style={{ color: "white", fontSize: 12 }}>
        {label} · {t("status.local.label")}: {info?.llm_enabled ? t("status.local.ready") : t("status.local.error")}
      </Text>
    </View>
  );
}