// New_EcoSearch/EcoSearch_v1_mobile_llm/apps/mobile/src/local/corpusStore.ts

import * as FileSystem from "expo-file-system/legacy";
import type { PrepareResult } from "./prepareCorpus";

const CORPUS_DIR = `${FileSystem.documentDirectory}ecosearch-corpora/`;
const ACTIVE_CORPUS_FILE_URI = `${CORPUS_DIR}active-corpus.json`;
const LIBRARY_INDEX_FILE_URI = `${CORPUS_DIR}manifest.json`;
const ACTIVE_LIBRARY_ID_FILE_URI = `${CORPUS_DIR}active-library-id.txt`;

export type SaveToLibraryInput = {
  id: string;
  name: string;
  corpus: PrepareResult;
};

export type SavedCorpusMeta = {
  id: string;
  name: string;
  savedAt: string;
};

type StoredPreparedCorpus = PrepareResult & {
  savedAt: string;
};

type StoredLibraryIndexItem = SavedCorpusMeta & {
  fileUri: string;
};

function getCorpusFileUri(id: string): string {
  return `${CORPUS_DIR}${id}.json`;
}

function toPrepareResult(value: StoredPreparedCorpus): PrepareResult {
  return {
    docId: value.docId,
    sentences: value.sentences,
    chunks: value.chunks,
  };
}

function isValidPreparedCorpus(value: any): value is StoredPreparedCorpus {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.docId === "string" &&
    Array.isArray(value.sentences) &&
    Array.isArray(value.chunks)
  );
}

function isValidLibraryIndex(value: any): value is StoredLibraryIndexItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        !!item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.savedAt === "string" &&
        typeof item.fileUri === "string"
    )
  );
}

async function ensureCorpusDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(CORPUS_DIR);

  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(CORPUS_DIR, {
      intermediates: true,
    });
  }
}

