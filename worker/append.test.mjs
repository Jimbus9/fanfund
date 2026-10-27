// What the join endpoint will and will not accept.
//
// Run:  node worker/append.test.mjs
//
// The endpoint's whole judgement lives in append.mjs, so this is where the
// endpoint is actually tested. The network shell around it is thin on purpose.
// Mostly these are refusals, because what matters about something that can
// write to the register is what it refuses to write.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { addRegistration } from "./append.mjs";
import { membershipStatement } from "../js/crowdlock.mjs";

const R = join(dirname(fileURLToPath(import.meta.url)), "..");
const crowdlock = JSON.parse(readFileSync(join(R, "crowdlocks/kop-fund.json"), "utf8"));
const statement = membershipStatement(crowdlock);
const today = "2026-10-27";

// A real, verified registration — the one on the live register.
const REAL = {
  address: "bc1qx22lej8slm4g6f5l85tte0peraha7km30lqxw7",
  signature: "H7yCAMd+09Ap+GnsO7chcHd9ILDdBvMBruTeHF6WPyBHTUH6e2dJlaGi3nRGuaEtYvC9258+LzM1Y9kLmJpsD5I=",
};

const empty = () => ({
  format: 1,
  declaration: { sha256: crowdlock.declaration.sha256, statement },
  members: [],
  locks: [],
});

let failures = 0;
const rule = () => console.log("-".repeat(74));
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};
const refuses = (what, outcome, expect) =>
  check(what, !outcome.ok && outcome.reason.includes(expect),
    outcome.ok ? "it was ACCEPTED" : outcome.reason);

rule();
console.log("WHAT THE JOIN ENDPOINT ACCEPTS AND REFUSES");
rule();

// --- what it accepts -------------------------------------------------------

const first = addRegistration(empty(), REAL, { statement, today });
check("A real signature is accepted", first.ok, first.reason ?? "");
check("…and is given number 1", first.n === 1, String(first.n));
check("…with the date it arrived", first.register.members[0].signed === today);
check("…and nothing else about them is recorded",
  Object.keys(first.register.members[0]).sort().join(",") === "address,n,signature,signed");

// --- what it refuses -------------------------------------------------------

refuses("The same address twice",
  addRegistration(first.register, REAL, { statement, today }), "already on the register");

refuses("A signature for a different declaration",
  addRegistration(empty(), REAL, { statement: statement.replace("v1", "v2"), today }),
  "different address");

refuses("Somebody else's signature claimed for your address",
  addRegistration(empty(), { ...REAL, address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" },
    { statement, today }), "different address");

refuses("Half a signature",
  addRegistration(empty(), { ...REAL, signature: REAL.signature.slice(0, 40) },
    { statement, today }), "65 bytes");

refuses("Nonsense in the signature field",
  addRegistration(empty(), { ...REAL, signature: "not a signature at all" },
    { statement, today }), "signature");

refuses("No address", addRegistration(empty(), { signature: REAL.signature },
  { statement, today }), "both an address and a signature");

refuses("No signature", addRegistration(empty(), { address: REAL.address },
  { statement, today }), "both an address and a signature");

refuses("Nothing at all", addRegistration(empty(), {}, { statement, today }),
  "both an address and a signature");

refuses("A megabyte where an address should be",
  addRegistration(empty(), { address: "b".repeat(1_000_000), signature: REAL.signature },
    { statement, today }), "not an address");

refuses("A megabyte where a signature should be",
  addRegistration(empty(), { address: REAL.address, signature: "A".repeat(1_000_000) },
    { statement, today }), "not a signature");

refuses("A register file of the wrong shape",
  addRegistration({ members: "lots" }, REAL, { statement, today }), "expected shape");

// --- the properties that matter --------------------------------------------

const before = empty();
const frozen = JSON.stringify(before);
addRegistration(before, { ...REAL, signature: "rubbish" }, { statement, today });
check("A refusal leaves the register completely untouched", JSON.stringify(before) === frozen);

const accepted = addRegistration(before, REAL, { statement, today });
check("An acceptance does not mutate the register it was given either",
  JSON.stringify(before) === frozen && accepted.register.members.length === 1);

// Numbers come from the file, not from its length, so a hand-edited register
// cannot cause a number to be reused.
const gapped = { ...empty(), members: [{ n: 7, address: "bc1qzzz", signature: "x", signed: today }] };
check("The next number is one past the highest, not the member count",
  addRegistration(gapped, REAL, { statement, today }).n === 8);

// An uppercase address is the same address (BIP-173), so it is a duplicate.
refuses("The same address submitted in upper case",
  addRegistration(first.register, { ...REAL, address: REAL.address.toUpperCase() },
    { statement, today }), "already on the register");

console.log();
rule();
console.log(failures === 0
  ? "The endpoint accepts a real signature and refuses everything else tried here."
  : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
