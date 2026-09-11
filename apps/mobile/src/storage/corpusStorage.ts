import AsyncStorage from "@react-native-async-storage/async-storage";

const CORPUS_KEY = "ECOSEARCH_PREPARED_CORPUS";

export async function savePreparedCorpus(corpus: any) {
  try {
    const json = JSON.stringify(corpus);
    await AsyncStorage.setItem(CORPUS_KEY, json);
  } catch (err) {
    console.error("Error saving corpus:", err);
  }
}

export async function loadPreparedCorpus() {
  try {
    const json = await AsyncStorage.getItem(CORPUS_KEY);
    if (!json) return null;
    return JSON.parse(json);
  } catch (err) {
    console.error("Error loading corpus:", err);
    return null;
  }
}

export async function clearPreparedCorpus() {
  try {
    await AsyncStorage.removeItem(CORPUS_KEY);
  } catch (err) {
    console.error("Error clearing corpus:", err);
  }
}
