import { Alert } from "react-native";
import i18n from "../../i18n";

/** Show when the input is empty before retrieving. */
export function alertEmptyQuestion() {
  Alert.alert(
    i18n.t("ask.alert.emptyTitle", "Question required"),
    i18n.t("ask.alert.emptyBody", "Please type a question before retrieving.")
  );
}

/** Show when the Ask request fails. */
export function alertAskFailed(detail?: unknown) {
  Alert.alert(
    i18n.t("ask.failedTitle", "Ask failed"),
    i18n.t("ask.alert.failedBody", "We couldn’t complete your request. {{detail}}", {
      detail: String((detail as any)?.message ?? detail ?? ""),
    })
  );
}

