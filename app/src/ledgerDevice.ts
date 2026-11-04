// Talking to a Ledger, over Bluetooth or a USB cable, through Ledger's
// maintained Device Management Kit. Only this file knows about the phone's
// radios and ports: the key module asks for a connection through `useLedger`,
// and gets one here.
//
// A Ledger wallet is saved on the phone where backup words would be, as
// "ledger:" followed by what identifies it: how it was found (its id and
// whether by Bluetooth or cable), its name, and the account it gave (its key
// expression — public, no secret). The key itself never leaves the device.
import { PermissionsAndroid, Platform } from "react-native";
import { DeviceManagementKitBuilder } from "@ledgerhq/device-management-kit";
import { RNBleTransportFactory, rnBleTransportIdentifier } from "@ledgerhq/device-transport-kit-react-native-ble";
import { RNHidTransportFactory, rnHidTransportIdentifier } from "@ledgerhq/device-transport-kit-react-native-hid";
import * as ledgerApi from "@bitcoinerlab/descriptors/ledger";
import * as bitcoinApi from "@ledgerhq/ledger-bitcoin";
import TransportBase from "@ledgerhq/hw-transport";
// @ts-ignore — plain modules shared with the tests
import { NETWORKS } from "./wallet/core.mjs";
// @ts-ignore
import { transportFor, findLedger } from "./ledgerLink.mjs";
import { loadLedgerStore, saveLedgerStore } from "./storage";

export const LEDGER_PREFIX = "ledger:";
export type LedgerWallet = { deviceId: string; name: string; keyExpression: string; via?: "bluetooth" | "cable" };
export type FoundLedger = { id: string; name: string; via: "bluetooth" | "cable"; device: any };

export const isLedgerWallet = (w: string) => typeof w === "string" && w.startsWith(LEDGER_PREFIX);
export const ledgerWalletText = (w: LedgerWallet) => LEDGER_PREFIX + JSON.stringify(w);
export const readLedgerWallet = (w: string): LedgerWallet => JSON.parse(w.slice(LEDGER_PREFIX.length));

/** The Ledger app a network needs: test money is signed by "Bitcoin Test". */
export const ledgerAppFor = (network: string) => (network === "mainnet" ? "Bitcoin" : "Bitcoin Test");
// Miniscript wallet policies arrived in the Ledger Bitcoin app 2.1.0.
const MIN_APP = "2.1.0";

// One kit for the app, with both ways in.
let kit: any = null;
function dmk() {
  kit ??= new DeviceManagementKitBuilder().addTransport(RNBleTransportFactory).addTransport(RNHidTransportFactory).build();
  return kit;
}
const viaOf = (d: any): "bluetooth" | "cable" => (d.transport === rnHidTransportIdentifier ? "cable" : "bluetooth");

/** Ask Android for Bluetooth. Android 12 and later name it; older ones file it under location. A cable needs neither. */
export async function askForBluetooth(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const P = PermissionsAndroid.PERMISSIONS as any;
  const wanted: string[] = Number(Platform.Version) >= 31
    ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT]
    : [P.ACCESS_FINE_LOCATION];
  const got = await PermissionsAndroid.requestMultiple(wanted as any);
  return wanted.every((p) => (got as any)[p] === PermissionsAndroid.RESULTS.GRANTED);
}

/** Look for Ledgers nearby or plugged in. Calls `found` for each; returns a function that stops looking. */
export function lookForLedgers(found: (d: FoundLedger) => void, failed: (e: Error) => void): () => void {
  const sub = dmk().startDiscovering({}).subscribe({
    next: (d: any) => found({ id: d.id, name: d.name || d.deviceModel?.name || "Ledger", via: viaOf(d), device: d }),
    error: (e: any) => failed(new Error(plain(e))),
  });
  return () => { try { sub.unsubscribe(); } catch {} dmk().stopDiscovering().catch(() => {}); };
}

/**
 * Connect to this Ledger, check the right Bitcoin app is open and that it is
 * the same Ledger as before (its fingerprint), run fn, and disconnect.
 * Whatever the device approved (each lock's rules, once) is kept on the phone
 * so it is not asked twice. `device` is one just found; otherwise the saved
 * Ledger is looked for again.
 */
export async function withLedger<T>(w: { deviceId: string; device?: any }, network: string, fn: (session: any) => Promise<T>): Promise<T> {
  const store = await loadLedgerStore();
  let session: any;
  try {
    const device = w.device ?? await findLedger(dmk(), { deviceId: w.deviceId, usb: rnHidTransportIdentifier } as any);
    session = await ledgerApi.connect({
      driver: {
        transport: Promise.resolve({ default: transportFor(dmk(), TransportBase) }),
        bitcoinApi: Promise.resolve(bitcoinApi),
        device,
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

/** Ledger, Bluetooth and cable errors, in words a fan can act on. */
export function plain(e: any, network = "testnet4"): string {
  const m = String(e?.message ?? e?._tag ?? e);
  const app = ledgerAppFor(network);
  if (/denied|rejected|0x6985|Condition of use/i.test(m)) return "You declined it on the Ledger, so nothing was signed.";
  if (/does not match store fingerprint/i.test(m)) return "That's a different Ledger from the one this wallet uses. Connect the original, or remove this wallet and set up the new one.";
  if (/Open the .* app|0x6e01|0x6d02|0x6511|0x6e00|CLA_NOT_SUPPORTED|app.*not open/i.test(m)) return `Open the ${app} app on your Ledger and try again.`;
  if (/upgrade/i.test(m)) return `Update the ${app} app on your Ledger (in Ledger Live), then try again.`;
  if (/locked|0x5515|0x6b0c|DeviceLocked/i.test(m)) return "Unlock your Ledger with its PIN and try again.";
  if (/BluetoothRequired|PoweredOff|bluetooth.*off|BleNotSupported/i.test(m)) return "Turn on Bluetooth and try again — or plug the Ledger in with a USB cable.";
  if (/Couldn't find your Ledger/i.test(m)) return m;
  if (/timeout|timed out|disconnected|Disconnected|not found|no device|NoAccessibleDevice|OpeningConnection/i.test(m)) return "Couldn't reach the Ledger. Keep it unlocked and close to the phone (or plugged in), then try again.";
  return m;
}

/** A Ledger account the key module can use, for the wallet saved on the phone. */
export function ledgerUser(w: LedgerWallet, network: string) {
  return (fn: (session: any) => Promise<any>) => withLedger({ deviceId: w.deviceId }, network, fn);
}
