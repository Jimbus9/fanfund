// A pretend Ledger for the tests: the same calls the Ledger Bitcoin app answers
// (@ledgerhq/ledger-bitcoin's AppClient), answered by a software key instead
// of a device. It behaves like the real one where it matters to us:
//   - it signs only inputs belonging to the wallet policy it is given;
//   - it refuses a custom policy (our lock) unless that exact policy was
//     registered on it first and the proof of registration (HMAC) is handed back;
//   - it never hands out its private key.
// What it cannot test is the device itself: its screen, its Bluetooth, and its
// own parsing of the policy. Those are tested on a real Nano X.

import { BIP32, Psbt } from "@bitcoinerlab/descriptors";
import * as ecc from "@bitcoinerlab/secp256k1";
import { mnemonicToSeedSync } from "@scure/bip39";
import { createHash, randomBytes } from "node:crypto";
import { messageHash } from "../../method/js/verify.mjs";

export function fakeLedger(words, network) {
  const root = BIP32.fromSeed(mnemonicToSeedSync(words), network);
  const fingerprint = Buffer.from(root.fingerprint).toString("hex");
  const registered = new Map(); // hmac hex -> { name, template, keys }
  const log = { registered: [], signed: [], messages: [] };
  const id = (p) => createHash("sha256").update(JSON.stringify([p.name, p.descriptorTemplate, p.keys])).digest();

  const client = {
    async getMasterFingerprint() { return fingerprint; },
    async getExtendedPubkey(path) { return root.derivePath(path).neutered().toBase58(); },
    async registerWallet(policy) {
      const hmac = randomBytes(32);
      registered.set(hmac.toString("hex"), { name: policy.name, template: policy.descriptorTemplate, keys: [...policy.keys] });
      log.registered.push({ name: policy.name, template: policy.descriptorTemplate, keys: [...policy.keys] });
      return [id(policy), hmac];
    },
    async signPsbt(psbtBase64, policy, hmac) {
      const custom = hmac !== null && hmac !== undefined;
      if (custom) {
        const r = registered.get(Buffer.from(hmac).toString("hex"));
        if (!r || r.template !== policy.descriptorTemplate || JSON.stringify(r.keys) !== JSON.stringify(policy.keys)) {
          throw new Error("Ledger refused: this wallet policy was never registered on this device");
        }
      }
      const psbt = Psbt.fromBase64(psbtBase64, { network });
      const out = [];
      psbt.data.inputs.forEach((input, i) => {
        // A default (wpkh) policy signs single-key inputs; a registered policy
        // signs only script (P2WSH) inputs.
        const isScript = !!input.witnessScript;
        if (custom !== isScript) return;
        for (const d of input.bip32Derivation ?? []) {
          if (Buffer.from(d.masterFingerprint).toString("hex") !== fingerprint) continue;
          const node = root.derivePath(d.path);
          psbt.signInput(i, { publicKey: node.publicKey, sign: (h) => node.sign(h) });
          const sig = psbt.data.inputs[i].partialSig.find((p) => Buffer.from(p.pubkey).equals(Buffer.from(node.publicKey)));
          out.push([i, { pubkey: Buffer.from(sig.pubkey), signature: Buffer.from(sig.signature) }]);
          log.signed.push({ index: i, policy: policy.descriptorTemplate });
        }
      });
      return out;
    },
    async signMessage(message, path) {
      const node = root.derivePath(path);
      const text = Buffer.from(message).toString("utf8");
      log.messages.push({ path, text });
      const { signature, recoveryId } = ecc.signRecoverable(messageHash(text), node.privateKey);
      return Buffer.concat([Buffer.from([31 + recoveryId]), Buffer.from(signature)]).toString("base64");
    },
  };
  return { client, fingerprint, log };
}
