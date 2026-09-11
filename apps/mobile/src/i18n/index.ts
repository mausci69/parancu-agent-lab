// /apps/mobile/src/i18n/index.ts

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import * as Localization from "expo-localization";
import { getItemSafe } from "../utils/storage";
import { STORAGE_KEYS } from "../constants/storage";

const resources = {
  en: {
    translation: {
      tabs: {
        scan: "Scan",
        ask: "Ask",
        settings: "Settings",
        uploadText: "Upload",
        scanPdf: "Scan"
      },
      app: {
        title: "ParancU",
        apiBase: "API"
      },
      settings: {
        title: "Settings",
        language: "Language",
        english: "English",
        italian: "Italiano",
        toastChanged: "Language changed to {{lang}}",
        languageHint: "Applies to app text and messages.",
        ocrEngine: "OCR engine",
        ocrHint: "On-device may be slower but can work offline; server is faster when online.",
        server: "Server",
        device: "On-device",
        ocrEngine_help: "Choose where text is extracted.",
        ocrEngine_mlkit: "On-device (ML Kit)",
        ocrEngine_server: "Server (Tesseract)",
        airplaneNote: "Airplane mode: on-device OCR works offline.",
        genEngineTitle: "Generation engine",
        genEngine: {
          label: "Generation engine",
          server: "Server",
          local: "On-device",
          auto: "Auto (prefer local)",
          simulator: "Simulator"
        },
        genEngineOptions: {
          server: "Server",
          local: "On-device",
          auto: "Auto (prefer local)",
          simulator: "Simulator"
        },
        genHint: "Choose your preferred model. Some options require internet connectivity.",
        save: "Save",
        saving: "Saving…",
        saved: "Settings saved",
        saveErrorTitle: "Could not save",
        saveErrorBody: "Please try again."
      },
      ask: {
        screenTitle: "Ask the document",
        yourQuestion: "Your question",
        placeholder: "Type your question…",
        retrieve: "Retrieve best chunk",
        failedTitle: "Ask failed",
        topChunk: "Top chunk",
        time: "Time",
        searching: "Searching…",
        guidingQuestion: "Guiding question",
        topPassage: "Top passage",
        scoreLabel: "Score",
        showAlt: "Show alternative chunk",
        altChunk: "Alternative chunk",
        hideAlt: "Hide alternative",
        offlineAnswer: "Offline answer generated locally",
        lowConfidence: "Low confidence – consider retrying online",
        alert: {
          emptyTitle: "Question required",
          emptyBody: "Please type a question before retrieving.",
          failedBody: "We couldn’t complete your request. {{detail}}"
        }
      },
      prepare: {
        sendText: "Send text to prepare",
        ready: "Ready to ask",
        tooShortTitle: "Text is too short",
        tooShortBody: "Please paste or type a longer text before preparing the corpus."
      },
      health: {
        ok: "Backend online",
        offline: "Backend unreachable"
      },
      status: {
        local: {
          label: "Local LLM",
          ready: "Ready",
          loading: "Loading model…",
          error: "Not available"
        }
      },
      common: {
        ok: "OK",
        cancel: "Cancel",
        clear: "Clear",
        close: "Close",
        save: "Save",
        retry: "Retry",
        error: {
          badRequest: "Invalid request. Please check your input.",
          tooLarge: "The file is too large after compression.",
          unsupported: "Unsupported file type.",
          requestFailed: "Request failed."
        }
      },
      upload: {
        pasteLabel: "Paste text to index",
        placeholder: "Paste content here…",
        prepareBtn: "Prepare Corpus",
        clearBtn: "Clear Corpus",
        tooShort: "Text too short. Paste a few sentences at least.",
        prepared: "Prepared: {{status}}{{chunks}}",
        prepareFailed: "Prepare failed.",
        cleared: "Corpus cleared.",
        clearFailed: "Clear failed.",
        prepareFailedTitle: "Prepare failed",
        alert: {
          uploadFailedTitle: "Upload failed",
          tooLargeTitle: "File too large",
          unsupportedTitle: "Unsupported file",
          emptyTitle: "Nothing to upload",
          emptyBody: "Please paste or select a text file before uploading."
        }
      },
      ocr: {
        offline: {
          title: "Offline local generation (test)",
          subtitle: "Run on-device using the local generator stub (no internet).",
          genSummary: "Generate summary",
          genQuestions: "Generate questions",
          outputLabel: "Output",
          noSummary: "(no summary produced)",
          noQuestions: "(no questions produced)",
          noTextAlertTitle: "No text",
          noTextAlertBody: "Paste some text first.",
          summaryFailTitle: "Local summary failed",
          questionsFailTitle: "Local questions failed"
        },
        btn: {
          takePhoto: "Take Photo",
          chooseImage: "Choose Image"
        }
      },
      scan: {
        uploadImage: "Upload image",
        addPageCamera: "+ Add Page (Camera)",
        addPageGallery: "+ Add Page (Gallery)",
        retakeLast: "Retake last page",
        assemblePdf: "Assemble PDF",
        extractPages: "Extract text from pages",
        prepareFromText: "Prepare corpus from text",
        clearQueue: "Clear queue",
        flowTitle: "Scan pages → Preview → Assemble or Extract",
        pageCount_one: "{{count}} page",
        pageCount_other: "{{count}} pages",
        pageCount: "Pages: {{count}}",
        ocrLanguageLabel: "OCR language:",
        langEnglish: "English",
        langItalian: "Italiano",
        prepareCorpus: "Prepare Corpus",
        saveBtn: "Save Corpus",
        loadBtn: "Load Corpus",
        chooseCorpus: "Choose a saved corpus to load.",
        chooseName: "Choose a name for the saved corpus.",
        savedCorpusShort: "Prepared corpus saved.",
        loadedSavedCorpusShort: "Saved corpus loaded.",
        noActiveCorpusToSave: "No active prepared corpus to save.",
        noSavedCorpus: "No saved prepared corpus found.",
        saveFailed: "Save failed.",
        saveFailedTitle: "Save failed",
        loadFailed: "Load failed.",
        loadFailedTitle: "Load failed",
        backend: {
          okBadge: "Backend: {{status}} — OCR: ready ({{lang}})",
          unreachableBadge: "Backend unreachable: {{status}}"
        },
        offlineBanner:
          "Can’t reach the server right now. You can still queue pages, but actions that contact the backend will be disabled.",
        noPagesYet: "No pages yet. Add your first page.",
        processing_one: "Processing {{count}} page (~{{kb}} KB)…",
        processing_other: "Processing {{count}} pages (~{{kb}} KB)…",
        largeTip:
          "Tip: total size is large. We’ll add pre-upload downscaling next to speed this up.",
        combinedTitle: "Combined text preview",
        pageOk: "✓ Page {{n}}",
        pageFail: "✗ Page {{n}} — {{error}}",
        debugLang: "Debug: OCR server={{lang}} · pages={{n}}",
        reorderTip:
          "Tip: reorder pages with ← →, retake the last capture, then assemble into a single PDF.",
        hints: {
          tooLarge: "Hint: images are too large. Try fewer pages or lower resolution.",
          unsupportedType: "Hint: unsupported file type. Use JPEG/PNG photos.",
          requestInvalid: "Hint: request invalid. Reorder pages or retake a blurry photo."
        },
        alert: {
          pdfSavedTitle: "PDF saved",
          pdfSavedBody: "Saved to: {{uri}}",
          assembleFailedTitle: "Assemble failed",
          extractFailedTitle: "Extract failed",
          cameraErrorTitle: "Camera error",
          cameraErrorBody: "Failed to open camera. {{detail}}",
          galleryErrorTitle: "Gallery error",
          galleryErrorBody: "Failed to open gallery. {{detail}}"
        }
      }
    }
  },
  it: {
    translation: {
      common: {
        ok: "OK",
        cancel: "Annulla",
        clear: "Svuota",
        close: "Chiudi",
        save: "Salva",
        retry: "Riprova",
        error: {
          badRequest: "Richiesta non valida. Controlla i dati inseriti.",
          tooLarge: "Il file è troppo grande anche dopo la compressione.",
          unsupported: "Tipo di file non supportato.",
          requestFailed: "Richiesta non riuscita."
        }
      },
      tabs: {
        scan: "Scansiona",
        ask: "Chiedi",
        settings: "Impostazioni",
        uploadText: "Carica",
        scanPdf: "Scansiona"
      },
      app: {
        title: "ParancU",
        apiBase: "API"
      },
      settings: {
        title: "Impostazioni",
        language: "Lingua",
        english: "English",
        italian: "Italiano",
        toastChanged: "Lingua cambiata in {{lang}}",
        languageHint: "Si applica al testo e ai messaggi dell’app.",
        ocrEngine: "Motore OCR",
        ocrHint: "Sul dispositivo può essere più lento ma funziona offline; il server è più veloce quando sei online.",
        server: "Server",
        device: "Sul dispositivo",
        ocrEngine_help: "Scegli dove estrarre il testo.",
        ocrEngine_mlkit: "Sul dispositivo (ML Kit)",
        ocrEngine_server: "Server (Tesseract)",
        airplaneNote: "Modalità aereo: l’OCR sul dispositivo funziona offline.",
        genEngineTitle: "Motore di generazione",
        genEngine: {
          label: "Motore di generazione",
          server: "Server",
          local: "Sul dispositivo",
          auto: "Auto (preferisci locale)",
          simulator: "Simulatore"
        },
        genEngineOptions: {
          server: "Server",
          local: "Sul dispositivo",
          auto: "Auto (preferisci locale)",
          simulator: "Simulatore"
        },
        genHint: "Scegli il modello preferito. Alcune opzioni richiedono connessione a Internet.",
        save: "Salva",
        saving: "Salvataggio in corso…",
        saved: "Impostazioni salvate",
        saveErrorTitle: "Impossibile salvare",
        saveErrorBody: "Riprova, per favore."
      },
      ask: {
        screenTitle: "Chiedi al documento",
        yourQuestion: "La tua domanda",
        placeholder: "Scrivi la tua domanda…",
        retrieve: "Recupera il miglior blocco",
        failedTitle: "Richiesta fallita",
        topChunk: "Blocco principale",
        time: "Tempo",
        searching: "Ricerca in corso…",
        guidingQuestion: "Domanda guida",
        topPassage: "Passaggio principale",
        scoreLabel: "Punteggio",
        showAlt: "Mostra passaggio alternativo",
        altChunk: "Passaggio alternativo",
        hideAlt: "Nascondi alternativa",
        offlineAnswer: "Risposta offline generata localmente",
        lowConfidence: "Bassa confidenza – prova di nuovo online",
        alert: {
          emptyTitle: "Domanda obbligatoria",
          emptyBody: "Scrivi una domanda prima di procedere.",
          failedBody: "Non è stato possibile completare la richiesta. {{detail}}"
        }
      },
      prepare: {
        sendText: "Invia testo per la preparazione",
        ready: "Pronto per chiedere",
        tooShortTitle: "Testo troppo corto",
        tooShortBody: "Incolla o scrivi un testo più lungo prima di preparare il corpus."
      },
      health: {
        ok: "Backend online",
        offline: "Backend non raggiungibile"
      },
      upload: {
        pasteLabel: "Incolla il testo da indicizzare",
        placeholder: "Incolla il contenuto qui…",
        prepareBtn: "Prepara il corpus",
        clearBtn: "Pulisci il corpus",
        tooShort: "Testo troppo breve. Incolla almeno qualche frase.",
        prepared: "Preparato: {{status}}{{chunks}}",
        prepareFailed: "Preparazione non riuscita.",
        cleared: "Corpus svuotato.",
        clearFailed: "Pulizia non riuscita.",
        prepareFailedTitle: "Preparazione non riuscita",
        alert: {
          uploadFailedTitle: "Caricamento non riuscito",
          tooLargeTitle: "File troppo grande",
          unsupportedTitle: "File non supportato",
          emptyTitle: "Niente da caricare",
          emptyBody: "Incolla o seleziona un file di testo prima di caricare."
        }
      },
      ocr: {
        offline: {
          title: "Generazione locale offline (test)",
          subtitle: "Esegui sul dispositivo usando il generatore locale (senza internet).",
          genSummary: "Genera riassunto",
          genQuestions: "Genera domande",
          outputLabel: "Output",
          noSummary: "(nessun riassunto prodotto)",
          noQuestions: "(nessuna domanda prodotta)",
          noTextAlertTitle: "Nessun testo",
          noTextAlertBody: "Incolla prima del testo.",
          summaryFailTitle: "Errore nel riassunto locale",
          questionsFailTitle: "Errore nelle domande locali"
        },
        btn: {
          takePhoto: "Scatta foto",
          chooseImage: "Scegli immagine"
        }
      },
      scan: {
        uploadImage: "Carica immagine",
        addPageCamera: "+ Aggiungi pagina (Fotocamera)",
        addPageGallery: "+ Aggiungi pagina (Galleria)",
        retakeLast: "Rifai l’ultima pagina",
        assemblePdf: "Crea PDF",
        extractPages: "Estrai testo dalle pagine",
        prepareFromText: "Prepara il corpus dal testo",
        clearQueue: "Svuota coda",
        flowTitle: "Scansiona pagine → Anteprima → Crea o Estrai",
        pageCount_one: "{{count}} pagina",
        pageCount_other: "{{count}} pagine",
        pageCount: "Pagine: {{count}}",
        ocrLanguageLabel: "Lingua OCR:",
        langEnglish: "English",
        langItalian: "Italiano",
        prepareCorpus: "Prepara corpus",
        saveBtn: "Salva corpus",
        loadBtn: "Carica corpus",
        chooseCorpus: "Scegli un corpus salvato da caricare.",
        chooseName: "Scegli un nome per il corpus salvato.",
        savedCorpusShort: "Corpus salvato.",
        loadedSavedCorpusShort: "Corpus caricato.",
        noActiveCorpusToSave: "Nessun corpus preparato attivo da salvare.",
        noSavedCorpus: "Nessun corpus salvato trovato.",
        saveFailed: "Salvataggio non riuscito.",
        saveFailedTitle: "Salvataggio non riuscito",
        loadFailed: "Caricamento non riuscito.",
        loadFailedTitle: "Caricamento non riuscito",
        backend: {
          okBadge: "Backend: {{status}} — OCR: pronto ({{lang}})",
          unreachableBadge: "Backend non raggiungibile: {{status}}"
        },
        offlineBanner:
          "Impossibile raggiungere il server. Puoi accodare pagine, ma le azioni che contattano il backend saranno disabilitate.",
        noPagesYet: "Nessuna pagina ancora. Aggiungi la prima pagina.",
        processing_one: "Elaborazione di {{count}} pagina (~{{kb}} KB)…",
        processing_other: "Elaborazione di {{count}} pagine (~{{kb}} KB)…",
        largeTip:
          "Suggerimento: la dimensione totale è elevata. A breve aggiungeremo il ridimensionamento prima del caricamento per velocizzare.",
        combinedTitle: "Anteprima testo combinato",
        pageOk: "✓ Pagina {{n}}",
        pageFail: "✗ Pagina {{n}} — {{error}}",
        debugLang: "Debug: OCR server={{lang}} · pagine={{n}}",
        reorderTip:
          "Suggerimento: riordina le pagine con ← →, rifai l’ultima acquisizione, poi crea un unico PDF.",
        hints: {
          tooLarge: "Suggerimento: le immagini sono troppo grandi. Prova con meno pagine o una risoluzione inferiore.",
          unsupportedType: "Suggerimento: tipo di file non supportato. Usa foto JPEG/PNG.",
          requestInvalid: "Suggerimento: richiesta non valida. Riordina le pagine o ripeti la foto se è sfocata."
        },
        alert: {
          pdfSavedTitle: "PDF salvato",
          pdfSavedBody: "Salvato in: {{uri}}",
          assembleFailedTitle: "Creazione PDF non riuscita",
          extractFailedTitle: "Estrazione non riuscita",
          cameraErrorTitle: "Errore fotocamera",
          cameraErrorBody: "Impossibile aprire la fotocamera. {{detail}}",
          galleryErrorTitle: "Errore galleria",
          galleryErrorBody: "Impossibile aprire la galleria. {{detail}}"
        }
      }
    }
  }
};

const tag =
  (Localization as any).getLocales?.()[0]?.languageTag ??
  (Localization as any).locale ??
  "";
const device =
  typeof tag === "string" && tag.trim().length ? tag.split("-")[0] : "en";

i18n.use(initReactI18next).init({
  resources,
  lng: device,
  fallbackLng: "en",
  compatibilityJSON: "v3",
  interpolation: {
    escapeValue: false,
    defaultVariables: { lang: "English" }
  }
});

(async () => {
  try {
    const saved = await getItemSafe(STORAGE_KEYS.APP_LANG);
    if (saved && saved !== i18n.language) {
      await i18n.changeLanguage(saved);
    }
  } catch {
    // Ignore and keep device/default language.
  }
})();

export default i18n;