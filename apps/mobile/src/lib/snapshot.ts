import * as FileSystem from "expo-file-system";
import type { SplitResult, Chunk } from "./splitter";

/** Shape stored on disk — deterministic, reloadable snapshot */
export type CorpusSnapshot = {
  version: 1;
  docId: string;
  createdAt: number;
  sentences: SplitResult["sentences"];
  chunks: Chunk[];
};

/** Write corpus snapshot to JSON file in app documents folder. */
export async function saveCorpusSnapshot(snapshot: CorpusSnapshot): Promise<string> {
  const path = `${FileSystem.documentDirectory}${snapshot.docId}.json`;
  const data = JSON.stringify(snapshot, null, 0);
  await FileSystem.writeAsStringAsync(path, data, { encoding: FileSystem.EncodingType.UTF8 });
  return path;
}

/** Load a previously saved corpus snapshot (if it exists). */
export async function loadCorpusSnapshot(docId: string): Promise<CorpusSnapshot | null> {
  const path = `${FileSystem.documentDirectory}${docId}.json`;
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return null;
  const data = await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.UTF8 });
  return JSON.parse(data) as CorpusSnapshot;
}

/** Delete snapshot (e.g. when user clears corpus). */
export async function deleteCorpusSnapshot(docId: string): Promise<void> {
  const path = `${FileSystem.documentDirectory}${docId}.json`;
  const info = await FileSystem.getInfoAsync(path);
  if (info.exists) await FileSystem.deleteAsync(path, { idempotent: true });
}

