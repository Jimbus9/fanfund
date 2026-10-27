// What the lock endpoint will accept and refuse.
//
// Run:  node js/lockrecord.test.mjs      (needs `npm install` in lock/ once,
//                                         for the cross-check against bitcoinjs)
//
// Two halves.
//
// First, the address. js/lockrecord.mjs rebuilds a lock address with a few
// lines of its own, because the endpoint cannot carry bitcoinjs. That is only
// acceptable if it produces exactly the bytes the proven lock code does — the
// code whose locks Bitcoin itself enforced on testnet4. So every script and
// address here is compared against lock/lock.mjs, across networks and across
// locktimes chosen to hit the awkward encodings.
//
// Second, the judgement — mostly refusals, because that is where the value is.
// A lock endpoint that accepted the wrong thing would put money in the headline
// figure that is not really locked, or not really a member's.

import * as proven from "../lock/lock.mjs";
import { lockScript, lockAddress, hrpFor, prepareLock, addLock } from "./lockrecord.mjs";
import { memberAddressForOwnerKey } from "./verify.mjs";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(64)} ${detail}`);
};
const rule = () => console.log("-".repeat(78));
const hex = (b) => Buffer.from(b).toString("hex");

// Fixed keys, so the run is repeatable.
const key = (seed) => hex(proven.ECPair.fromPrivateKey(Buffer.alloc(32, seed)).publicKey);
const OWNER = key(1);
const COSIGNER = key(2);
const STRANGER = key(3);
const mirror = (k) => (k.startsWith("02") ? "03" : "02") + k.slice(2);

// ---------------------------------------------------------------------------
rule();
console.log("THE ADDRESS MATCHES THE PROVEN LOCK CODE, BYTE FOR BYTE");
rule();

const NOW = 1793000000; // late October 2026
const locktimes = [
  ["one year from now", NOW + 31557600],
  ["five years from now", NOW + 5 * 31557600],
  ["a date needing a padding byte (high bit set)", 2200000000],
  ["the largest locktime there is", 4294967295],
  ["a small block height (regtest)", 150],
  ["a height with the high bit set (128)", 128],
];
for (const [label, t] of locktimes) {
  const ours = hex(lockScript({ ownerPubkey: OWNER, cosignerPubkey: COSIGNER, locktime: t }));
  const theirs = hex(proven.lockScript({
    fanPubkey: Buffer.from(OWNER, "hex"), cosignerPubkey: Buffer.from(COSIGNER, "hex"), locktime: t,
  }));
  check(`Script: ${label}`, ours === theirs, ours === theirs ? `${ours.length / 2} bytes` : "DIFFERENT");
}

for (const net of ["mainnet", "testnet4"]) {
  const t = NOW + 3 * 31557600;
  const ours = lockAddress({ ownerPubkey: OWNER, cosignerPubkey: COSIGNER, locktime: t }, hrpFor(net));
  const theirs = proven.lockAddress({
    fanPubkey: Buffer.from(OWNER, "hex"), cosignerPubkey: Buffer.from(COSIGNER, "hex"),
    locktime: t, network: proven.networkFor(net),
  }).address;
  check(`Address on ${net}`, ours === theirs, ours.slice(0, 18) + "…");
}

const typical = lockScript({ ownerPubkey: OWNER, cosignerPubkey: COSIGNER, locktime: NOW + 31557600 });
check("A dated lock's script is the 79 bytes the spec gives", typical.length === 79, `${typical.length}`);

// ---------------------------------------------------------------------------
rule();
console.log("WHAT THE ENDPOINT ACCEPTS");
rule();

const kop = JSON.parse(readFileSync(new URL("../crowdlocks/kop-fund.json", import.meta.url), "utf8"));
const crowdlock = { ...kop, cosigner_keys: [COSIGNER] };
const member = memberAddressForOwnerKey(OWNER, "bc");
const register = {
  declaration: { sha256: kop.declaration.sha256 },
  members: [{ n: 1, address: member, signature: "x", signed: "2026-10-27" }],
  locks: [],
};
const frozen = JSON.stringify(register);
const good = { owner_pubkey: OWNER, cosigner_pubkey: COSIGNER, locktime: NOW + 31557600 };
const ctx = { crowdlock, register, now: NOW };

const p = prepareLock(good, ctx);
check("A genuine, member-owned lock is prepared", p.ok, p.ok ? p.lock.address.slice(0, 18) + "…" : p.reason);
check("…its member is the address the owner key hashes to", p.ok && p.lock.member === member);
check("…its unlock date is shown as a calendar date", p.ok && /^\d{4}-\d{2}-\d{2}$/.test(p.lock.unlocks), p.lock?.unlocks);

const added = p.ok && addLock(register, p.lock, { confirmedSats: 250000, today: "2026-10-27" });
check("With confirmed coins at the address, it joins the register", added.ok);
check("…as a record carrying the terms anyone can rebuild it from",
  added.ok && ["address", "member", "owner_pubkey", "cosigner_pubkey", "locktime", "unlocks", "submitted"]
    .every((k) => k in added.register.locks[0]));
check("…and the register passed in is untouched", JSON.stringify(register) === frozen);

const small = p.ok && addLock(register, p.lock, { confirmedSats: 1000, today: "2026-10-27" });
check("A lock below the minimum is still published (the counting rule decides)", small.ok);

const withAddr = prepareLock({ ...good, address: p.lock.address.toUpperCase() }, ctx);
check("Sending the address too is fine, in either case", withAddr.ok);

// ---------------------------------------------------------------------------
rule();
console.log("WHAT THE ENDPOINT REFUSES");
rule();

const refuses = (what, result, expect) => {
  const ok = !result.ok && String(result.reason).includes(expect);
  check(what, ok, result.ok ? "ACCEPTED IT" : result.reason.slice(0, 44));
};

refuses("No co-signer published yet (The Kop Fund today)",
  prepareLock(good, { ...ctx, crowdlock: kop }), "not published a co-signer key");
refuses("A co-signer key that is not this Crowdlock's",
  prepareLock({ ...good, cosigner_pubkey: STRANGER }, ctx), "not this Crowdlock's");
refuses("Owner and co-signer the same key",
  prepareLock({ ...good, owner_pubkey: COSIGNER }, ctx), "same key");
refuses("…or a key and its mirror",
  prepareLock({ ...good, owner_pubkey: mirror(COSIGNER) }, ctx), "same key");
refuses("A block height on a real network",
  prepareLock({ ...good, locktime: 900000 }, ctx), "must be a date");
refuses("A date already passed",
  prepareLock({ ...good, locktime: NOW - 1 }, ctx), "already passed");
refuses("A lock longer than the longest offered",
  prepareLock({ ...good, locktime: NOW + 6 * 31557600 }, ctx), "longer than this Crowdlock offers");
refuses("An owner who has not signed the declaration",
  prepareLock({ ...good, owner_pubkey: STRANGER }, { ...ctx, crowdlock: { ...crowdlock, cosigner_keys: [COSIGNER] } }),
  "not on the register");
refuses("An address that does not rebuild from the terms",
  prepareLock({ ...good, address: "bc1qwqdg6squsna38e46795at95yu9atm8azzmyvckulcc7kytlcckxswvvzej" }, ctx),
  "those terms make the address");
refuses("A lock already on the register",
  prepareLock(good, { ...ctx, register: added.register }), "already on the register");
refuses("No confirmed coins at the address yet",
  addLock(register, p.lock, { confirmedSats: 0, today: "2026-10-27" }), "no confirmed coins");
refuses("An uncompressed or malformed owner key",
  prepareLock({ ...good, owner_pubkey: "04" + "ab".repeat(64) }, ctx), "owner_pubkey must be");
refuses("A megabyte where a key should be",
  prepareLock({ ...good, cosigner_pubkey: "a".repeat(1e6) }, ctx), "cosigner_pubkey must be");
refuses("A locktime that is not a whole number",
  prepareLock({ ...good, locktime: "soon" }, ctx), "whole number");
refuses("A register file of the wrong shape",
  prepareLock(good, { ...ctx, register: { locks: [] } }), "not in the expected shape");

console.log();
rule();
console.log(failures === 0
  ? "The lock endpoint builds the same addresses as the proven code and refuses what it should."
  : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
