import React from "react";
import "../i18n"; // ensure i18n is initialised app-wide
import { OcrSessionProvider } from "../features/ocr/OcrSessionContext";

type Props = { children: React.ReactNode };

/**
 * Centralised app providers.
 * Add more context/providers here as we grow.
 */
export default function AppProviders({ children }: Props) {
  return <OcrSessionProvider>{children}</OcrSessionProvider>;
}

