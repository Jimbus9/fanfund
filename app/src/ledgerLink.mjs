// The link between Ledger's maintained Device Management Kit and the Bitcoin
// library's Ledger support.
//
// The library (@bitcoinerlab/descriptors) talks to a Ledger through Ledger's
// classic transport interface: open a device, exchange messages ("APDUs"),
// close. Ledger now maintains its phone connections — Bluetooth and USB — in
// the Device Management Kit instead. This file is the adapter between them, and
// nothing more: it carries messages to the device and its answers back. It
// never sees a key, never makes a signature, never reads what it carries.
//
// It takes the kit as an argument, so the tests can drive it with a pretend
// one and nothing here depends on React Native.

import { Buffer } from "buffer";

/**
 * A classic Ledger transport class backed by a Device Management Kit.
 * `open(device)` takes a device the kit discovered; the library's `connect`
 * calls it with whatever it was given as `driver.device`. `Transport` is the
 * classic base class (@ledgerhq/hw-transport), passed in because Node and the
 * phone's bundler load that package differently.
 */
export function transportFor(dmk, TransportBase) {
  const Transport = TransportBase.default ?? TransportBase;
  class DmkTransport extends Transport {
    static async open(device) {
      // The kit polls a connected device in the background by default; that
      // would interleave with our messages, so it is turned off — we only ever
      // talk to the device while signing, and say so on screen.
      const sessionId = await dmk.connect({ device, sessionRefresherOptions: { isRefresherDisabled: true } });
      return new DmkTransport(sessionId);
    }
    static async create() { throw new Error("choose a Ledger first"); }

    constructor(sessionId) { super(); this.sessionId = sessionId; }

    async exchange(apdu) {
      const r = await dmk.sendApdu({ sessionId: this.sessionId, apdu: Uint8Array.from(apdu) });
      // Classic transports return the answer followed by its two-byte status;
      // the base class turns a bad status into the usual Ledger error.
      return Buffer.concat([Buffer.from(r.data), Buffer.from(r.statusCode)]);
    }

    async close() {
      try { await dmk.disconnect({ sessionId: this.sessionId }); } catch {}
    }
  }
  return DmkTransport;
}

/**
 * Find a Ledger: the one saved before (same id), or any Ledger plugged in by
 * cable — a cable is unambiguous. Which Ledger it really is gets checked after
 * connecting, by its fingerprint, so the wrong one is refused either way.
 * Resolves with the kit's device, or rejects after `timeoutMs`.
 */
export function findLedger(dmk, { deviceId, timeoutMs = 20000, usb = "RN_HID" } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let sub = null;
    const finish = (fn, v) => {
      if (done) return; done = true;
      clearTimeout(timer);
      // Unsubscribing may have to wait until subscribe() has returned.
      setTimeout(() => { try { sub?.unsubscribe(); } catch {} }, 0);
      Promise.resolve(dmk.stopDiscovering()).catch(() => {});
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error("Couldn't find your Ledger. Keep it unlocked and close to the phone (or plugged in), then try again.")), timeoutMs);
    sub = dmk.startDiscovering({}).subscribe({
      next: (d) => { if (d.id === deviceId || d.transport === usb) finish(resolve, d); },
      error: (e) => finish(reject, e instanceof Error ? e : new Error(String(e?.message ?? e))),
    });
  });
}
