/** Content-only check shared by server validation and browser corpus import. */
export function assertNoCredentials(text: string, keys: Array<string | null | undefined> = []): void {
  if (/sk-[A-Za-z0-9_-]{16,}/.test(text) ||
      keys.some(key => key && text.includes(key))) {
    throw new Error("Credentials must not appear in document content or model output.");
  }
}
