// Where the backup words live on the phone: the system's encrypted keystore
// (Android Keystore), via expo-secure-store. Never in plain app storage, never
// sent anywhere. If the app is deleted, they are gone from the phone — which
// is why the fan writes them down first, and why restoring from them must work.
import * as SecureStore from "expo-secure-store";

const KEY = "crowdlock.words.v1";

export async function loadWords(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY);
}

export async function saveWords(words: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, words, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function forgetWords(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

// Crowdlocks the fan has added by link, beyond the starting list. Not secret,
// but kept beside the words so removing the wallet removes them too.
const ADDED = "crowdlock.added.v1";

export async function loadAddedCrowdlocks(): Promise<string[]> {
  try { return JSON.parse((await SecureStore.getItemAsync(ADDED)) ?? "[]"); } catch { return []; }
}

export async function saveAddedCrowdlocks(urls: string[]): Promise<void> {
  await SecureStore.setItemAsync(ADDED, JSON.stringify(urls));
}

export async function forgetAddedCrowdlocks(): Promise<void> {
  await SecureStore.deleteItemAsync(ADDED);
}
