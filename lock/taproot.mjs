// The same two-exit lock, built with taproot.
//
// ───────────────────────────────────────────────────────────────────────────
// NOT IN USE. Nothing in the project calls this module. Every live lock is
// built by lock.mjs (P2WSH). It is kept, tested and working so that the
// option stays open, not because it is part of the current design.
//
// It is here rather than deleted because two things would call for it:
//
//   * the co-signer becoming several keys instead of one. A taproot tree
//     holds extra branches at no cost to the address and reveals only the
//     branch used, where P2WSH grows the script and publishes all of it.
//   * hardware wallet support for custom taproot scripts catching up with
//     its support for the P2WSH equivalent. Today Ledger and Trezor handle
//     P2WSH miniscript more reliably, and a fan being able to check the
//     lock with a wallet they already own matters more than the saving.
//
// Do not wire this in without rerunning the testnet proof against it. The
// behaviour is proven for lock.mjs, not for this.
// ───────────────────────────────────────────────────────────────────────────
//
// Identical behaviour to the P2WSH version in lock.mjs — the owner alone after
// their date, or the owner plus the co-signer at any time. What taproot changes
// is the cost and the privacy:
//
//   * smaller witnesses, so a lock and a spend both cost less in fees
//   * the branch you DON'T use is never revealed on-chain
//
// Instead of one script holding both branches, taproot puts each branch in its
// own leaf of a tree and commits to the tree in the address. Spending reveals
// only the leaf used, plus a short proof that it belonged to the tree.
//
// The internal key is set to a point nobody knows the private key for, so
// there is no key-path shortcut past the two leaves. Without that, whoever
// knew the internal key could spend the coin with no script at all.

import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import { assertDistinctKeys } from "./lock.mjs";

bitcoin.initEccLib(ecc);
export const ECPair = ECPairFactory(ecc);

const { opcodes, script, payments, Transaction, crypto: bcrypto } = bitcoin;

/** Taproot works with 32-byte x-only keys rather than 33-byte compressed ones. */
export const toXOnly = (pubkey) => Buffer.from(pubkey).subarray(1, 33);

// BIP-341's suggested unspendable internal key. Chosen so that no private key
// for it is known to anybody, which is the point.
export const UNSPENDABLE_INTERNAL_KEY = Buffer.from(
  "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
  "hex",
);

export const LEAF_VERSION = 192; // 0xc0, the only tapscript version in use

/**
 * The going-home leaf: owner's signature alone, at or after the locktime.
 * Miniscript and_v(v:pk(owner),after(t)) — written in that standard form so
 * ordinary wallets and Bitcoin Core can read and sign it.
 */
export function homeLeaf({ ownerXOnly, locktime }) {
  return script.compile([
    ownerXOnly,
    opcodes.OP_CHECKSIGVERIFY,
    script.number.encode(locktime),
    opcodes.OP_CHECKLOCKTIMEVERIFY,
  ]);
}

/** The purchase leaf: owner AND co-signer, any time. Miniscript and_v(v:pk(owner),pk(cosigner)). */
export function purchaseLeaf({ ownerXOnly, cosignerXOnly }) {
  return script.compile([
    ownerXOnly,
    opcodes.OP_CHECKSIGVERIFY,
    cosignerXOnly,
    opcodes.OP_CHECKSIG,
  ]);
}

export function lockTaproot({ ownerPubkey, cosignerPubkey, locktime, network }) {
  assertDistinctKeys(ownerPubkey, cosignerPubkey); // see lock.mjs
  const ownerXOnly = toXOnly(ownerPubkey);
  const cosignerXOnly = toXOnly(cosignerPubkey);

  const home = homeLeaf({ ownerXOnly, locktime });
  const purchase = purchaseLeaf({ ownerXOnly, cosignerXOnly });

  const scriptTree = [
    { output: home, version: LEAF_VERSION },
    { output: purchase, version: LEAF_VERSION },
  ];

  const base = payments.p2tr({
    internalPubkey: UNSPENDABLE_INTERNAL_KEY,
    scriptTree,
    network,
  });

  const spendable = (leaf) =>
    payments.p2tr({
      internalPubkey: UNSPENDABLE_INTERNAL_KEY,
      scriptTree,
      redeem: { output: leaf, redeemVersion: LEAF_VERSION },
      network,
    });

  return {
    address: base.address,
    output: base.output,
    scriptTree,
    leaves: { home, purchase },
    payments: { home: spendable(home), purchase: spendable(purchase) },
  };
}

/** BIP-341 tapleaf hash — what a script-path signature commits to. */
export function leafHash(leaf) {
  return bcrypto.taggedHash(
    "TapLeaf",
    Buffer.concat([Buffer.from([LEAF_VERSION]), serialiseWithLength(leaf)]),
  );
}

function serialiseWithLength(buf) {
  if (buf.length < 0xfd) return Buffer.concat([Buffer.from([buf.length]), buf]);
  const len = Buffer.alloc(3);
  len.writeUInt8(0xfd, 0);
  len.writeUInt16LE(buf.length, 1);
  return Buffer.concat([len, buf]);
}

/**
 * Build one spending attempt against a taproot lock.
 * Same shape as buildSpend in lock.mjs so the two can be compared directly.
 */
export function buildTaprootSpend({
  utxo,                 // { txid, vout, value }
  lock,                 // the object returned by lockTaproot
  destination,
  feeSats,
  route,                // "home" | "purchase"
  ownerKey,
  cosignerKey,
  signers = ["owner", "cosigner"],
  locktime,
  network,
  nSequence = 0xfffffffe,
}) {
  if (route !== "home" && route !== "purchase") throw new Error(`unknown route: ${route}`);

  const leaf = lock.leaves[route];
  const payment = lock.payments[route];

  const tx = new Transaction();
  tx.version = 2;
  tx.locktime = route === "home" ? locktime : 0;
  tx.addInput(Buffer.from(utxo.txid, "hex").reverse(), utxo.vout, nSequence);
  tx.addOutput(bitcoin.address.toOutputScript(destination, network), utxo.value - feeSats);

  // A taproot signature commits to every input's value and script, so even a
  // single-input spend needs them passed in as arrays.
  const sighash = tx.hashForWitnessV1(
    0,
    [lock.output],
    [utxo.value],
    Transaction.SIGHASH_DEFAULT,
    leafHash(leaf),
  );

  const schnorr = (key) => Buffer.from(ecc.signSchnorr(sighash, key.privateKey));

  // Witness order: signatures as the script consumes them, then the leaf
  // script, then the control block proving the leaf is in the tree.
  const controlBlock = payment.witness[payment.witness.length - 1];
  const witness = [];
  if (route === "home") {
    witness.push(signers.includes("owner") ? schnorr(ownerKey) : Buffer.alloc(0));
  } else {
    witness.push(signers.includes("cosigner") ? schnorr(cosignerKey) : Buffer.alloc(0));
    witness.push(signers.includes("owner") ? schnorr(ownerKey) : Buffer.alloc(0));
  }
  witness.push(leaf, controlBlock);

  tx.setWitness(0, witness);

  return { tx, hex: tx.toHex(), txid: tx.getId(), sighash, leaf, controlBlock };
}

export function schnorrValid({ sighash, signature, xOnlyPubkey }) {
  if (!signature || signature.length === 0) return false;
  return ecc.verifySchnorr(sighash, xOnlyPubkey, signature.subarray(0, 64));
}
