/**
 * Centralised API client for EcoSearch Mobile.
 * Uses the configured backend URL unless offline mode is enabled.
 */

import { BACKEND_URL, OFFLINE_MODE } from "../../config";

const BASE_URL = BACKEND_URL;

function assertOnline(path: string): void {
  if (OFFLINE_MODE) {
    throw new Error(
      `Backend call blocked in offline mode: ${path}. This action must use the local mobile pipeline.`
    );
  }
}

export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_URL}${p}`;
}

function makeTimeoutController(timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeoutId };
}

export async function getJSON<T = any>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  assertOnline(path);

  const url = apiUrl(path);
  console.log("[client] GET", url);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(init.headers || {}),
    },
    ...init,
  });

  const text = await res.text();
  console.log("[client] GET status", res.status, "raw:", text.slice(0, 1000));

  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${text}`.trim());
  }

  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch (e) {
    throw new Error(`GET ${path} returned non-JSON response: ${String(e)}`);
  }
}

export async function postJSON<T = any>(
  path: string,
  body: unknown,
  timeoutOrInit: number | RequestInit = {}
): Promise<T> {
  assertOnline(path);

  const timeoutMs =
    typeof timeoutOrInit === "number" ? timeoutOrInit : 30000;
  const init = typeof timeoutOrInit === "number" ? {} : timeoutOrInit;

  const url = apiUrl(path);
  console.log("[client] POST", url, "body:", body);

  const { controller, timeoutId } = makeTimeoutController(timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      ...init,
    });

    const text = await res.text();
    console.log("[client] POST status", res.status, "raw:", text.slice(0, 1000));

    if (!res.ok) {
      throw new Error(`POST ${path} failed: ${res.status} ${text}`.trim());
    }

    try {
      return (text ? JSON.parse(text) : null) as T;
    } catch (e) {
      console.warn("[client] JSON parse error:", String(e));
      throw new Error(`POST ${path} returned non-JSON response.`);
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`POST ${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function postFormData<T = any>(
  path: string,
  formData: FormData,
  init: RequestInit = {},
  timeoutMs = 60000
): Promise<T> {
  assertOnline(path);

  const url = apiUrl(path);
  console.log("[client] POST(form)", url);

  const { controller, timeoutId } = makeTimeoutController(timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      body: formData,
      signal: controller.signal,
      ...(init || {}),
    });

    const ct = res.headers.get("content-type") || "";
    console.log("[client] POST(form) status", res.status, "content-type:", ct);

    if (!res.ok) {
      const errText = await res.text();
      console.log("[client] POST(form) error body:", errText.slice(0, 1000));
      throw new Error(
        `POST(form) ${path} failed: ${res.status} ${errText}`.trim()
      );
    }

    if (
      ct.includes("application/pdf") ||
      ct.includes("application/octet-stream")
    ) {
      return (await res.blob()) as any as T;
    }

    if (ct.includes("application/json")) {
      const json = await res.json();
      console.log("[client] POST(form) json ok");
      return json as T;
    }

    const text = await res.text();
    console.log("[client] POST(form) raw:", text.slice(0, 1000));

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as any as T;
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`POST(form) ${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function pingHealth(
  timeoutMs = 2000
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (OFFLINE_MODE) {
    return { ok: false, error: "Offline mode enabled" };
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(apiUrl("/health"), {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(id);
    return { ok: res.ok, status: res.status };
  } catch (err: any) {
    clearTimeout(id);
    return { ok: false, error: String(err?.message || err) };
  }
}

if (__DEV__) {
  console.log("[EcoSearch] Backend URL:", BASE_URL);
  console.log("[EcoSearch] Offline mode:", OFFLINE_MODE);
}

export { BASE_URL };