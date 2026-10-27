// Proves the commitment format behaves as spec/commitment-format.md claims.
// Offline, no network, no real money.
//
// Run:  node commitment.test.mjs

import * as bitcoin from "bitcoinjs-lib";
import bitcoinMessage from "./node_modules/bitcoinjs-message/index.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ECPair, lockAddress, networkFor } from "./lock.mjs";
import {
  buildCommitment, verifyCommitment, completeCommitment,
  destinationLine, destinationHash, attestationStatement, attestationsAreValid,
  proposalLine, proposalHash,
  chainIsIntact, destinationIsPermitted, ZERO_PREV, MAX_FEE_FRACTION,
} from "./commitment.mjs";

const NETWORK = networkFor("testnet");
const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(78));

let failures = 0;
const check = (name, got, want, detail = "") => {
  const ok = got === want;
  if (!ok) failures++;
  line(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`);
};
// Most checks below assert a REJECTION, so this helper reads the right way round.
const rejects = (name, result, expectInReason) => {
  const ok = !result.valid && result.reason.includes(expectInReason);
  if (!ok) failures++;
  line(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${result.valid ? "ACCEPTED IT" : result.reason.slice(0, 60)}`);
};

const ownerKey = ECPair.fromPrivateKey(Buffer.from("11".repeat(32), "hex"), { network: NETWORK });
const cosignerKey = ECPair.fromPrivateKey(Buffer.from("22".repeat(32), "hex"), { network: NETWORK });
const strangerKey = ECPair.fromPrivateKey(Buffer.from("33".repeat(32), "hex"), { network: NETWORK });

const ownerPubkey = Buffer.from(ownerKey.publicKey);
const cosignerPubkey = Buffer.from(cosignerKey.publicKey);
const LOCKTIME = 2_900_000;

const lock = lockAddress({ fanPubkey: ownerPubkey, cosignerPubkey, locktime: LOCKTIME, network: NETWORK });
const utxo = { txid: "a".repeat(64), vout: 0, value: 1_000_000 };

// ---------------------------------------------------------------------------
// The destinations list
// ---------------------------------------------------------------------------

const DEST = bitcoin.payments.p2wpkh({ pubkey: cosignerPubkey, network: NETWORK }).address;
const OTHER = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(strangerKey.publicKey), network: NETWORK }).address;

// This instance's identity: the declaration's SHA-256.
const INSTANCE = "3a0a0bca96ec2161d98ff9da05ae885d6b8d68e55ed412bc85dcc7fb16209b96";
const OTHER_INSTANCE = "b".repeat(64);

// Two attestors, and a third party who is not one. Attestations are real
// Bitcoin Signed Messages, produced here with an independent library, so the
// tests prove our verification against somebody else's implementation rather
// than against itself.
const attestorKeyA = ECPair.makeRandom({ network: NETWORK });
const attestorKeyB = ECPair.makeRandom({ network: NETWORK });
const outsiderKey = ECPair.makeRandom({ network: NETWORK });
const addrOf = (k) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(k.publicKey), network: NETWORK }).address;
const ATTESTOR_A = addrOf(attestorKeyA);
const ATTESTOR_B = addrOf(attestorKeyB);
const OUTSIDER = addrOf(outsiderKey);
const ATTESTORS = [ATTESTOR_A, ATTESTOR_B];

/** Sign an entry's attestation statement as `key`. */
const attest = (entry, key) => ({
  address: addrOf(key),
  signature: bitcoinMessage
    .sign(attestationStatement(entry), Buffer.from(key.privateKey), true, { segwitType: "p2wpkh" })
    .toString("base64"),
});

/** An entry plus a valid attestation from A, which is the normal case. */
const attested = (entry) => ({ ...entry, attestations: [attest(entry, attestorKeyA)] });

