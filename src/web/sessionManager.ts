import { randomBytes } from "node:crypto";
import { KeyManager } from "./keyManager";
import { WebError } from "./corpusStore";

export const SESSION_COOKIE = "parancu_session";
type Session = { keys: KeyManager; lastSeen: number };

/** Credentials and session identifiers live only in this process. */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly capacity = 256,
    private readonly idleMs = 30 * 60 * 1000,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isSafeInteger(idleMs) || idleMs < 1) {
      throw new Error("Invalid session limits.");
    }
    this.timer = setInterval(() => this.expire(), Math.min(idleMs, 60_000));
    this.timer.unref();
  }

  private expire() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen >= this.idleMs) {
        session.keys.close();
        this.sessions.delete(id);
      }
    }
  }

  resolve(cookie: string | undefined, secure = false): { keys: KeyManager; setCookie?: string } {
    if (this.closed) throw new WebError(503, "The server is shutting down.");
    let id: string | undefined;
    for (const part of cookie?.split(";") ?? []) {
      const field = part.trim();
      const separator = field.indexOf("=");
      const name = (separator < 0 ? field : field.slice(0, separator)).trim();
      if (name !== SESSION_COOKIE) continue;
      const value = separator < 0 ? "" : field.slice(separator + 1);
      // Accept only canonical encodings of exactly 32 random bytes.
      if (id !== undefined || field.slice(0, separator) !== SESSION_COOKIE || !/^[A-Za-z0-9_-]{43}$/.test(value) ||
          Buffer.from(value, "base64url").toString("base64url") !== value) {
        throw new WebError(400, "Invalid session cookie.");
      }
      id = value;
    }
    this.expire();
    const existing = id === undefined ? undefined : this.sessions.get(id);
    if (existing) {
      existing.lastSeen = this.now();
      return { keys: existing.keys };
    }
    // Do not evict another browser's active credentials to admit a new session.
    if (this.sessions.size >= this.capacity) throw new WebError(503, "Session capacity reached. Try again later.");
    do { id = randomBytes(32).toString("base64url"); } while (this.sessions.has(id));
    const keys = new KeyManager();
    this.sessions.set(id, { keys, lastSeen: this.now() });
    return {
      keys,
      setCookie: `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`
    };
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const session of this.sessions.values()) session.keys.close();
    this.sessions.clear();
  }
}
