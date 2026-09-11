import AsyncStorage from "@react-native-async-storage/async-storage";

/** Read a string value; returns null if not found or on error. */
export async function getItemSafe(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a string value; returns true on success, false on error. */
export async function setItemSafe(key: string, value: string): Promise<boolean> {
  try {
    await AsyncStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

