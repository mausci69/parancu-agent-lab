// apps/mobile/src/features/ocr/MultiPageScan.tsx

import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import type { ImagePickerAsset } from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";

import {
  health,
  ocrExtractPagesSmart,
  prepareCorpusFromText,
} from "../../lib/api";
import { pickImageAsset } from "./pickImage";

type Props = {
  styles: {
    cardLarge: any;
    sectionTitle: any;
    button: any;
    buttonDisabled: any;
    buttonText: any;
    muted: any;
    chunkBox?: any;
    chunkText?: any;
  };
  ocrLang: "en" | "it";
  setOcrLang: (lang: "en" | "it") => Promise<void>;
  onCorpusPrepared: () => Promise<void> | void;
};

const ui = StyleSheet.create({
  cardNoPanel: {
    backgroundColor: "transparent",
    borderWidth: 0,
  },
  iconsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
    backgroundColor: "transparent",
  },
  iconButton: {
    flex: 1,
    height: 96,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "transparent",
    borderWidth: 0,
  },
  iconButtonLeft: {
    marginRight: 10,
  },
  iconButtonRight: {
    marginLeft: 10,
  },
  iconText: {
    fontSize: 96,
    fontWeight: "700",
    lineHeight: 96,
  },
  thumbnails: {
    marginVertical: 14,
  },
  thumbnailsContent: {
    gap: 10,
    alignItems: "center",
    justifyContent: "center",
    flexGrow: 1,
  },
  thumbnailWrapper: {
    position: "relative",
  },
  thumbnail: {
    width: 120,
    height: 160,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#1c6a52",
  },
  removeButton: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1c6a52",
  },
  removeButtonText: {
    color: "#ffffff",
    fontWeight: "700",
  },
  actionRow: {
    marginTop: 14,
  },
  actionButton: {
    width: "100%",
    minHeight: 64,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  actionButtonText: {
    fontSize: 18,
    fontWeight: "800",
  },
  previewSection: {
    marginTop: 16,
    gap: 10,
  },
  previewBox: {
    minHeight: 220,
    maxHeight: 360,
  },
  previewInput: {
    minHeight: 190,
    color: "#ffffff",
    fontSize: 16,
    lineHeight: 23,
    textAlignVertical: "top",
  },
  previewHint: {
    marginTop: 0,
  },
});

