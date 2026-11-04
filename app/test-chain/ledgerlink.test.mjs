// The adapter between Ledger's Device Management Kit and the Bitcoin library's
// Ledger support (src/ledgerLink.mjs), driven through the library's own
// connection code with a pretend kit. A real kit carries the same bytes to a
// real device; what this proves is that the adapter carries them faithfully
// and that the library's checks — the right app, the right version, the same
// Ledger as before — still run on top of it.

import { Buffer } from "buffer";
import * as ledgerApi from "@bitcoinerlab/descriptors/ledger";
import * as bitcoinApi from "@ledgerhq/ledger-bitcoin";
import { networks } from "@bitcoinerlab/descriptors";
import { transportFor as transportForKit, findLedger } from "../src/ledgerLink.mjs";
import { createRequire } from "node:module";
const TransportBase = createRequire(import.meta.url)("@ledgerhq/hw-transport");
const transportFor = (kit) => transportForKit(kit, TransportBase);

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${detail}`); if (!ok) failures++; };

// A pretend kit and device: answers "which app is open" and "your fingerprint",
// records every message, and can be told to refuse.
function pretendKit({ app = "Bitcoin Test", version = "2.4.1", fingerprint = "f00dbabe", refuse = false, devices = [] } = {}) {
  const log = { sent: [], connected: [], disconnected: [], stopped: 0 };
  const ok = Uint8Array.from([0x90, 0x00]);
  const kit = {
    log,
    async connect({ device, sessionRefresherOptions }) { log.connected.push({ device, refresher: sessionRefresherOptions }); return "session-1"; },
    async disconnect({ sessionId }) { log.disconnected.push(sessionId); },
    async sendApdu({ sessionId, apdu }) {
      log.sent.push(Buffer.from(apdu).toString("hex"));
      if (refuse) return { data: new Uint8Array(), statusCode: Uint8Array.from([0x69, 0x85]) };
      const [cla, ins] = apdu;
      if (cla === 0xb0 && ins === 0x01) {
        const n = Buffer.from(app), v = Buffer.from(version);
        return { data: Uint8Array.from([1, n.length, ...n, v.length, ...v, 1, 0]), statusCode: ok };
      }
      if (cla === 0xe1 && ins === 0x05) return { data: Uint8Array.from(Buffer.from(fingerprint, "hex")), statusCode: ok };
      return { data: new Uint8Array(), statusCode: Uint8Array.from([0x6d, 0x00]) };
    },
    startDiscovering() {
      return { subscribe: ({ next }) => { const t = devices.map((d, i) => setTimeout(() => next(d), 5 * (i + 1))); return { unsubscribe: () => t.forEach(clearTimeout) }; } };
    },
    async stopDiscovering() { log.stopped++; },
  };
  return kit;
}

const connectWith = (kit, store = {}, app = "Bitcoin Test") => ledgerApi.connect({
  driver: { transport: Promise.resolve({ default: transportFor(kit) }), bitcoinApi: Promise.resolve(bitcoinApi), device: { id: "dev-1" }, app: { name: app, minVersion: "2.1.0" } },
  network: networks.testnet, store,
});

{
  const kit = pretendKit();
  const store = {};
  const session = await connectWith(kit, store);
  check("Through the adapter, the library checks the open app and reads the Ledger's fingerprint",
    store.masterFingerprint === "f00dbabe" && kit.log.sent[0].startsWith("b001") && kit.log.sent.some((h) => h.startsWith("e105")));
  check("…connecting to the device it was given, with the kit's background polling off",
    kit.log.connected[0].device.id === "dev-1" && kit.log.connected[0].refresher?.isRefresherDisabled === true);
  await session.close();
  check("…and closing the session closes the connection", kit.log.disconnected[0] === "session-1");
}
{
  let msg = ""; try { await connectWith(pretendKit({ app: "Bitcoin" })); } catch (e) { msg = e.message; }
  check("The wrong Bitcoin app open is refused, by name", /Open the Bitcoin Test app/.test(msg), msg);
  msg = ""; try { await connectWith(pretendKit({ version: "2.0.6" })); } catch (e) { msg = e.message; }
  check("An app too old for wallet policies is refused", /upgrade/.test(msg), msg);
  msg = ""; try { await connectWith(pretendKit({ fingerprint: "deadbeef" }), { masterFingerprint: "f00dbabe" }); } catch (e) { msg = e.message; }
  check("A different Ledger from the wallet's own is refused", /does not match store fingerprint/.test(msg), msg);
  const kit = pretendKit({ refuse: true });
  msg = ""; try { await connectWith(kit); } catch (e) { msg = e.message; }
  check("A refusal on the device comes through as the usual Ledger error", /0x6985|Condition of use/i.test(msg), msg);
  check("…and the connection is still closed", kit.log.disconnected.length === 1);
}
{
  const ble = (id) => ({ id, name: "Nano X", transport: "RN_BLE" });
  const usb = { id: "usb-7", name: "Nano X", transport: "RN_HID" };
  let kit = pretendKit({ devices: [ble("someone-else"), ble("mine")] });
  check("Finding the saved Ledger picks it by id, not the first one nearby", (await findLedger(kit, { deviceId: "mine" })).id === "mine");
  kit = pretendKit({ devices: [ble("someone-else"), usb] });
  check("A Ledger plugged in by cable is used even if it was saved over Bluetooth", (await findLedger(kit, { deviceId: "mine" })).id === "usb-7");
  kit = pretendKit({ devices: [ble("someone-else")] });
  let msg = ""; try { await findLedger(kit, { deviceId: "mine", timeoutMs: 60 }); } catch (e) { msg = e.message; }
  check("No Ledger found says so plainly, and stops looking", /Couldn't find your Ledger/.test(msg) && kit.log.stopped === 1, msg);
}

console.log(failures === 0 ? "\nThe adapter carries the library's Ledger conversation faithfully over Ledger's maintained kit." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