const e1 = attested({
  instance: INSTANCE, index: 1, op: "add", address: DEST,
  text: "Society receiving address for the stake purchase",
  added: "2026-11-01T12:00:00Z", prev: ZERO_PREV,
  firstSeen: "2026-11-01T12:00:00Z",
});
const e2 = attested({
  instance: INSTANCE, index: 2, op: "add", address: OTHER,
  text: "A second address, added only recently",
  added: "2026-11-20T12:00:00Z", prev: destinationHash(e1),
  firstSeen: "2026-11-20T12:00:00Z",
});
const LIST = [e1, e2];
// hrp: these fixtures are testnet, and an attestor's address carries its
// network's prefix. Checking a tb1q attestation under mainnet rules derives a
// different address and blames the signer.
const RULES = { attestors: ATTESTORS, threshold: 1, hrp: NETWORK.bech32 };

const PROPOSAL_OPENS = "2026-11-21T00:00:00Z"; // 20 days after e1, 1 day after e2

line();
rule();
line("THE PUBLISHED DESTINATIONS LIST");
rule();
line(`entry 1 line   ${destinationLine(e1).slice(0, 66)}…`);
line(`entry 1 hash   ${destinationHash(e1)}`);
line(`attestation    ${attestationStatement(e1)}`);
line();

check("Chain is intact", chainIsIntact(LIST).ok, true);
check("A pipe in the text is refused",
  (() => { try { destinationLine({ ...e1, text: "a|b" }); return false; } catch { return true; } })(), true,
  "the delimiter cannot be smuggled into a field");
check("Changing an entry breaks every entry after it",
  chainIsIntact([{ ...e1, text: "Quietly altered" }, e2]).ok, false,
  "tampering is visible without needing the git history");
check("Reordering the list breaks the chain", chainIsIntact([e2, e1]).ok, false);

const aged = destinationIsPermitted({ address: DEST, entries: LIST, opensAt: PROPOSAL_OPENS, ...RULES });
check("A destination 20 days old is permitted", aged.permitted, true, "needs 14");
const tooNew = destinationIsPermitted({ address: OTHER, entries: LIST, opensAt: PROPOSAL_OPENS, ...RULES });
check("A destination 1 day old is refused", tooNew.permitted, false, tooNew.reason);
const unknown = destinationIsPermitted({
  address: bitcoin.payments.p2wpkh({ pubkey: ownerPubkey, network: NETWORK }).address,
  entries: LIST, opensAt: PROPOSAL_OPENS, ...RULES,
});
check("An address not on the list at all is refused", unknown.permitted, false, unknown.reason);

const revokedList = [...LIST, attested({
  instance: INSTANCE, index: 3, op: "revoke", address: DEST, text: "Compromised",
  added: "2026-11-21T00:00:00Z", prev: destinationHash(e2),
  firstSeen: "2026-11-21T00:00:00Z",
})];
const revoked = destinationIsPermitted({ address: DEST, entries: revokedList, opensAt: "2026-12-01T00:00:00Z", ...RULES });
check("A revoked destination is refused", revoked.permitted, false, revoked.reason);

check("An entry from another instance breaks the chain",
  chainIsIntact([e1, { ...e2, instance: OTHER_INSTANCE }]).ok, false,
  "a signature made for one instance cannot verify against another");
check("The same entry under a different instance hashes differently",
  destinationHash(e1) === destinationHash({ ...e1, instance: OTHER_INSTANCE }), false,
  "so the attestation does not carry across");
check("A line with no instance is refused",
  (() => { try { destinationLine({ ...e1, instance: undefined }); return false; } catch { return true; } })(),
  true, "every entry is bound to its declaration");

// A backdated `added` must not buy age. firstSeen is what counts.
const backdated = [{ ...e2, index: 1, prev: ZERO_PREV, added: "2026-01-01T00:00:00Z" }];
const bd = destinationIsPermitted({ address: OTHER, entries: backdated, opensAt: PROPOSAL_OPENS, ...RULES });
check("Backdating `added` does not buy age", bd.permitted, false,
  "age comes from first public appearance, not the attestor's claim");

// The same attack, in the form it actually took: omit firstSeen entirely and
// let the code fall back to the field the attestor writes. It used to.
const noFirstSeen = [(() => { const e = { ...e2, index: 1, prev: ZERO_PREV, added: "2026-01-01T00:00:00Z" }; delete e.firstSeen; return e; })()];
const nfs = destinationIsPermitted({ address: OTHER, entries: noFirstSeen, opensAt: PROPOSAL_OPENS, ...RULES });
check("An entry with no first public appearance is refused outright", nfs.permitted, false,
  "no fallback to `added`: an undatable entry is not spendable against");

