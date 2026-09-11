// Generation engine selector (Server / Local / Auto / Simulator)
// Kept separate from storage to avoid coupling. British English in comments.

export type GenEngine = "server" | "local" | "auto" | "sim";

// Default choice until Settings wiring lands.
export const DEFAULT_GEN_ENGINE: GenEngine = "server";

// Options for UI pickers; labelKey maps to i18n entries to be added later.
export const GEN_ENGINE_OPTIONS: Array<{ value: GenEngine; labelKey: string }> = [
  { value: "server", labelKey: "settings.genEngine.server" },
  { value: "local",  labelKey: "settings.genEngine.local" },
  { value: "auto",   labelKey: "settings.genEngine.auto" },
  { value: "sim",    labelKey: "settings.genEngine.simulator" },
];

