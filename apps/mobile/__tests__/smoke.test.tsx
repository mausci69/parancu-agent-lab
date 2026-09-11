import React from "react";
import { render } from "@testing-library/react-native";

// ---- Register all mocks BEFORE importing App ----

// RN/Expo basics
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// Native module stubs
jest.mock("expo-localization", () => ({
  getLocales: () => [
    { languageCode: "en", countryCode: "US", languageTag: "en-US", regionCode: "US", isRTL: false },
  ],
  getCalendars: () => [
    { calendar: "gregorian", timeZone: "Europe/Rome", uses24hourClock: true, firstWeekday: 1 },
  ],
}), { virtual: true });

// Avoid pulling DebugBanner (it imports things we don't want in a smoke test)
jest.mock("../src/components/DebugBanner", () => () => null);

// ✅ Mock API layer so api.ts (and ../local/*) are never executed
jest.mock("../src/lib/api", () => ({
  postFormData: jest.fn(async () => ({})),
  postJSON: jest.fn(async () => ({})),
  getJSON: jest.fn(async () => ({})),
  apiUrl: jest.fn(() => "http://test"),
  health: jest.fn(async () => ({ ok: true })),
  query: jest.fn(async () => ({ chunk: null, alt_chunk: null, trace: { duration_ms: 0 } })),
}), { virtual: true });

// ✅ Mock local LLM bootstrap used by App.tsx
jest.mock("../src/lib/llm/localGen", () => ({
  initLocalGen: jest.fn(() => void 0),
}), { virtual: true });

// Optional: silence client bootstrap logging if it's noisy
jest.mock("../src/lib/client", () => ({
  apiUrl: jest.fn(() => "http://test"),
  postJSON: jest.fn(async () => ({})),
  postFormData: jest.fn(async () => ({})),
  getJSON: jest.fn(async () => ({})),
}));

// If any fetch happens, keep it harmless
beforeAll(() => {
  // @ts-ignore
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
});

// Import App only after mocks are in place
import App from "../App";

it("renders App without crashing", () => {
  const { toJSON } = render(<App />);
  expect(toJSON()).toBeTruthy();
});
