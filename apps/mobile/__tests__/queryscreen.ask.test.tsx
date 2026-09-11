import React from "react";
import { render, fireEvent } from "@testing-library/react-native";

// --- Mock TFJS native + core (no native bindings in Jest)
jest.mock("@tensorflow/tfjs-react-native", () => ({}), { virtual: true });
jest.mock("@tensorflow/tfjs", () => ({
  ready: jest.fn().mockResolvedValue(undefined),
  setBackend: jest.fn(),
  getBackend: jest.fn(() => "cpu"),
}), { virtual: true });

// --- Mock our TF init wrapper
jest.mock("../src/lib/tfjs", () => ({
  initTf: jest.fn(async () => undefined),
  isTfReady: jest.fn(() => true),
}), { virtual: true });

// --- Mock AsyncStorage with the official Jest mock
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// --- Mock i18n and API
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d || k }),
}));

jest.mock("../src/lib/api", () => ({
  query: jest.fn(async (q: string) => ({
    chunk: `Eco chunk for: ${q}`,
    alt_chunk: null,
    trace: { duration_ms: 50 },
  })),
}));

// Import after mocks
import QueryScreen from "../src/screens/QueryScreen";

describe("QueryScreen", () => {
  it("submits a question and displays a response", async () => {
    const { getByPlaceholderText, getByText, findByText } = render(<QueryScreen />);

    // Match your actual placeholder and button label from the render output
    fireEvent.changeText(getByPlaceholderText("Type your question…"), "What is EcoSearch?");
    fireEvent.press(getByText("Ask"));

    const result = await findByText(/Eco chunk for:/);
    expect(result).toBeTruthy();
  });
});
