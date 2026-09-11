import { Alert } from "react-native";
import i18n from "../../i18n";

/**
 * Centralised alert helpers for the Upload (text) panel.
 * Use these instead of hardcoded strings.
 */

export function alertUploadFailed(detail?: unknown) {
  Alert.alert(
    i18n.t("upload.alert.uploadFailedTitle", "Upload failed"),
    i18n.t("common.error.requestFailed", "{{detail}}", {
      detail: String((detail as any)?.message ?? detail ?? ""),
    })
  );
}

export function alertEmpty() {
  Alert.alert(
    i18n.t("upload.alert.emptyTitle", "Nothing to upload"),
    i18n.t("upload.alert.emptyBody", "Please paste or select a text file before uploading.")
  );
}

export function alertUnsupported() {
  Alert.alert(
    i18n.t("upload.alert.unsupportedTitle", "Unsupported file"),
    i18n.t("common.error.unsupported", "Unsupported file type.")
  );
}

export function alertTooLarge() {
  Alert.alert(
    i18n.t("upload.alert.tooLargeTitle", "File too large"),
    i18n.t("common.error.tooLarge", "The file is too large after compression.")
  );
}