// --- Attestations ----------------------------------------------------------
//
// The list's only protection. For a long time nothing checked these at all.

line();
line("ATTESTATIONS");
line();

check("A properly attested entry passes", attestationsAreValid(e1, RULES).ok, true);

check("An entry with no attestations at all is refused",
  attestationsAreValid({ ...e1, attestations: [] }, RULES).ok, false,
  "the whole finding: an unattested list used to read as attested");

check("An attestation by somebody who is not a listed attestor is refused",
  attestationsAreValid({ ...e1, attestations: [attest(e1, outsiderKey)] }, RULES).ok, false,
  "a real signature by the wrong person is still the wrong person");

check("A forged signature is refused",
  attestationsAreValid({ ...e1, attestations: [{ address: ATTESTOR_A, signature: attest(e2, attestorKeyA).signature }] }, RULES).ok,
  false, "A's signature over a DIFFERENT entry does not attest this one");

check("An attestation moved from another instance is refused",
  attestationsAreValid(
    { ...e1, instance: OTHER_INSTANCE, attestations: e1.attestations }, { ...RULES, threshold: 1 },
  ).ok, false, "the statement carries the entry hash, which carries the instance");

// Threshold arithmetic. The second of these is the one worth having.
const twoOf = { attestors: ATTESTORS, threshold: 2, hrp: NETWORK.bech32 };
check("Two attestors where two are required passes",
  attestationsAreValid({ ...e1, attestations: [attest(e1, attestorKeyA), attest(e1, attestorKeyB)] }, twoOf).ok, true);

check("One attestor signing TWICE does not meet a threshold of two",
  attestationsAreValid({ ...e1, attestations: [attest(e1, attestorKeyA), attest(e1, attestorKeyA)] }, twoOf).ok,
  false, "distinct signers, or one attestor could meet any threshold alone");

check("A threshold higher than the number of attestors is refused",
  attestationsAreValid(e1, { attestors: [ATTESTOR_A], threshold: 2, hrp: NETWORK.bech32 }).ok, false,
  "a rule that can never be satisfied is a broken list, not a safe one");

// --- The canonical proposal document ---------------------------------------

line();
line("THE CANONICAL PROPOSAL DOCUMENT");
line();

const P = {
  instance: INSTANCE,
  destination: DEST,
  requiresPence: 440_000_000_00,
  document: createHash("sha256").update("the proposal's prose").digest("hex"),
  opens: "2026-11-21T00:00:00Z",
  closes: "2026-12-19T00:00:00Z",
  settlesBy: "2027-01-02T00:00:00Z",
};

line(`proposal line  ${proposalLine(P).slice(0, 66)}…`);
line(`proposal hash  ${proposalHash(P)}`);
line();

check("The same proposal hashes the same way twice", proposalHash(P) === proposalHash({ ...P }), true,
  "two people writing it out must reach the same hash, or neither can check the other");

check("A different destination is a different proposal",
  proposalHash(P) === proposalHash({ ...P, destination: OTHER }), false);
check("A different price is a different proposal",
  proposalHash(P) === proposalHash({ ...P, requiresPence: P.requiresPence + 1 }), false);
check("A different prose document is a different proposal",
  proposalHash(P) === proposalHash({ ...P, document: "f".repeat(64) }), false);
check("The same proposal under another Crowdlock is a different proposal",
  proposalHash(P) === proposalHash({ ...P, instance: OTHER_INSTANCE }), false,
  "so a proposal cannot be replayed into somebody else's instance");

const refusesProposal = (what, p, why) => check(what,
  (() => { try { proposalLine(p); return false; } catch { return true; } })(), true, why);

