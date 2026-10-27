// Checks every Crowdlock this site publishes, then proves the checks refuse
// what they should.
//
// Run:  node js/crowdlock.test.mjs      (from the repo root; needs no installs)

import { readFileSync } from "node:fs";
import {
  canonicalise, declarationHash, membershipStatement,
  checkCrowdlock, checkRegisterFiles, checkSeparate, isCosignerOf,
} from "./crowdlock.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const json = (p) => JSON.parse(read(p));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(62)} ${detail}`);
};
const refuses = (name, result, expect) => {
  const ok = !result.ok && result.problems.some((p) => p.includes(expect));
  check(name, ok, result.ok ? "ACCEPTED IT" : result.problems[0].slice(0, 50));
};
const rule = () => console.log("-".repeat(78));

// ---------------------------------------------------------------------------
// Every published Crowdlock
// ---------------------------------------------------------------------------

rule();
console.log("EVERY CROWDLOCK IN crowdlocks/index.json");
rule();

const index = json("crowdlocks/index.json");
check("The index lists at least one Crowdlock", index.crowdlocks.length > 0, index.crowdlocks.join(", "));

const all = [];
for (const slug of index.crowdlocks) {
  const c = json(`crowdlocks/${slug}.json`);
  all.push(c);
  let declarationText = "";
  try { declarationText = read(c.declaration.file); } catch { /* reported as a hash mismatch below */ }
  const r = checkCrowdlock(c, { declarationText });
  check(`${c.name}: file is complete and its declaration hashes correctly`, r.ok, r.problems.join("; "));
  let f;
  try {
    f = checkRegisterFiles(c, {
      registrations: json(c.register.registrations),
      destinations: json(c.register.destinations),
    });
  } catch (e) { f = { ok: false, problems: [`a register file is missing or unreadable: ${e.message}`] }; }
  check(`${c.name}: its register files agree with it`, f.ok, f.problems.join("; "));
}
const sep = checkSeparate(all);
check("No two Crowdlocks share a declaration or a co-signer", sep.ok, sep.problems.join("; "));

// The Kop Fund's statement must come out byte for byte as it always has,
// or every signature ever made would stop verifying.
const kop = json("crowdlocks/kop-fund.json");
check("The Kop Fund's signing statement is unchanged",
  membershipStatement(kop) ===
    "I agree to the Supporters' Declaration v1 (sha256:3a0a0bca96ec2161d98ff9da05ae885d6b8d68e55ed412bc85dcc7fb16209b96) and join as a member.");

// ---------------------------------------------------------------------------
// What must be refused
// ---------------------------------------------------------------------------

console.log();
rule();
console.log("WHAT MUST BE REFUSED");
rule();

const decl = read(kop.declaration.file);
const K = (b) => "02" + b.repeat(32); // a well-formed compressed key
const mirror = (k) => "03" + k.slice(2);

refuses("A declaration altered by one character",
  checkCrowdlock(kop, { declarationText: decl.replace("Money in", "Money In") }), "hashes to");
check("Line endings and trailing spaces do not change the fingerprint",
  declarationHash(decl.replace(/\n/g, " \r\n")) === kop.declaration.sha256);
check("Canonical text ends in exactly one newline", canonicalise("a\n\n\n").endsWith("a\n"));

refuses("The same key as co-signer and attestor",
  checkCrowdlock({ ...kop, cosigner_keys: [K("ab")], attestor_keys: [K("ab")] }), "never be a key that spends");
refuses("…or as a key and its mirror",
  checkCrowdlock({ ...kop, cosigner_keys: [K("ab")], attestor_keys: [mirror(K("ab"))] }), "never be a key that spends");
refuses("An uncompressed or malformed co-signer key",
  checkCrowdlock({ ...kop, cosigner_keys: ["04" + "ab".repeat(64)] }), "not a compressed public key");
refuses("A join endpoint that is not https",
  checkCrowdlock({ ...kop, join_endpoint: "http://example.com/join/submit" }), "join_endpoint");
refuses("A join endpoint that is not text",
  checkCrowdlock({ ...kop, join_endpoint: 42 }), "join_endpoint");
{ const { join_endpoint, ...noEndpoint } = kop;
  check("A Crowdlock with no join endpoint is still valid", checkCrowdlock(noEndpoint, { declarationText: decl }).ok); }
refuses("A threshold larger than the number of attestors",
  checkCrowdlock({ ...kop, attestor_keys: [K("cd")], attestor_threshold: 2 }), "more than the number");
refuses("A title that could break the signed statement",
  checkCrowdlock({ ...kop, declaration: { ...kop.declaration, title: "Thing (v9)" } }), "brackets");
refuses("A fee cap of 100%",
  checkCrowdlock({ ...kop, max_commitment_fee: 1 }), "max_commitment_fee");
refuses("An unknown network",
  checkCrowdlock({ ...kop, network: "ethereum" }), "network must be");

refuses("A register file naming another declaration",
  checkRegisterFiles(kop, { registrations: { declaration: { sha256: "f".repeat(64) } } }), "different declaration");
refuses("A destinations list from another Crowdlock",
  checkRegisterFiles(kop, { destinations: { ...json("destinations.json"), instance: "e".repeat(64) } }), "different Crowdlock");

const woods = {
  ...kop, name: "A woodland",
  declaration: { ...kop.declaration, title: "Woodland Declaration", sha256: "d".repeat(64) },
};
refuses("Two Crowdlocks sharing a declaration",
  checkSeparate([kop, { ...woods, declaration: kop.declaration }]), "share a declaration");
refuses("Two Crowdlocks sharing a co-signer, so a coin could count twice",
  checkSeparate([{ ...kop, cosigner_keys: [K("ab")] }, { ...woods, cosigner_keys: [mirror(K("ab"))] }]), "share a co-signer");
check("Two genuinely separate Crowdlocks are accepted",
  checkSeparate([{ ...kop, cosigner_keys: [K("ab")] }, { ...woods, cosigner_keys: [K("cd")] }]).ok);

check("A lock is recognised by its own Crowdlock", isCosignerOf({ cosigner_keys: [K("ab")] }, K("ab")));
check("…and not by another", !isCosignerOf({ cosigner_keys: [K("cd")] }, K("ab")));

console.log();
rule();
console.log(failures === 0 ? "Every Crowdlock checks out, and the checks refuse what they should." : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
