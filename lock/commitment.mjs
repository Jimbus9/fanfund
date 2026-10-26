// Commitments: how a supporter backs one specific purchase with locked money.
//
// A commitment is the owner's half of a transaction nobody has broadcast. The
// coins do not move. The owner's signature alone cannot move them, because the
// lock's purchase exit needs the co-signer too. So a commitment can be
// published, copied and mirrored freely and nobody can spend with it.
//
// Three operations:
//
//   buildCommitment     the supporter signs their half
//   verifyCommitment    anybody checks it, against the proposal and the list
//   completeCommitment  the co-signer adds the second signature, at settlement
//
// Everything except the "is the coin still unspent" check works offline.
//
// See spec/commitment-format.md and spec/destinations-format.md.

import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { createHash } from "node:crypto";
import { lockScript, lockAddress } from "./lock.mjs";
import { isCosignerOf } from "../js/crowdlock.mjs";

const { Transaction, script: bscript } = bitcoin;

// Defaults only. A Crowdlock sets its own in crowdlocks/<name>.json, and
// verifyCommitment uses those whenever it is handed the Crowdlock's file.

/** Fee may not exceed this share of the committed amount. */
export const MAX_FEE_FRACTION = 0.01;

/** A destination must be publicly visible this long before a proposal opens. */
export const MINIMUM_AGE_DAYS = 14;

const sha256 = (buf) => createHash("sha256").update(buf).digest();

// ---------------------------------------------------------------------------
// The destinations list
// ---------------------------------------------------------------------------

/**
 * The canonical line that gets hashed and signed. One per entry.
 *
 * `instance` is the SHA-256 of this instance's declaration. It is in the line
 * so that an attestation signed for one instance cannot verify against another
 * — anybody may copy these documents, and several instances may run at once.
 */
export function destinationLine({ instance, index, op, address, text, added, prev }) {
  if (!/^[0-9a-f]{64}$/.test(instance ?? "")) throw new Error("instance must be a 64-character hex declaration hash");
  for (const [name, v] of [["text", text], ["address", address]]) {
    if (/[|\n\r]/.test(v)) throw new Error(`${name} may not contain | or a newline`);
  }
  return `${instance}|${index}|${op}|${address}|${text}|${added}|${prev}`;
}

export const ZERO_PREV = "0".repeat(64);

export function destinationHash(entry) {
  return sha256(Buffer.from(destinationLine(entry).normalize("NFC"), "utf8")).toString("hex");
}

export function attestationStatement(entry) {
  // The instance needs no mention: the line this hashes already carries it.
  return `I attest destination entry ${entry.index} (sha256:${destinationHash(entry)}).`;
}

/**
 * Check the hash chain runs unbroken from entry 1 to the head.
 * Returns { ok, reason }.
 */
export function chainIsIntact(entries) {
  let expected = ZERO_PREV;
  const instance = entries[0]?.instance;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.instance !== instance) return { ok: false, reason: `entry ${e.index} belongs to a different instance` };
    if (e.index !== i + 1) return { ok: false, reason: `entry at position ${i} has index ${e.index}, expected ${i + 1}` };
    if (e.prev !== expected) return { ok: false, reason: `entry ${e.index} chains to ${e.prev.slice(0, 12)}…, expected ${expected.slice(0, 12)}…` };
    expected = destinationHash(e);
  }
  return { ok: true, reason: "" };
}

/**
 * Is this destination permitted for a proposal opening at `opensAt`?
 *
 * `firstSeen` on an entry is its first PUBLIC appearance (the repository's own
 * history), never the `added` field, which the attestor writes and could
 * backdate.
 */