refusesProposal("A proposal with no instance", { ...P, instance: undefined }, "every proposal is bound to its declaration");
refusesProposal("A pound figure that is not whole pence", { ...P, requiresPence: 12.5 }, "pence are integers");
refusesProposal("A negative price", { ...P, requiresPence: -1 });
refusesProposal("A pipe smuggled into a field", { ...P, destination: "bc1q|evil" }, "or the line could be forged by punctuation");
refusesProposal("A window that closes before it opens", { ...P, closes: "2026-11-01T00:00:00Z" });
refusesProposal("Settlement before the window closes", { ...P, settlesBy: "2026-12-01T00:00:00Z" });
refusesProposal("A prose document that is not a hash", { ...P, document: "see the website" });

// ---------------------------------------------------------------------------
// A good commitment
// ---------------------------------------------------------------------------

const PROPOSAL = {
  hash: createHash("sha256").update("a proposal document").digest("hex"),
  destination: DEST,
  opensAt: PROPOSAL_OPENS,
};

const COMMIT = 400_000;
const FEE = 300;

const built = buildCommitment({
  utxo, witnessScript: lock.witnessScript, destination: DEST,
  commitSats: COMMIT, feeSats: FEE, ownerKey,
  remainder: { fanPubkey: ownerPubkey, cosignerPubkey, locktime: LOCKTIME },
  network: NETWORK,
});

const record = {
  proposal: PROPOSAL.hash,
  lock: {
    address: lock.address,
    owner_pubkey: ownerPubkey.toString("hex"),
    cosigner_pubkey: cosignerPubkey.toString("hex"),
    locktime: LOCKTIME,
  },
  remainder: {
    owner_pubkey: ownerPubkey.toString("hex"),
    cosigner_pubkey: cosignerPubkey.toString("hex"),
    locktime: LOCKTIME,
  },
  tx: built.hex,
};

const verifyWith = (r, extra = {}) => verifyCommitment({
  record: r, proposal: PROPOSAL, destinationEntries: LIST, destinationRules: RULES,
  utxoValue: utxo.value, network: NETWORK, ...extra,
});

line();
rule();
line("A GOOD COMMITMENT");
rule();

const good = verifyWith(record);
check("Verifies", good.valid, true, good.reason || `${good.committedSats} sats committed`);
check("Committed amount is output 0, not the lock's balance",
  good.committedSats, COMMIT, `lock holds ${utxo.value}, commits ${COMMIT}`);
check("The coins have not moved",
  built.tx.ins[0].witness[0].length === 0, true,
  "the co-signer's slot is empty, so this cannot be broadcast");
check("Declares no locktime", built.tx.locktime, 0);
for (const c of good.checks) line(`      ·  ${c.name}${c.detail ? "  — " + c.detail : ""}`);

// ---------------------------------------------------------------------------
// The ways it must be refused
// ---------------------------------------------------------------------------

line();
rule();
line("THE WAYS IT MUST BE REFUSED");
rule();

// a different proposal
rejects("A record naming a different proposal",
  verifyWith({ ...record, proposal: "f".repeat(64) }), "different proposal");

// tampered destination
const toOther = buildCommitment({
  utxo, witnessScript: lock.witnessScript, destination: OTHER,
  commitSats: COMMIT, feeSats: FEE, ownerKey,
  remainder: { fanPubkey: ownerPubkey, cosignerPubkey, locktime: LOCKTIME },
  network: NETWORK,
});
rejects("Pays somewhere other than the proposal's destination",
  verifyWith({ ...record, tx: toOther.hex }), "the proposal names");

// a destination that is real but too new
rejects("Pays a destination that has not waited 14 days",
  verifyCommitment({
    record: { ...record, tx: toOther.hex }, destinationEntries: LIST, destinationRules: RULES,
    proposal: { ...PROPOSAL, destination: OTHER },
    utxoValue: utxo.value, network: NETWORK,
  }), "needs 14");

// a destination nobody attested
const UNLISTED = bitcoin.payments.p2wpkh({ pubkey: ownerPubkey, network: NETWORK }).address;
const toUnlisted = buildCommitment({
  utxo, witnessScript: lock.witnessScript, destination: UNLISTED,
  commitSats: COMMIT, feeSats: FEE, ownerKey,
  remainder: { fanPubkey: ownerPubkey, cosignerPubkey, locktime: LOCKTIME },
  network: NETWORK,
});
rejects("Pays a destination nobody attested",
  verifyCommitment({
    record: { ...record, tx: toUnlisted.hex }, destinationEntries: LIST, destinationRules: RULES,
    proposal: { ...PROPOSAL, destination: UNLISTED },
    utxoValue: utxo.value, network: NETWORK,
  }), "not on the published destinations list");