export default function MultiPageScan({
  styles,
  ocrLang,
  onCorpusPrepared,
}: Props) {
  const { t } = useTranslation();

  const [assets, setAssets] = useState<ImagePickerAsset[]>([]);
  const [combinedText, setCombinedText] = useState("");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [prepBusy, setPrepBusy] = useState(false);
  const [prepMsg, setPrepMsg] = useState("");

  const anyBusy = useMemo(
    () => ocrBusy || prepBusy,
    [ocrBusy, prepBusy]
  );

  const hasExtractedText = combinedText.trim().length > 0;

  const resetExtractedText = () => {
    setCombinedText("");
    setPrepMsg("");
  };

  async function maybeDownscaleAsset(
    asset: ImagePickerAsset
  ): Promise<ImagePickerAsset> {
    try {
      const width = asset.width;
      const height = asset.height;
      const fileSize = (asset as any)?.fileSize as number | undefined;

      const maxDimension = 2000;
      const actions: ImageManipulator.Action[] = [];

      if (width && height) {
        const currentMaxDimension = Math.max(width, height);

        if (currentMaxDimension > maxDimension) {
          const scale = maxDimension / currentMaxDimension;

          actions.push({
            resize: {
              width: Math.round(width * scale),
              height: Math.round(height * scale),
            },
          });
        }
      }

      const result = await ImageManipulator.manipulateAsync(
        asset.uri,
        actions,
        {
          compress: 0.8,
          format: ImageManipulator.SaveFormat.JPEG,
        }
      );

      return {
        ...asset,
        uri: result.uri,
        width: result.width ?? width,
        height: result.height ?? height,
        mimeType: "image/jpeg",
        fileName: asset.fileName ?? `page_${Date.now()}.jpg`,
        fileSize,
      } as ImagePickerAsset;
    } catch {
      return asset;
    }
  }

  const addFrom = async (source: "camera" | "library") => {
    try {
      const asset = await pickImageAsset(source);

      if (!asset) {
        return;
      }

      const processed = await maybeDownscaleAsset(asset);

      setAssets((previous) => [...previous, processed]);
      resetExtractedText();
    } catch (error: any) {
      Alert.alert(
        t(
          source === "camera"
            ? "scan.alert.cameraErrorTitle"
            : "scan.alert.galleryErrorTitle"
        ),
        t(
          source === "camera"
            ? "scan.alert.cameraErrorBody"
            : "scan.alert.galleryErrorBody",
          { detail: String(error?.message ?? "") }
        )
      );
    }
  };

  const removeAt = (index: number) => {
    setAssets((previous) =>
      previous.filter((_, currentIndex) => currentIndex !== index)
    );
    resetExtractedText();
  };

  const buildFilesForm = () => {
    const form = new FormData();

    assets.forEach((asset, index) => {
      form.append(
        "files",
        {
          uri: asset.uri,
          name: asset.fileName || `page_${index + 1}.jpg`,
          type: asset.mimeType || "image/jpeg",
        } as any
      );
    });

    return form;
  };

  const onRunOcr = async () => {
    if (!assets.length || anyBusy) {
      return;
    }

    setOcrBusy(true);
    setPrepMsg("");

    try {
      const backendHealth = await health();

      if (!backendHealth || backendHealth.status !== "ok") {
        Alert.alert(
          t("scan.backend.unreachableTitle", "Server not reachable"),
          t(
            "scan.backend.unreachableBody",
            "Check that the ParancU backend is running and your device is on the same Wi-Fi."
          )
        );
        return;
      }

      const form = buildFilesForm();
      const ocrResponse: any = await ocrExtractPagesSmart(
        assets.map((asset, index) => ({
          uri: asset.uri,
          name: asset.fileName || `page-${index + 1}.jpg`,
        })),
        form,
        { lang: ocrLang }
      );

      const extractedText = String(ocrResponse?.text || "").trim();

      if (!extractedText) {
        setCombinedText("");

        Alert.alert(
          t("prepare.tooShortTitle", "Text too short"),
          t(
            "prepare.tooShortBody",
            "OCR returned no usable text. Please retake the photo and try again."
          )
        );
        return;
      }

      setCombinedText(extractedText);
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status;
      const detail =
        error?.body?.detail ??
        error?.response?.data?.detail ??
        error?.message ??
        error;

      Alert.alert(
        t("scan.ocrFailedTitle", "OCR failed") +
          (status ? ` (HTTP ${status})` : ""),
        String(detail)
      );
    } finally {
      setOcrBusy(false);
    }
  };

  const onPrepareCorpus = async () => {
    const text = combinedText.trim();

    if (!text || anyBusy) {
      return;
    }

    setPrepBusy(true);
    setPrepMsg("");

    try {
      const prepareResponse: any = await prepareCorpusFromText(
        text,
        60000,
        undefined,
        { corpusLanguage: ocrLang }
      );

      if (!prepareResponse?.ready) {
        const message =
          prepareResponse?.message ||
          prepareResponse?.status ||
          t(
            "prepare.failedGeneric",
            "Could not prepare corpus. Please try again."
          );

        setPrepMsg(message);
        Alert.alert(t("upload.prepareFailedTitle", "Prepare failed"), message);
        return;
      }

      const message =
        prepareResponse.message ||
        t("prepare.ready", "Ready to ask");

      setPrepMsg(message);
      await onCorpusPrepared();
      Alert.alert(message);
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status;
      const detail =
        error?.body?.detail ??
        error?.response?.data?.detail ??
        error?.message ??
        error;

      const message = String(detail);

      setPrepMsg(message);
      Alert.alert(
        t("upload.prepareFailedTitle", "Prepare failed") +
          (status ? ` (HTTP ${status})` : ""),
        message
      );
    } finally {
      setPrepBusy(false);
    }
  };

  const onPrimaryAction = async () => {
    if (hasExtractedText) {
      await onPrepareCorpus();
      return;
    }

    await onRunOcr();
  };

  const primaryActionDisabled =
    anyBusy || (!hasExtractedText && assets.length === 0);

  return (
    <View style={[styles.cardLarge, ui.cardNoPanel]}>
      <View style={ui.iconsRow}>
        <TouchableOpacity
          onPress={() => addFrom("camera")}
          style={[
            styles.button,
            ui.iconButton,
            ui.iconButtonLeft,
            anyBusy && styles.buttonDisabled,
          ]}
          disabled={anyBusy}
        >
          <Text style={[styles.buttonText, ui.iconText]}>📷</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => addFrom("library")}
          style={[
            styles.button,
            ui.iconButton,
            ui.iconButtonRight,
            anyBusy && styles.buttonDisabled,
          ]}
          disabled={anyBusy}
        >
          <Text style={[styles.buttonText, ui.iconText]}>🖼</Text>
        </TouchableOpacity>
      </View>

      {assets.length > 0 ? (
        <ScrollView
          horizontal
          style={ui.thumbnails}
          contentContainerStyle={ui.thumbnailsContent}
          showsHorizontalScrollIndicator={false}
        >
          {assets.map((asset, index) => (
            <View
              key={asset.assetId ?? asset.uri ?? String(index)}
              style={ui.thumbnailWrapper}
            >
              <Image
                source={{ uri: asset.uri }}
                style={ui.thumbnail}
                resizeMode="cover"
              />

              <TouchableOpacity
                onPress={() => removeAt(index)}
                style={ui.removeButton}
                disabled={anyBusy}
              >
                <Text style={ui.removeButtonText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {!!hasExtractedText && (
        <View style={ui.previewSection}>
          <Text style={styles.sectionTitle}>
            {t("scan.textPreview", "Text preview")}
          </Text>

          <View style={[styles.chunkBox, ui.previewBox]}>
            <TextInput
              style={[styles.chunkText, ui.previewInput]}
              multiline
              value={combinedText}
              onChangeText={(value) => {
                setCombinedText(value);
                setPrepMsg("");
              }}
              editable={!anyBusy}
              placeholder={t(
                "scan.extractedTextPlaceholder",
                "OCR text will appear here."
              )}
              placeholderTextColor="#8aa59d"
            />
          </View>

          <Text style={[styles.muted, ui.previewHint]}>
            {t(
              "scan.reviewExtractedText",
              "Review and edit the extracted text before preparing the corpus."
            )}
          </Text>
        </View>
      )}

      {assets.length > 0 && (
        <View style={ui.actionRow}>
          <TouchableOpacity
            onPress={onPrimaryAction}
            style={[
              styles.button,
              ui.actionButton,
              primaryActionDisabled && styles.buttonDisabled,
            ]}
            disabled={primaryActionDisabled}
          >
            {anyBusy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.buttonText, ui.actionButtonText]}>
                {hasExtractedText
                  ? t("scan.prepareCorpus", "Prepare Corpus")
                  : t("scan.runOcr", "Run OCR")}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {!!prepMsg && <Text style={styles.muted}>{prepMsg}</Text>}
    </View>
  );
}