export function destinationIsPermitted({ address, entries, opensAt, minimumAgeDays = MINIMUM_AGE_DAYS }) {
  const chain = chainIsIntact(entries);
  if (!chain.ok) return { permitted: false, reason: `the list itself is broken: ${chain.reason}` };

  const mine = entries.filter((e) => e.address === address);
  const added = mine.filter((e) => e.op === "add").pop();
  if (!added) return { permitted: false, reason: "not on the published destinations list" };

  const revoked = mine.filter((e) => e.op === "revoke" && e.index > added.index).pop();
  if (revoked) return { permitted: false, reason: `revoked by entry ${revoked.index}` };

  const seen = Date.parse(added.firstSeen ?? added.added);
  const opens = Date.parse(opensAt);
  const ageDays = (opens - seen) / 86_400_000;
  if (!(ageDays >= minimumAgeDays)) {
    return { permitted: false, reason: `only ${ageDays.toFixed(1)} days old at the proposal's opening, needs ${minimumAgeDays}` };
  }

  return { permitted: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * The supporter's half.
 *
 * utxo         { txid, vout, value } — the lock being spent
 * commitSats   how much reaches the destination (output 0)
 * feeSats      taken from the coin; what is left over goes to the remainder
 * remainder    optional { ownerPubkey, cosignerPubkey, locktime } for a new lock
 */
export function buildCommitment({
  utxo,
  witnessScript,
  destination,
  commitSats,
  feeSats,
  ownerKey,
  remainder = null,
  network,
}) {
  const leftover = utxo.value - commitSats - feeSats;
  if (leftover < 0) throw new Error("commitSats + feeSats exceeds the lock's value");
  if (leftover > 0 && !remainder) throw new Error("a partial commitment needs a remainder lock");
  if (leftover === 0 && remainder) throw new Error("nothing left over, so no remainder lock is needed");

  const tx = new Transaction();
  tx.version = 2;
  tx.locktime = 0; // the purchase exit declares none, and must not
  tx.addInput(Buffer.from(utxo.txid, "hex").reverse(), utxo.vout, 0xfffffffe);
  tx.addOutput(bitcoin.address.toOutputScript(destination, network), commitSats);

  if (remainder) {
    const back = lockAddress({ ...remainder, network });
    tx.addOutput(back.output, leftover);
  }

  const sighash = tx.hashForWitnessV0(0, witnessScript, utxo.value, Transaction.SIGHASH_ALL);
  const ownerSig = bscript.signature.encode(Buffer.from(ownerKey.sign(sighash)), Transaction.SIGHASH_ALL);

  // Purchase branch, co-signer's slot empty until settlement.
  // Layout: [co-signer sig, branch selector, owner sig, script].
  tx.setWitness(0, [Buffer.alloc(0), Buffer.alloc(0), ownerSig, witnessScript]);

  return { tx, hex: tx.toHex(), sighash, ownerSig };
}

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

/**
 * Check a commitment record. Offline except for `coinIsUnspent`, which the
 * caller supplies from any block explorer (omit it and that check is skipped
 * and reported as skipped).
 *
 * Pass `crowdlock` (the Crowdlock's own file) and its fee cap and destination
 * wait are used, and a commitment whose lock is not co-signed by that
 * Crowdlock is refused — a commitment can never be counted by the wrong one.
 *
 * Returns { valid, reason, committedSats, checks }.
 */
export function verifyCommitment({
  record,                 // { proposal, lock, tx }
  proposal,               // { hash, destination, opensAt }
  destinationEntries = [],
  utxoValue,              // the lock's value, needed to check the signature and the fee
  coinIsUnspent = null,
  network,
  crowdlock = null,
}) {
  const maxFee = crowdlock ? crowdlock.max_commitment_fee : MAX_FEE_FRACTION;
  const minimumAgeDays = crowdlock ? crowdlock.destination_wait_days : MINIMUM_AGE_DAYS;
  const checks = [];
  const fail = (reason) => ({ valid: false, reason, committedSats: 0, checks });
  const note = (name, ok, detail = "") => { checks.push({ name, ok, detail }); return ok; };

  if (record.proposal !== proposal.hash) return fail("record names a different proposal");
  note("names this proposal", true);

  // 1. the lock re-derives
  let derived;
  try {
    derived = lockAddress({
      fanPubkey: Buffer.from(record.lock.owner_pubkey, "hex"),
      cosignerPubkey: Buffer.from(record.lock.cosigner_pubkey, "hex"),
      locktime: record.lock.locktime,
      network,
    });
  } catch (e) {
    return fail(`lock fields are not a valid lock: ${e.message}`);
  }
  if (derived.address !== record.lock.address) return fail("lock address does not re-derive from the stated keys and locktime");
  note("lock address re-derives", true, derived.address);

  if (crowdlock) {
    if (!isCosignerOf(crowdlock, record.lock.cosigner_pubkey)) {
      return fail(`the lock's co-signer is not ${crowdlock.name}'s — this commitment belongs to a different Crowdlock, or to none`);
    }
    note("lock belongs to this Crowdlock", true, crowdlock.name);
  }

  // 2. exactly one input
  let tx;
  try { tx = Transaction.fromHex(record.tx); }
  catch (e) { return fail(`transaction will not parse: ${e.message}`); }
  if (tx.ins.length !== 1) return fail(`${tx.ins.length} inputs, must be exactly 1`);
  note("exactly one input", true);

  // 3. the witness is the purchase branch, co-signer's slot empty
  const w = tx.ins[0].witness;
  if (w.length !== 4) return fail(`witness has ${w.length} items, the purchase branch has 4`);
  if (w[0].length !== 0) return fail("the co-signer's slot is not empty — this is a completed spend, not a commitment");
  if (w[1].length !== 0) return fail("branch selector is not empty, so this takes the going-home branch");
  if (!w[3].equals(derived.witnessScript)) return fail("witness script is not the lock's script");
  note("purchase branch, co-signer's slot empty", true);

  // 4. the owner's signature
  const sighash = tx.hashForWitnessV0(0, derived.witnessScript, utxoValue, Transaction.SIGHASH_ALL);
  let sigOk = false;
  try {
    const decoded = bscript.signature.decode(w[2]);
    sigOk = decoded.hashType === Transaction.SIGHASH_ALL &&
      ecc.verify(sighash, Buffer.from(record.lock.owner_pubkey, "hex"), decoded.signature);
  } catch { sigOk = false; }
  if (!sigOk) return fail("the owner's signature does not verify over this transaction");
  note("owner's signature verifies", true);

  // 5. no declared locktime
  if (tx.locktime !== 0) return fail(`declares nLockTime ${tx.locktime}, must be 0`);
  note("declares no locktime", true);

  // 6. output 0 pays the proposal's destination, which must be permitted
  if (tx.outs.length < 1 || tx.outs.length > 2) return fail(`${tx.outs.length} outputs, must be 1 or 2`);
  let out0;
  try { out0 = bitcoin.address.fromOutputScript(tx.outs[0].script, network); }
  catch { return fail("output 0 is not a recognisable address"); }
  if (out0 !== proposal.destination) return fail(`output 0 pays ${out0}, but the proposal names ${proposal.destination}`);
  note("output 0 pays the proposal's destination", true, out0);

  const permitted = destinationIsPermitted({ address: out0, entries: destinationEntries, opensAt: proposal.opensAt, minimumAgeDays });
  if (!permitted.permitted) return fail(`destination not permitted: ${permitted.reason}`);
  note("destination is on the published list", true);

  // 7. the remainder, if any, goes back into a lock the owner still cannot escape
  const committedSats = tx.outs[0].value;
  if (tx.outs.length === 2) {
    const r = record.remainder;
    if (!r) return fail("has a second output but no remainder lock declared to check it against");
    let back;
    try {
      back = lockAddress({
        fanPubkey: Buffer.from(r.owner_pubkey, "hex"),
        cosignerPubkey: Buffer.from(r.cosigner_pubkey, "hex"),
        locktime: r.locktime,
        network,
      });
    } catch (e) { return fail(`remainder lock is not a valid lock: ${e.message}`); }
    if (!tx.outs[1].script.equals(back.output)) return fail("output 1 does not pay the declared remainder lock");
    if (r.owner_pubkey !== record.lock.owner_pubkey) return fail("remainder lock has a different owner — this would move coins out of the owner's hands");
    if (r.locktime < record.lock.locktime) return fail("remainder lock expires earlier than the lock being spent — an early escape");
    if (crowdlock && !isCosignerOf(crowdlock, r.cosigner_pubkey)) return fail("remainder lock is co-signed by a different Crowdlock");
    note("remainder returns to the owner's own lock, no earlier", true);
  }

  // the fee sanity check
  const paidOut = tx.outs.reduce((n, o) => n + o.value, 0);
  const fee = utxoValue - paidOut;
  if (fee < 0) return fail("outputs exceed the input");
  if (fee > committedSats * maxFee) {
    return fail(`fee of ${fee} sats is more than ${maxFee * 100}% of the ${committedSats} committed — refusing in case of a client bug`);
  }
  note("fee is sane", true, `${fee} sats`);

  // 8. still unspent
  if (coinIsUnspent === null) note("coin still unspent", true, "SKIPPED — needs a block explorer");
  else if (!coinIsUnspent) return fail("the coin has already been spent, so this commitment is void");
  else note("coin still unspent", true);

  return { valid: true, reason: "", committedSats, checks };
}

// ---------------------------------------------------------------------------
// Completing, at settlement
// ---------------------------------------------------------------------------

/**
 * The co-signer's half. Only ever called once a proposal's target is met and
 * every check in verifyCommitment has passed.
 */
export function completeCommitment({ record, cosignerKey, utxoValue, network }) {
  const derived = lockAddress({
    fanPubkey: Buffer.from(record.lock.owner_pubkey, "hex"),
    cosignerPubkey: Buffer.from(record.lock.cosigner_pubkey, "hex"),
    locktime: record.lock.locktime,
    network,
  });

  const tx = Transaction.fromHex(record.tx);
  const w = tx.ins[0].witness;
  if (w[0].length !== 0) throw new Error("already completed");

  const sighash = tx.hashForWitnessV0(0, derived.witnessScript, utxoValue, Transaction.SIGHASH_ALL);
  const cosignerSig = bscript.signature.encode(Buffer.from(cosignerKey.sign(sighash)), Transaction.SIGHASH_ALL);

  tx.setWitness(0, [cosignerSig, Buffer.alloc(0), w[2], w[3]]);
  return { tx, hex: tx.toHex(), txid: tx.getId(), sighash, cosignerSig };
}

export { lockScript, lockAddress };