// a revoked destination
rejects("Pays a revoked destination",
  verifyCommitment({
    record, proposal: PROPOSAL, destinationEntries: revokedList, destinationRules: RULES,
    utxoValue: utxo.value, network: NETWORK,
  }), "revoked by entry");

// a list nobody vouched for: the finding, in the place a commitment meets it
rejects("A commitment whose destinations list comes with no attestor set",
  verifyCommitment({
    record, proposal: PROPOSAL, destinationEntries: LIST,
    utxoValue: utxo.value, network: NETWORK,
  }), "no attestor set");

// an entry whose attestation is real but by the wrong person
rejects("A commitment against a list attested by an outsider",
  verifyCommitment({
    record, proposal: PROPOSAL,
    destinationEntries: [{ ...e1, attestations: [attest(e1, outsiderKey)] }, e2],
    destinationRules: RULES, utxoValue: utxo.value, network: NETWORK,
  }), "not a listed attestor");

// forged owner signature
const forged = buildCommitment({
  utxo, witnessScript: lock.witnessScript, destination: DEST,
  commitSats: COMMIT, feeSats: FEE, ownerKey: strangerKey,
  remainder: { fanPubkey: ownerPubkey, cosignerPubkey, locktime: LOCKTIME },
  network: NETWORK,
});
rejects("A stranger signed it, claiming to be the owner",
  verifyWith({ ...record, tx: forged.hex }), "does not verify");

// the lock fields lie about the address
rejects("Lock address does not match the stated keys",
  verifyWith({ ...record, lock: { ...record.lock, locktime: LOCKTIME + 1 } }),
  "does not re-derive");

// a "lock" whose owner is also its co-signer is no lock at all
rejects("A lock whose owner key is also the co-signer key",
  verifyWith({ ...record, lock: { ...record.lock, cosigner_pubkey: record.lock.owner_pubkey } }),
  "must be different keys");

// an absurd fee
const greedy = buildCommitment({
  utxo, witnessScript: lock.witnessScript, destination: DEST,
  commitSats: 10_000, feeSats: 990_000, ownerKey, network: NETWORK,
});
rejects(`A fee above ${MAX_FEE_FRACTION * 100}% of the committed amount`,
  verifyWith({ ...record, tx: greedy.hex, remainder: undefined }), "refusing in case of a client bug");

// a remainder that escapes the lock early
const escapeEarly = buildCommitment({
  utxo, witnessScript: lock.witnessScript, destination: DEST,
  commitSats: COMMIT, feeSats: FEE, ownerKey,
  remainder: { fanPubkey: ownerPubkey, cosignerPubkey, locktime: LOCKTIME - 100_000 },
  network: NETWORK,
});
rejects("Remainder goes to a lock that expires EARLIER",
  verifyWith({
    ...record,
    remainder: { ...record.remainder, locktime: LOCKTIME - 100_000 },
    tx: escapeEarly.hex,
  }), "an early escape");

// a remainder that goes to somebody else
const escapeToStranger = buildCommitment({
  utxo, witnessScript: lock.witnessScript, destination: DEST,
  commitSats: COMMIT, feeSats: FEE, ownerKey,
  remainder: { fanPubkey: Buffer.from(strangerKey.publicKey), cosignerPubkey, locktime: LOCKTIME },
  network: NETWORK,
});
rejects("Remainder goes to somebody ELSE's lock",
  verifyWith({
    ...record,
    remainder: { ...record.remainder, owner_pubkey: Buffer.from(strangerKey.publicKey).toString("hex") },
    tx: escapeToStranger.hex,
  }), "different owner");

// a spent coin
rejects("The coin has already been spent",
  verifyWith(record, { coinIsUnspent: false }), "already been spent");

