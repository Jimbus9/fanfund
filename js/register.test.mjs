// The live register must be true, not just well-formed.
//
// Run:  node js/register.test.mjs
//
// Every other test in this repository works on invented data. This one works
// on the real registrations.json that the site serves, and asks the questions
// a stranger would ask of it:
//
//   * does every published signature actually verify against the declaration
//     the Crowdlock names?
//   * are the member numbers sane — sequential from 1, no gaps, no repeats?
//   * does any address appear twice, which would let one person count twice?
//   * does the file agree with the Crowdlock about which declaration it is?
//
// A register that fails any of these is worse than an empty one, because it
// invites people to trust a count that is wrong. So this runs in the suite and
// fails the build rather than waiting for somebody to notice in a browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyMembership } from "./verify.mjs";
import { checkRegisterFiles, membershipStatement } from "./crowdlock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

let failures = 0;
const rule = () => console.log("-".repeat(74));
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};

const crowdlock = read("crowdlocks/kop-fund.json");
const register = read(crowdlock.register.registrations);
const statement = membershipStatement(crowdlock);

rule();
console.log(`The live register: ${crowdlock.register.registrations}`);
rule();

const agree = checkRegisterFiles(crowdlock, { registrations: register });
check("The register names the same declaration as the Crowdlock", agree.ok,
  agree.problems.join("; "));

const members = register.members ?? [];
console.log(`${members.length} member${members.length === 1 ? "" : "s"} on the register.`);

for (const m of members) {
  const r = verifyMembership({ address: m.address, signature: m.signature, message: statement });
  check(`Member ${m.n ?? "?"} (${m.address.slice(0, 12)}…) signed the declaration`, r.valid,
    r.valid ? "" : `${r.reason}${r.derived ? ` — signature belongs to ${r.derived}` : ""}`);
}

const numbers = members.map((m) => m.n);
check("Member numbers run 1, 2, 3 … with no gaps or repeats",
  numbers.every((n, i) => n === i + 1),
  `got ${JSON.stringify(numbers)}`);

const addresses = members.map((m) => m.address);
check("No address appears twice", new Set(addresses).size === addresses.length);

// A member address is the hash of a lock owner's public key, so a lock claiming
// an owner nobody has registered is a lock counted for a non-member.
const locks = register.locks ?? [];
const known = new Set(addresses);
for (const lock of locks) {
  check(`Lock ${lock.address?.slice(0, 12) ?? "?"}… belongs to a registered member`,
    known.has(lock.member), `member ${lock.member}`);
}

console.log();
rule();
console.log(failures === 0
  ? "The register is true: every published signature verifies against the declaration."
  : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
