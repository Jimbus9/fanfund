// The fan fund lock.
//
// A locked coin can leave in exactly two directions and no others:
//
//   GOING HOME      the fan's signature alone, but only after the lock date.
//                   Nobody else is involved and nothing can stop it.
//
//   INTO A PURCHASE the fan's signature plus the co-signer's, at any time,
//                   and only to a destination on the published list.
//
// Both live in one witness script, which reads: the fan ALWAYS signs, and
// then EITHER the date has passed OR the co-signer signs too.
//
//   <fan> OP_CHECKSIGVERIFY
//   OP_IF
//     <locktime> OP_CHECKLOCKTIMEVERIFY
//   OP_ELSE
//     <cosigner> OP_CHECKSIG
//   OP_ENDIF
//
// The first line is the most important in this project: it runs before the
// branch is chosen, so no route out of the lock exists without the fan's
// signature. The co-signer can never move the coin alone.
//
// Which branch gets used is chosen by the spender, who puts a 1 (going home)
// or an empty item (purchase) in the witness.
//
// This is standard miniscript — and_v(v:pk(fan),or_i(after(t),pk(cosigner)))
// — so ordinary wallets and Bitcoin Core can read and sign it with no code of
// ours. That is what lets the co-signer sign thousands of commitments with an
// offline copy of Bitcoin Core instead of pressing a button for each. An
// earlier form named the fan's key twice, which miniscript refuses.
//
// Why P2WSH and not taproot: the behaviour is what matters at this stage, and
// P2WSH has the most mature tooling and the widest wallet support, so there is
// less of our own cryptography between the design and the proof. Taproot is a
// later optimisation — smaller witnesses, and the unused branch stays private —
// and it changes nothing about the two exits.

import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";

bitcoin.initEccLib(ecc);
export const ECPair = ECPairFactory(ecc);

const { opcodes, script, payments, Transaction, networks } = bitcoin;

// Bitcoin reads a locktime below this as a block height, and at or above it as
// a unix timestamp. Production locks use a date; the testnet run defaults to a
// block height because it is exact and quick to demonstrate.
export const LOCKTIME_THRESHOLD = 500000000;

export function networkFor(name) {
  if (name === "mainnet") return networks.bitcoin;
  if (name === "testnet" || name === "testnet4" || name === "signet") return networks.testnet;
  throw new Error(`unknown network: ${name}`);
}

/**
 * The owner and the co-signer must be two different keys.
 *
 * If they were the same, one person could supply both purchase signatures and
 * move the coin at any time — the lock would silently stop being a lock, and
 * the register would still count it as locked. Babylon's staking scripts refuse
 * the same thing for the same reason.
 *
 * Compared on the x-coordinate alone, because a key and its mirror image share
 * it, and whoever holds one private key can trivially derive the other's.
 */
export function assertDistinctKeys(ownerPubkey, cosignerPubkey) {
  const x = (k) => Buffer.from(k).subarray(k.length === 33 ? 1 : 0);
  if (x(ownerPubkey).equals(x(cosignerPubkey))) {
    throw new Error("owner and co-signer must be different keys");
  }
}

/** Build the witness script holding both exits. */
export function lockScript({ fanPubkey, cosignerPubkey, locktime }) {
  if (fanPubkey.length !== 33) throw new Error("fan pubkey must be 33 bytes (compressed)");
  if (cosignerPubkey.length !== 33) throw new Error("co-signer pubkey must be 33 bytes (compressed)");
  if (!Number.isInteger(locktime) || locktime <= 0) throw new Error("locktime must be a positive integer");
  assertDistinctKeys(fanPubkey, cosignerPubkey);

  return script.compile([
    fanPubkey,
    opcodes.OP_CHECKSIGVERIFY,
    opcodes.OP_IF,
      script.number.encode(locktime),
      opcodes.OP_CHECKLOCKTIMEVERIFY,
    opcodes.OP_ELSE,
      cosignerPubkey,
      opcodes.OP_CHECKSIG,
    opcodes.OP_ENDIF,
  ]);
}

/** The lock as an address anyone can pay into. */
export function lockAddress({ fanPubkey, cosignerPubkey, locktime, network }) {
  const witnessScript = lockScript({ fanPubkey, cosignerPubkey, locktime });
  const p2wsh = payments.p2wsh({ redeem: { output: witnessScript, network }, network });
  return { address: p2wsh.address, witnessScript, output: p2wsh.output };
}

export function describeLocktime(locktime) {
  return locktime >= LOCKTIME_THRESHOLD
    ? `unix time ${locktime} (${new Date(locktime * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC)`
    : `block height ${locktime}`;
}

/**
 * Build one spending attempt.
 *
 * route: "home"     — IF branch, fan alone, only valid at or after the locktime
 *        "purchase" — ELSE branch, fan plus co-signer, valid any time
 *
 * Witness layout, bottom of the stack first:
 *   home      [ 1, fan sig, script ]
 *   purchase  [ co-signer sig, (empty), fan sig, script ]
 *
 * signers decides who actually signs, so we can build the attempts that are
 * SUPPOSED to fail as well as the ones that are supposed to work.
 */
export function buildSpend({
  utxo,                 // { txid, vout, value }
  witnessScript,
  destination,          // address the coin is being sent to
  feeSats,
  route,
  fanKey,
  cosignerKey,
  signers = ["fan", "cosigner"],
  locktime,
  network,
  nSequence = 0xfffffffe, // anything below 0xffffffff so nLockTime is honoured
}) {
  if (route !== "home" && route !== "purchase") throw new Error(`unknown route: ${route}`);

  const tx = new Transaction();
  tx.version = 2;

  // CHECKLOCKTIMEVERIFY compares against the transaction's own nLockTime, so a
  // spend down the going-home branch must declare it. Declaring a locktime the
  // chain has not reached yet is exactly what a node refuses.
  tx.locktime = route === "home" ? locktime : 0;

  tx.addInput(Buffer.from(utxo.txid, "hex").reverse(), utxo.vout, nSequence);
  tx.addOutput(bitcoin.address.toOutputScript(destination, network), utxo.value - feeSats);

  const sighash = tx.hashForWitnessV0(0, witnessScript, utxo.value, Transaction.SIGHASH_ALL);

  const sigFor = (key) =>
    bitcoin.script.signature.encode(
      Buffer.from(key.sign(sighash)),
      Transaction.SIGHASH_ALL,
    );

  // The script consumes the stack from the top: the fan's signature first,
  // then the branch selector, then (purchase only) the co-signer's signature.
  // So they go in reverse: the item used last goes in first.
  const fanSig = signers.includes("fan") ? sigFor(fanKey) : Buffer.alloc(0);
  const witness = [];
  if (route === "home") {
    witness.push(Buffer.from([1]));  // take the IF branch
  } else {
    witness.push(signers.includes("cosigner") ? sigFor(cosignerKey) : Buffer.alloc(0));
    witness.push(Buffer.alloc(0));   // take the ELSE branch
  }
  witness.push(fanSig);
  witness.push(witnessScript);

  tx.setWitness(0, witness);

  return { tx, hex: tx.toHex(), txid: tx.getId(), sighash };
}

/** Verify a signature in a built spend really is valid over its sighash. */
export function signatureIsValid({ sighash, signatureWithHashType, pubkey }) {
  const decoded = bitcoin.script.signature.decode(signatureWithHashType);
  return ecc.verify(sighash, pubkey, decoded.signature);
}
