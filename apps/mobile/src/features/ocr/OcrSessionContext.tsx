import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Alert } from "react-native";

export type OcrLang = "en" | "it";

export type OcrPage = {
  id: string;        // stable id (e.g. Date.now()+rand)
  uri: string;       // file:// or asset uri
  kb?: number;       // approx size in KB (optional)
  error?: string;    // error message for this page (optional)
};

type OcrSessionState = {
  pages: OcrPage[];
  lang: OcrLang;
  busy: boolean;
  combinedText: string; // preview after extraction/assembly
};

type OcrSessionApi = {
  addPage: (page: OcrPage) => void;
  replaceLast: (page: OcrPage) => void;
  clearQueue: () => void;
  setLang: (lang: OcrLang) => void;
  setBusy: (on: boolean) => void;
  setPageError: (id: string, msg: string) => void;
  setCombinedText: (text: string) => void;

  // Placeholders for upcoming steps
  assemblePdf: () => Promise<void>;
  extractPages: () => Promise<void>;
};

const OcrSessionContext = createContext<(OcrSessionState & OcrSessionApi) | null>(null);

export function OcrSessionProvider({ children }: { children: React.ReactNode }) {
  const [pages, setPages] = useState<OcrPage[]>([]);
  const [lang, setLang] = useState<OcrLang>("en");
  const [busy, setBusy] = useState(false);
  const [combinedText, setCombinedText] = useState("");

  const addPage = useCallback((page: OcrPage) => {
    setPages((prev) => [...prev, page]);
  }, []);

  const replaceLast = useCallback((page: OcrPage) => {
    setPages((prev) => (prev.length ? [...prev.slice(0, -1), page] : [page]));
  }, []);

  const clearQueue = useCallback(() => {
    setPages([]);
    setCombinedText("");
  }, []);

  const setPageError = useCallback((id: string, msg: string) => {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, error: msg } : p)));
  }, []);

  // Stubs to be implemented in following steps
  const assemblePdf = useCallback(async () => {
    Alert.alert("Assemble PDF", "Not implemented yet.");
  }, []);

  const extractPages = useCallback(async () => {
    Alert.alert("Extract Pages", "Not implemented yet.");
  }, []);

  const value = useMemo(
    () => ({
      pages,
      lang,
      busy,
      combinedText,
      addPage,
      replaceLast,
      clearQueue,
      setLang,
      setBusy,
      setPageError,
      setCombinedText,
      assemblePdf,
      extractPages,
    }),
    [pages, lang, busy, combinedText, addPage, replaceLast, clearQueue, setLang, setBusy, setPageError, assemblePdf, extractPages]
  );

  return <OcrSessionContext.Provider value={value}>{children}</OcrSessionContext.Provider>;
}

export function useOcrSession() {
  const ctx = useContext(OcrSessionContext);
  if (!ctx) {
    throw new Error("useOcrSession must be used within an OcrSessionProvider");
  }
  return ctx;
}

