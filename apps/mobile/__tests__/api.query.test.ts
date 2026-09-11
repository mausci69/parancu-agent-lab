// Unit test for src/lib/api.query with local modules mapped to test doubles via moduleNameMapper

// Mock the HTTP client used by the API layer
jest.mock("../src/lib/client", () => ({
  apiUrl: jest.fn(() => "http://test"),
  postJSON: jest.fn(async () => ({
    chunk: "Top eco chunk",
    alt_chunk: null,
    trace: { duration_ms: 42 },
  })),
  postFormData: jest.fn(async () => ({})),
  getJSON: jest.fn(async () => ({})),
}));

import { query } from "../src/lib/api";

describe("api.query", () => {
  it("posts to /query and returns the expected shape", async () => {
    const res = await query("What is EcoSearch?");
    expect(res).toEqual({
      chunk: "Top eco chunk",
      alt_chunk: null,
      trace: { duration_ms: 42 },
    });
  });
});
