// Planning a lock from public records alone.
//
// Run:  node method/js/lockplan.test.mjs
//
// The strongest evidence available is the test register itself: it holds real
// locks that were built by the app, from the member's own key, and that Bitcoin
// accepted. If this module, given only the register and the Crowdlock file,
// arrives at the same address as one of those, then the owner key recovered
// from the signature, the co-signer key, the rounding rule and the address
// derivation are all right at once.

import { readFileSync } from "node:fs";
import { planLock, lockDate } from "./lockplan.mjs";
import { verifyMembership } from "./verify.mjs";
import { membershipStatement } from "./crowdlock.mjs";

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(66)} ${detail}`);
};
const rule = () => console.log("-".repeat(78));
const read = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));

console.log(); rule(); console.log("PLANNING A LOCK FROM THE REGISTER ALONE"); rule(); console.log();

const crowdlock = read("crowdlocks/kop-fund-testnet4.json");
const register = read(crowdlock.register.registrations);
const known = register.locks.find((l) => l.locktime === 1825027200); // 1 year, made 31 October
const first = register.members[0];

check("the test register holds the one-year lock this is checked against", !!known);

// --- The rounding rule --------------------------------------------------------
const noon31Oct = Date.UTC(2026, 9, 31, 12) / 1000;
check("a year is 365.25 days, rounded up to the next midnight UTC",
  lockDate(1, noon31Oct) === 1825027200, new Date(lockDate(1, noon31Oct) * 1000).toISOString());
check("two different times on the same day give the same date",
  lockDate(1, noon31Oct) === lockDate(1, noon31Oct + 3600 * 5));
check("a length under a day is not rounded", lockDate(1 / 8766, 1800000000) === 1800000000 + 3600);
check("exactly midnight is not pushed a day on", lockDate(1, 1825027200 - 31557600) === 1825027200);

// --- The key behind a member ---------------------------------------------------
const v = verifyMembership({
  address: first.address, signature: first.signature, message: membershipStatement(crowdlock), hrp: "tb",
});
check("the member's signature is valid", v.valid);
const viaPlan = planLock({ crowdlock, register, member: "1", years: 1, now: Date.UTC(2026, 9, 31, 12) / 1000 });
check("a compressed public key is recovered from it", /^0[23][0-9a-f]{64}$/.test(viaPlan.ownerPubkey ?? ""));
check("it is the key the app really used for that member's locks", viaPlan.ownerPubkey === known?.owner_pubkey);

// --- The plan, against a lock Bitcoin has already accepted ----------------------
const plan = planLock({ crowdlock, register, member: first.address, years: 1, now: noon31Oct });
check("a plan is made for a registered member", plan.ok, plan.reason ?? "");
check("it reaches EXACTLY the address of the real lock", plan.address === known?.address, plan.address);
check("same keys and same date as the real lock",
  plan.ownerPubkey === known?.owner_pubkey && plan.cosignerPubkey === known?.cosigner_pubkey && plan.locktime === known?.locktime);
check("it says the lock is already on the register (same day, same length)", plan.alreadyOnRegister === true);
check("the member can be named by number as well as by address",
  planLock({ crowdlock, register, member: "1", years: 1, now: noon31Oct }).address === plan.address);
check("an upper-case address is accepted",
  planLock({ crowdlock, register, member: first.address.toUpperCase(), years: 1, now: noon31Oct }).ok);
check("the record to publish carries exactly what the inbox reads",
  JSON.stringify(Object.keys(plan.record)) === JSON.stringify(["type", "owner_pubkey", "cosigner_pubkey", "locktime", "address"])
  && plan.record.type === "lock");
check("a different day gives a different address",
  planLock({ crowdlock, register, member: "1", years: 1, now: noon31Oct + 2 * 86400 }).address !== plan.address);
check("a new lock (not yet registered) is not marked as already there",
  planLock({ crowdlock, register: { ...register, locks: [] }, member: "1", years: 1, now: noon31Oct }).alreadyOnRegister === false);

// --- Refusals -------------------------------------------------------------------
const refuses = (what, args) => {
  const r = planLock({ crowdlock, register, member: first.address, years: 1, now: noon31Oct, ...args });
  check(what, r.ok === false, r.ok ? "WAS ACCEPTED" : r.reason.slice(0, 50));
};
refuses("someone who is not on the register", { member: "tb1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" });
refuses("a length the Crowdlock does not offer", { years: 7 });
refuses("no one named", { member: "" });
{
  const r = planLock({ crowdlock: { ...crowdlock, cosigner_keys: [] }, register, member: "1", years: 1, now: noon31Oct });
  check("a Crowdlock with no co-signer key", r.ok === false);
}
{
  const bad = { ...register, members: register.members.map((m, i) => i === 0 ? { ...m, signature: m.signature.slice(0, -4) + "AAAA" } : m) };
  const r = planLock({ crowdlock, register: bad, member: "1", years: 1, now: noon31Oct });
  check("a member whose stored signature does not check", r.ok === false);
}
{
  const r = planLock({ crowdlock: { ...crowdlock, network: "nowhere" }, register, member: "1", years: 1, now: noon31Oct });
  check("a network the page does not know", r.ok === false);
}
{
  // The owner key must not be offered as the co-signer.
  const r = planLock({ crowdlock: { ...crowdlock, cosigner_keys: [known.owner_pubkey] }, register, member: "1", years: 1, now: noon31Oct });
  check("a Crowdlock whose co-signer is the member's own key", r.ok === false);
}

console.log(); rule();
console.log(failures === 0 ? "Every lock this page offers rebuilds exactly as the register would judge it." : `${failures} problem(s).`);
rule(); console.log();
process.exit(failures === 0 ? 0 : 1);
