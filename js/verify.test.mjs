// Tests verify.mjs against signatures produced by an independent library.
//
// The point of testing against bitcoinjs-message rather than against itself is
// that our verifier and the thing producing the signatures share no code. If
// both agree, the format is right.
//
// Run:  node js/verify.test.mjs      (from the repo root)

import * as bitcoin from "../lock/node_modules/bitcoinjs-lib/src/index.js";
import { ECPairFactory } from "../lock/node_modules/ecpair/src/index.js";
import * as ecc from "../lock/node_modules/tiny-secp256k1/lib/index.js";
import bitcoinMessage from "../lock/node_modules/bitcoinjs-message/index.js";
import { verifyMembership, encodeP2WPKH, hash160 } from "./verify.mjs";

const ECPair = ECPairFactory(ecc);
const NET = bitcoin.networks.bitcoin;

let failures = 0;
const check = (name, got, want, detail = "") => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`);
};

const STATEMENT =
  "I agree to the Fan Fund Declaration v1 " +
  "(sha256:51f4b86e0219a1b26a6e48642f74b4d87026159fd84e2d0fabd6f6046b413340) " +
  "and join as a member.";

console.log("\nVerifying our browser code against bitcoinjs-message\n" + "-".repeat(72));

// --- Address derivation agrees with bitcoinjs ------------------------------

for (let i = 0; i < 5; i++) {
  const kp = ECPair.makeRandom({ network: NET });
  const pub = Buffer.from(kp.publicKey);
  const fromBitcoinjs = bitcoin.payments.p2wpkh({ pubkey: pub, network: NET }).address;
  const fromOurs = encodeP2WPKH(hash160(new Uint8Array(pub)), "bc");
  check(`Address derivation matches (key ${i + 1})`, fromOurs, fromBitcoinjs,
    i === 0 ? fromOurs.slice(0, 16) + "…" : "");
}

// --- A genuine signature verifies -----------------------------------------

const kp = ECPair.makeRandom({ network: NET });
const priv = Buffer.from(kp.privateKey);
const address = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network: NET }).address;
const signature = bitcoinMessage
  .sign(STATEMENT, priv, kp.compressed, { segwitType: "p2wpkh" })
  .toString("base64");

console.log();
const good = verifyMembership({ address, signature, message: STATEMENT });
check("Genuine signature over the real statement", good.valid, true, good.reason);

// --- Every way it should fail ---------------------------------------------

const tampered = STATEMENT.replace("join as a member", "join as the owner");
check("Same signature, tampered statement",
  verifyMembership({ address, signature, message: tampered }).valid, false);

const other = ECPair.makeRandom({ network: NET });
const otherAddress = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(other.publicKey), network: NET }).address;
const wrongAddr = verifyMembership({ address: otherAddress, signature, message: STATEMENT });
check("Signature claimed for somebody else's address", wrongAddr.valid, false, wrongAddr.reason);
check("  …and it names the address it really belongs to", wrongAddr.derived === address, true);

const forged = bitcoinMessage
  .sign(STATEMENT, Buffer.from(other.privateKey), other.compressed, { segwitType: "p2wpkh" })
  .toString("base64");
check("A different key's signature under this address",
  verifyMembership({ address, signature: forged, message: STATEMENT }).valid, false);

check("Garbage instead of a signature",
  verifyMembership({ address, signature: "not-a-signature", message: STATEMENT }).valid, false);

check("Empty signature",
  verifyMembership({ address, signature: "", message: STATEMENT }).valid, false);

// A single flipped bit in the signature body.
const bytes = Buffer.from(signature, "base64");
bytes[40] ^= 0x01;
check("One flipped bit in the signature",
  verifyMembership({ address, signature: bytes.toString("base64"), message: STATEMENT }).valid, false);

// --- Legacy (compressed P2PKH) header, same key ---------------------------
// Wallets vary in which header byte they use. A signature made in "legacy"
// mode still recovers the same key, so it should still verify to the same
// segwit address.

const legacySig = bitcoinMessage.sign(STATEMENT, priv, kp.compressed).toString("base64");
const legacy = verifyMembership({ address, signature: legacySig, message: STATEMENT });
check("Legacy-header signature from the same key", legacy.valid, true,
  "wallets differ on the header byte; both must work");

console.log("\n" + "-".repeat(72));
console.log(failures === 0
  ? "All checks passed. The browser verifier agrees with an independent library."
  : `${failures} check(s) failed.`);
console.log();
process.exit(failures === 0 ? 0 : 1);
