// Talking to a Ledger over Bluetooth. Only this file knows about Bluetooth:
// the key module asks for a connection through `useLedger`, and gets one here.
//
// A Ledger wallet is saved on the phone where backup words would be, as
// "ledger:" followed by what identifies it: the device's Bluetooth id, its
// name, and the account it gave (its key expression — public, no secret).
// The key itself never leaves the device.
import { PermissionsAndroid, Platform } from "react-native";
import * as ledgerApi from "@bitcoinerlab/descriptors/ledger";
import TransportBLE from "@ledgerhq/react-native-hw-transport-ble";
import * as bitcoinApi from "@ledgerhq/ledger-bitcoin";
// @ts-ignore — plain module shared with the tests
import { NETWORKS } from "./wallet/core.mjs";
import { loadLedgerStore, saveLedgerStore } from "./storage";

export const LEDGER_PREFIX = "ledger:";
export type LedgerWallet = { deviceId: string; name: string; keyExpression: string };

export const isLedgerWallet = (w: string) => typeof w === "string" && w.startsWith(LEDGER_PREFIX);
export const ledgerWalletText = (w: LedgerWallet) => LEDGER_PREFIX + JSON.stringify(w);
export const readLedgerWallet = (w: string): LedgerWallet => JSON.parse(w.slice(LEDGER_PREFIX.length));

/** The Ledger app a network needs: test money is signed by "Bitcoin Test". */
export const ledgerAppFor = (network: string) => (network === "mainnet" ? "Bitcoin" : "Bitcoin Test");
// Miniscript wallet policies arrived in the Ledger Bitcoin app 2.1.0.
const MIN_APP = "2.1.0";

/** Ask Android for Bluetooth. Android 12 and later name it; older ones file it under location. */
export async function askForBluetooth(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const P = PermissionsAndroid.PERMISSIONS as any;
  const wanted: string[] = Number(Platform.Version) >= 31
    ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT]
    : [P.ACCESS_FINE_LOCATION];
  const got = await PermissionsAndroid.requestMultiple(wanted as any);
  return wanted.every((p) => (got as any)[p] === PermissionsAndroid.RESULTS.GRANTED);
}

/** Look for Ledgers nearby. Calls `found` for each; returns a function that stops looking. */
export function lookForLedgers(found: (d: { id: string; name: string }) => void, failed: (e: Error) => void): () => void {
  const sub = (TransportBLE as any).listen({
    next: (e: any) => { if (e.type === "add") found({ id: e.descriptor.id, name: e.descriptor.name ?? "Ledger" }); },
    error: (e: any) => failed(new Error(plain(e))),
    complete: () => {},
  });
  return () => sub.unsubscribe();
}

/**
 * Connect to this Ledger, check the right Bitcoin app is open, run fn, and
 * disconnect. Whatever the device approved (each lock's rules, once) is kept
 * on the phone so it is not asked twice.
 */
export async function withLedger<T>(deviceId: string, network: string, fn: (session: any) => Promise<T>): Promise<T> {
  const store = await loadLedgerStore();
  let session: any;
  try {
    session = await ledgerApi.connect({
      driver: {
        transport: Promise.resolve({ default: TransportBLE }),
        bitcoinApi: Promise.resolve(bitcoinApi),
        device: deviceId,
        openTimeout: 20000,
        app: { name: ledgerAppFor(network), minVersion: MIN_APP },
      } as any,
      network: (NETWORKS as any)[network].network,
      store,
    } as any);
  } catch (e: any) { throw new Error(plain(e, network)); }
  try { return await fn(session); }
  catch (e: any) { throw new Error(plain(e, network)); }
  finally {
    await saveLedgerStore(store).catch(() => {});
    await session.close().catch(() => {});
  }
}

/** Ledger and Bluetooth errors, in words a fan can act on. */
function plain(e: any, network = "testnet4"): string {
  const m = String(e?.message ?? e);
  const app = ledgerAppFor(network);
  if (/denied|rejected|0x6985|Condition of use/i.test(m)) return "You declined it on the Ledger, so nothing was signed.";
  if (/Open the .* app|0x6e01|0x6d02|0x6511|CLA_NOT_SUPPORTED|app.*not open/i.test(m)) return `Open the ${app} app on your Ledger and try again.`;
  if (/upgrade/i.test(m)) return `Update the ${app} app on your Ledger (in Ledger Live), then try again.`;
  if (/locked|0x5515|0x6b0c/i.test(m)) return "Unlock your Ledger with its PIN and try again.";
  if (/BluetoothRequired|PoweredOff|bluetooth.*off/i.test(m)) return "Turn on Bluetooth and try again.";
  if (/timeout|timed out|disconnected|Disconnected|not found|no device/i.test(m)) return "Couldn't reach the Ledger. Keep it unlocked and close to the phone, then try again.";
  return m;
}

/** A Ledger account the key module can use, for the wallet saved on the phone. */
export function ledgerUser(w: LedgerWallet, network: string) {
  return (fn: (session: any) => Promise<any>) => withLedger(w.deviceId, network, fn);
}
