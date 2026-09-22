import type { CoordinatorAction } from "./types";

const DIRECT_RESPONSE_PATTERNS = [
  /^hello[!. ]*$/i,
  /^hi[!. ]*$/i,
  /^hey[!. ]*$/i,
  /^ciao[!. ]*$/i,
  /^thanks?[!. ]*$/i,
  /^thank you[!. ]*$/i,
  /^grazie[!. ]*$/i,
];

export function coordinate(userMessage: string): CoordinatorAction {
  const message = userMessage.trim();

  const canRespondDirectly = DIRECT_RESPONSE_PATTERNS.some((pattern) =>
    pattern.test(message)
  );

  if (canRespondDirectly) {
    return {
      action: "respond",
      message,
    };
  }

  return {
    action: "retrieve",
    query: message,
  };
}
