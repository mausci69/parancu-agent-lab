import {
  requestCameraPermissionsAsync,
  requestMediaLibraryPermissionsAsync,
  launchCameraAsync,
  launchImageLibraryAsync,
  MediaTypeOptions,
  ImagePickerAsset,
} from "expo-image-picker";

export type PickSource = "camera" | "library";

async function toFormDataFromAsset(asset: ImagePickerAsset): Promise<FormData> {
  const form = new FormData();
  const uri = asset.uri;
  const name =
    asset.fileName ||
    uri.split("/").pop() ||
    `photo_${Date.now()}.${(asset.type === "image" && "jpg") || "bin"}`;
  // iOS often lacks mime; default to image/jpeg
  const type = asset.mimeType || "image/jpeg";
  form.append("file", {
    // @ts-ignore: React Native FormData file shape
    uri,
    name,
    type,
  });
  return form;
}

/**
 * Opens camera or gallery and returns a FormData with the selected image
 * ready to POST to /ocr_extract as { file: (image) }.
 * Returns null if the user cancels.
 */
export async function pickImageAsFormData(
  source: PickSource
): Promise<FormData | null> {
  if (source === "camera") {
    const { granted } = await requestCameraPermissionsAsync();
    if (!granted) throw new Error("Camera permission denied");
    const result = await launchCameraAsync({
      mediaTypes: MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: false,
      exif: false,
    });
    if (result.canceled || !result.assets?.length) return null;
    return await toFormDataFromAsset(result.assets[0]);
  } else {
    const { granted } = await requestMediaLibraryPermissionsAsync();
    if (!granted) throw new Error("Media library permission denied");
    const result = await launchImageLibraryAsync({
      mediaTypes: MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: false,
      exif: false,
    });
    if (result.canceled || !result.assets?.length) return null;
    return await toFormDataFromAsset(result.assets[0]);
  }
}

