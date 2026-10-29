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

// The terms of every lock this wallet makes: which Crowdlock, the address, the
// date and the co-signer. Saved BEFORE the money is sent, because the terms
// are what let the money come home: without the date nobody can rebuild the
// lock. Once a lock is on the register its terms are public there too, so
// restoring from the backup words finds it again; this copy covers the minutes
// between sending and the register taking it.
export type SavedLock = { crowdlock: string; address: string; locktime: number; cosignerPubkey: string };
const LOCKS = "crowdlock.locks.v1";

export async function loadSavedLocks(): Promise<SavedLock[]> {
  try { return JSON.parse((await SecureStore.getItemAsync(LOCKS)) ?? "[]"); } catch { return []; }
}

export async function saveLock(lock: SavedLock): Promise<void> {
  const all = await loadSavedLocks();
  if (!all.some((l) => l.address === lock.address)) all.push(lock);
  await SecureStore.setItemAsync(LOCKS, JSON.stringify(all));
  // Read it back: if the phone did not keep it, the money must not be sent.
  if (!(await loadSavedLocks()).some((l) => l.address === lock.address)) {
    throw new Error("the phone did not save the lock's terms, so nothing was sent");
  }
}

export async function forgetSavedLocks(): Promise<void> {
  await SecureStore.deleteItemAsync(LOCKS);
}