function sanitiseLibraryIndex(
  items: StoredLibraryIndexItem[]
): StoredLibraryIndexItem[] {
  const seen = new Set<string>();

  return items
    .filter((item) => {
      if (!item?.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) =>
      String(b.savedAt || "").localeCompare(String(a.savedAt || ""))
    );
}

async function readLibraryIndex(): Promise<StoredLibraryIndexItem[]> {
  try {
    await ensureCorpusDir();

    const info = await FileSystem.getInfoAsync(LIBRARY_INDEX_FILE_URI);
    if (!info.exists) return [];

    const raw = await FileSystem.readAsStringAsync(LIBRARY_INDEX_FILE_URI, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const parsed = JSON.parse(raw);
    if (!isValidLibraryIndex(parsed)) return [];

    return sanitiseLibraryIndex(parsed);
  } catch {
    return [];
  }
}

async function writeLibraryIndex(
  items: StoredLibraryIndexItem[]
): Promise<void> {
  await ensureCorpusDir();

  const cleaned = sanitiseLibraryIndex(items);

  await FileSystem.writeAsStringAsync(
    LIBRARY_INDEX_FILE_URI,
    JSON.stringify(cleaned, null, 2),
    { encoding: FileSystem.EncodingType.UTF8 }
  );
}

async function writeCorpusFile(
  fileUri: string,
  corpus: PrepareResult
): Promise<string> {
  await ensureCorpusDir();

  const savedAt = new Date().toISOString();
  const payload: StoredPreparedCorpus = {
    ...corpus,
    savedAt,
  };

  await FileSystem.writeAsStringAsync(
    fileUri,
    JSON.stringify(payload, null, 2),
    { encoding: FileSystem.EncodingType.UTF8 }
  );

  return savedAt;
}

async function readCorpusFile(fileUri: string): Promise<PrepareResult | null> {
  try {
    await ensureCorpusDir();

    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) return null;

    const raw = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const parsed = JSON.parse(raw);
    if (!isValidPreparedCorpus(parsed)) return null;

    return toPrepareResult(parsed);
  } catch {
    return null;
  }
}

export async function savePreparedCorpus(
  corpus: PrepareResult
): Promise<void> {
  await writeCorpusFile(ACTIVE_CORPUS_FILE_URI, corpus);
}

export async function loadActiveCorpus(): Promise<PrepareResult | null> {
  return readCorpusFile(ACTIVE_CORPUS_FILE_URI);
}

export async function clearActiveCorpus(): Promise<void> {
  try {
    await ensureCorpusDir();

    const activeCorpusInfo = await FileSystem.getInfoAsync(ACTIVE_CORPUS_FILE_URI);
    if (activeCorpusInfo.exists) {
      await FileSystem.deleteAsync(ACTIVE_CORPUS_FILE_URI, {
        idempotent: true,
      });
    }

    const activeLibraryIdInfo = await FileSystem.getInfoAsync(ACTIVE_LIBRARY_ID_FILE_URI);
    if (activeLibraryIdInfo.exists) {
      await FileSystem.deleteAsync(ACTIVE_LIBRARY_ID_FILE_URI, {
        idempotent: true,
      });
    }
  } catch {
    // Ignore cleanup errors.
  }
}

export async function saveCorpusToLibrary(
  input: SaveToLibraryInput
): Promise<void> {
  const fileUri = getCorpusFileUri(input.id);
  const savedAt = await writeCorpusFile(fileUri, input.corpus);

  const current = await readLibraryIndex();
  const next: StoredLibraryIndexItem[] = [
    {
      id: input.id,
      name: input.name,
      savedAt,
      fileUri,
    },
    ...current.filter((item) => item.id !== input.id),
  ];

  await writeLibraryIndex(next);

  console.log("[corpusStore] Saved corpus to library:", {
    id: input.id,
    name: input.name,
    fileUri,
    savedAt,
  });
}

export async function listSavedCorpora(): Promise<SavedCorpusMeta[]> {
  const index = await readLibraryIndex();

  return index.map(({ id, name, savedAt }) => ({
    id,
    name,
    savedAt,
  }));
}

export async function loadCorpusFromLibrary(
  id: string
): Promise<PrepareResult | null> {
  const current = await readLibraryIndex();
  const item = current.find((x) => x.id === id);
  if (!item) return null;

  const currentFileUri = getCorpusFileUri(id);

  const corpusFromCurrentPath = await readCorpusFile(currentFileUri);
  if (corpusFromCurrentPath) return corpusFromCurrentPath;

  const corpusFromStoredPath =
    item.fileUri !== currentFileUri ? await readCorpusFile(item.fileUri) : null;

  if (corpusFromStoredPath) {
    await writeLibraryIndex(
      current.map((x) =>
        x.id === id
          ? {
              ...x,
              fileUri: currentFileUri,
            }
          : x
      )
    );

    await writeCorpusFile(currentFileUri, corpusFromStoredPath);
    return corpusFromStoredPath;
  }

  console.log("[corpusStore] Saved corpus file could not be loaded:", {
    id,
    currentFileUri,
    storedFileUri: item.fileUri,
  });

  await writeLibraryIndex(current.filter((x) => x.id !== id));
  return null;
}

export async function deleteCorpusFromLibrary(id: string): Promise<void> {
  const current = await readLibraryIndex();
  const item = current.find((x) => x.id === id);

  if (item) {
    try {
      const info = await FileSystem.getInfoAsync(item.fileUri);
      if (info.exists) {
        await FileSystem.deleteAsync(item.fileUri, { idempotent: true });
      }
    } catch {
      // Keep going and clean the manifest.
    }
  }

  await writeLibraryIndex(current.filter((x) => x.id !== id));
}

export async function getActiveLibraryId(): Promise<string | null> {
  try {
    await ensureCorpusDir();

    const info = await FileSystem.getInfoAsync(ACTIVE_LIBRARY_ID_FILE_URI);
    if (!info.exists) return null;

    const raw = await FileSystem.readAsStringAsync(ACTIVE_LIBRARY_ID_FILE_URI, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const id = String(raw || "").trim();
    return id || null;
  } catch {
    return null;
  }
}

export async function markCurrentCorpusAsUnsaved(): Promise<void> {
  try {
    await ensureCorpusDir();

    const info = await FileSystem.getInfoAsync(ACTIVE_LIBRARY_ID_FILE_URI);
    if (info.exists) {
      await FileSystem.deleteAsync(ACTIVE_LIBRARY_ID_FILE_URI, {
        idempotent: true,
      });
    }
  } catch {
    // Ignore marker cleanup errors.
  }
}

export async function setActiveCorpusFromLibrary(
  id: string
): Promise<boolean> {
  const corpus = await loadCorpusFromLibrary(id);
  if (!corpus) return false;

  await savePreparedCorpus(corpus);

  await ensureCorpusDir();
  await FileSystem.writeAsStringAsync(ACTIVE_LIBRARY_ID_FILE_URI, id, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  return true;
}