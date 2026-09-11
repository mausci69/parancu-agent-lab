import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { GEN_ENGINE_OPTIONS, type GenEngine } from "../constants/genEngine";
import { setGenEngine } from "../constants/storage";

type Props = {
  value: GenEngine;
  onChange: (engine: GenEngine) => void;
  disabled?: boolean;
};

function fallbackLabel(value: string) {
  if (value === "server") return "Server";
  if (value === "local" || value === "device") return "On-device";
  if (value === "auto") return "Auto (prefer local)";
  if (value === "simulator" || value === "stub") return "Simulator";
  return value;
}

function labelKeyFor(value: string) {
  if (value === "server") return "settings.genEngineOptions.server";
  if (value === "local" || value === "device") return "settings.genEngineOptions.local";
  if (value === "auto") return "settings.genEngineOptions.auto";
  if (value === "simulator" || value === "stub") return "settings.genEngineOptions.simulator";
  return "";
}

export default function GenEnginePicker({ value, onChange, disabled = false }: Props) {
  const { t } = useTranslation();

  async function handleSelect(next: GenEngine) {
    if (disabled) return;
    onChange(next);
    try {
      await setGenEngine(next);
    } catch {
      // Parent Save still persists the value. Do not block the UI.
    }
  }

  return (
    <View style={styles.group}>
      {GEN_ENGINE_OPTIONS.map((opt) => {
        const selected = value === opt.value;
        const key = labelKeyFor(String(opt.value));
        const label = key ? t(key, fallbackLabel(String(opt.value))) : fallbackLabel(String(opt.value));

        return (
          <TouchableOpacity
            key={String(opt.value)}
            onPress={() => handleSelect(opt.value)}
            disabled={disabled}
            style={[
              styles.option,
              selected && styles.optionSelected,
              disabled && styles.optionDisabled,
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
          >
            <Text style={[styles.label, selected && styles.labelSelected]}>
              {label}
            </Text>

            <View style={[styles.radio, selected && styles.radioSelected]}>
              {selected ? <View style={styles.radioDot} /> : null}
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    gap: 10,
  },
  option: {
    minHeight: 50,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#35524a",
    backgroundColor: "#101816",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  optionSelected: {
    borderColor: "#42f08b",
    backgroundColor: "#111c2d",
  },
  optionDisabled: {
    opacity: 0.55,
  },
  label: {
    color: "#d7f7ec",
    fontSize: 15,
    fontWeight: "800",
  },
  labelSelected: {
    color: "#f4fff9",
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#707873",
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: {
    borderColor: "#42f08b",
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#42f08b",
  },
});
