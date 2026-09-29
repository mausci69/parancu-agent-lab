import { isIP } from "node:net";

/** Only an explicitly configured HTTPS origin enables public mode. */
export function parsePublicOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new Error("WEB_PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment.");
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.username || url.password ||
      (value !== url.origin && value !== `${url.origin}/`)) throw invalid();
  return url.origin;
}

export function readWebRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const publicOrigin = parsePublicOrigin(env.WEB_PUBLIC_ORIGIN);
  if (env.NODE_ENV === "production" && !publicOrigin) {
    throw new Error("WEB_PUBLIC_ORIGIN is required when NODE_ENV=production.");
  }
  // A platform-assigned port takes precedence over the local override.
  const rawPort = env.PORT ?? env.WEB_PORT ?? "3000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT or WEB_PORT must be an integer between 1 and 65535.");
  }
  const host = env.WEB_HOST ?? "127.0.0.1";
  if (host !== "localhost" && !isIP(host)) {
    throw new Error("WEB_HOST must be an IP address or localhost.");
  }
  return { port, host, publicOrigin };
}