// an already-complete transaction submitted as a commitment
const prematurely = completeCommitment({ record, cosignerKey, utxoValue: utxo.value, network: NETWORK });
rejects("An already-completed spend submitted as a commitment",
  verifyWith({ ...record, tx: prematurely.hex }), "not a commitment");

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

line();
rule();
line("SETTLEMENT");
rule();

const done = completeCommitment({ record, cosignerKey, utxoValue: utxo.value, network: NETWORK });
const dw = done.tx.ins[0].witness;

check("The co-signer's slot is now filled", dw[0].length > 0, true, `${dw[0].length} bytes`);
check("The owner's signature is untouched", dw[2].equals(built.tx.ins[0].witness[2]), true);
check("Still the purchase branch", dw[1].length === 0 && dw[3].equals(lock.witnessScript), true);
check("Both signatures verify over the same sighash",
  (() => {
    const ecc = bitcoin.script.signature;
    const o = ecc.decode(dw[2]), c = ecc.decode(dw[0]);
    return ownerKey.verify(done.sighash, o.signature) && cosignerKey.verify(done.sighash, c.signature);
  })(), true);
check("Completing it twice is refused",
  (() => {
    try { completeCommitment({ record: { ...record, tx: done.hex }, cosignerKey, utxoValue: utxo.value, network: NETWORK }); return false; }
    catch { return true; }
  })(), true);
check("The co-signer cannot change where the money goes",
  (() => {
    // Altering any output invalidates the owner's signature, which the
    // co-signer cannot replace. So a tampered settlement cannot be completed.
    const t = bitcoin.Transaction.fromHex(done.hex);
    t.outs[0].script = bitcoin.address.toOutputScript(OTHER, NETWORK);
    const r = verifyWith({ ...record, tx: t.toHex() });
    return !r.valid;
  })(), true, "redirecting it invalidates the owner's signature");

// ---------------------------------------------------------------------------
// One Crowdlock, never another
// ---------------------------------------------------------------------------

line();
rule();
line("ONE CROWDLOCK, NEVER ANOTHER");
rule();

// The Kop Fund's own file, given this test's co-signer. A second Crowdlock with
// a different co-signer. The commitment above belongs to the first only.
const kop = JSON.parse(readFileSync(new URL("../crowdlocks/kop-fund.json", import.meta.url), "utf8"));
const ours = { ...kop, cosigner_keys: [cosignerPubkey.toString("hex")] };
const theirs = { ...kop, name: "Another Crowdlock", cosigner_keys: [Buffer.from(strangerKey.publicKey).toString("hex")] };

const mine = verifyWith(record, { crowdlock: ours });
check("Verifies under the Crowdlock that co-signs it", mine.valid, true, mine.reason || ours.name);
rejects("Refused by a Crowdlock with a different co-signer",
  verifyWith(record, { crowdlock: theirs }), "belongs to a different Crowdlock");
const leaksAcross = buildCommitment({
  utxo, witnessScript: lock.witnessScript, destination: DEST,
  commitSats: COMMIT, feeSats: FEE, ownerKey,
  remainder: { fanPubkey: ownerPubkey, cosignerPubkey: Buffer.from(strangerKey.publicKey), locktime: LOCKTIME },
  network: NETWORK,
});
rejects("Refused when the remainder moves to another Crowdlock",
  verifyWith(
    { ...record, remainder: { ...record.remainder, cosigner_pubkey: theirs.cosigner_keys[0] }, tx: leaksAcross.hex },
    { crowdlock: ours },
  ), "co-signed by a different Crowdlock");
rejects("The Crowdlock's own fee cap is used, not the default",
  verifyWith(record, { crowdlock: { ...ours, max_commitment_fee: 0.0005 } }), "refusing in case of a client bug");
rejects("The Crowdlock's own destination wait is used, not the default",
  verifyWith(record, { crowdlock: { ...ours, destination_wait_days: 10_000 } }), "needs 10000");

line();
rule();
line(failures === 0
  ? "Commitments behave as spec/commitment-format.md describes."
  : `${failures} check(s) failed.`);
rule();
line();

process.exit(failures === 0 ? 0 : 1);
