import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

/**
 * Persists a PDF Blob to the device and (optionally) opens the share sheet.
 * Returns the local file URI.
 */
export async function savePdfBlob(
  blob: Blob,
  filename = `ocr_${Date.now()}.pdf`,
  openShareSheet = true
): Promise<string> {
  const base64 = await blobToBase64(blob);
  const uri = `${FileSystem.cacheDirectory}${filename}`;
  await FileSystem.writeAsStringAsync(uri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  if (openShareSheet && (await Sharing.isAvailableAsync())) {
    await Sharing.shareAsync(uri, {
      mimeType: "application/pdf",
      dialogTitle: "Share assembled PDF",
    });
  }
  return uri;
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject;
    r.onload = () => {
      const dataUrl = String(r.result ?? "");
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
      resolve(base64);
    };
    r.readAsDataURL(b);
  });
}

