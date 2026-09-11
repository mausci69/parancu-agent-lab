import {
  requestCameraPermissionsAsync,
  requestMediaLibraryPermissionsAsync,
  launchCameraAsync,
  launchImageLibraryAsync,
  ImagePickerAsset,
} from "expo-image-picker";

export type PickSource = "camera" | "library";

/**
 * Opens camera or gallery and returns a FormData with the selected image,
 * ready for multipart upload.
 * Returns null if the user cancels.
 */
export async function pickImageAsFormData(
  source: PickSource
): Promise<FormData | null> {
  const asset = await pickImageAsset(source);
  if (!asset) return null;
  return buildFormDataFromAssets([asset]);
}

/** Pick a single image and return the raw ImagePickerAsset (or null if cancelled). */
export async function pickImageAsset(
  source: PickSource
): Promise<ImagePickerAsset | null> {
  if (source === "camera") {
    const { granted } = await requestCameraPermissionsAsync();
    if (!granted) {
      throw new Error("Camera permission denied");
    }
  } else {
    const { granted } = await requestMediaLibraryPermissionsAsync();
    if (!granted) {
      throw new Error("Media library permission denied");
    }
  }

  const pickerOpts = {
    mediaTypes: ["images"],
    quality: 0.8,
    allowsEditing: false,
    exif: false,
  } as any;

  const result =
    source === "camera"
      ? await launchCameraAsync(pickerOpts)
      : await launchImageLibraryAsync(pickerOpts);

  if (result.canceled || !result.assets?.length) {
    return null;
  }

  return result.assets[0] ?? null;
}

/**
 * Build a multipart FormData for multiple images.
 * Appends each page under the "files" key.
 */
export function buildFormDataFromAssets(
  assets: ImagePickerAsset[]
): FormData {
  const form = new FormData();

  assets.forEach((asset, idx) => {
    form.append("files", {
      uri: asset.uri,
      name: asset.fileName ?? `scan_${idx + 1}.jpg`,
      type: asset.mimeType ?? "image/jpeg",
    } as any);
  });

  return form;
}