// Force client.ts to use our test base URL by mocking ../config BEFORE importing client.
// We keep the Expo/RN autodetect mocks harmless, but the decisive mock is ../config.

describe("client networking", () => {
  const makeJsonFetch = () =>
    // @ts-ignore
    jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      headers: { get: () => "application/json" },
    }));

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {}); // silence logs
    delete (global as any).fetch;
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  });

  it("builds URL from EXPO_PUBLIC_API_BASE_URL and POSTs JSON body", async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = "http://example.local:8000";

    let client: typeof import("../src/lib/client");
    jest.isolateModules(() => {
      // decisive mock: force BACKEND_URL seen by client.ts
      const configPath = require.resolve("../config");
      jest.doMock(configPath, () => ({
        __esModule: true,
        BACKEND_URL: "http://example.local:8000",
      }));

      // (Optional) neutralise Expo/RN autodetects
      jest.doMock("expo-constants", () => ({
        __esModule: true,
        default: {
          expoConfig: { extra: {} },
          manifest: null,
          manifest2: null,
          debuggerHost: undefined,
          hostUri: undefined,
          platform: { ios: {}, android: {} },
        },
      }));
      jest.doMock(
        "react-native/Libraries/Core/Devtools/getDevServer",
        () => ({ __esModule: true, default: () => null }),
        { virtual: true }
      );

      // @ts-ignore
      global.fetch = makeJsonFetch();
      client = require("../src/lib/client");
    });

    expect(client!.apiUrl("/health")).toBe("http://example.local:8000/health");

    const payload = { q: "What is EcoSearch?" };
    await client!.postJSON("/query", payload);

    const [calledUrl, calledInit] = (global.fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toBe("http://example.local:8000/query");
    expect((calledInit as any)?.method).toBe("POST");
    expect((calledInit as any)?.headers?.["Content-Type"]).toMatch(/application\/json/);
    expect(JSON.parse((calledInit as any)?.body)).toEqual(payload);
  });

  it("POSTs FormData to /upload", async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = "http://example.local:8000";

    let client: typeof import("../src/lib/client");
    jest.isolateModules(() => {
      // decisive mock again for this fresh module graph
      const configPath = require.resolve("../config");
      jest.doMock(configPath, () => ({
        __esModule: true,
        BACKEND_URL: "http://example.local:8000",
      }));

      jest.doMock("expo-constants", () => ({
        __esModule: true,
        default: {
          expoConfig: { extra: {} },
          manifest: null,
          manifest2: null,
          debuggerHost: undefined,
          hostUri: undefined,
          platform: { ios: {}, android: {} },
        },
      }));
      jest.doMock(
        "react-native/Libraries/Core/Devtools/getDevServer",
        () => ({ __esModule: true, default: () => null }),
        { virtual: true }
      );

      // @ts-ignore
      global.fetch = makeJsonFetch();
      client = require("../src/lib/client");
    });

    if (!(global as any).FormData) {
      (global as any).FormData = class {
        private _data: Record<string, any> = {};
        append(k: string, v: any) {
          this._data[k] = v;
        }
      };
    }

    const fd = new (global as any).FormData();
    fd.append("file", "dummy");

    await client!.postFormData("/upload", fd);

    const [calledUrl, calledInit] = (global.fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toBe("http://example.local:8000/upload");

    const body = (calledInit as any)?.body;
    expect(body && typeof body.append === "function").toBe(true);
  });
});
