// The join page's logic, exercised the way a browser would run it.
//
// The page itself cannot be unit-tested, but everything it decides with can:
// it reads the Crowdlock file, builds the statement from it, and feeds that to
// verifyMembership. If those agree with a signature made by a real wallet
// library, the page will accept a real member and reject everything else.
//
// Run:  node js/join.test.mjs

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as bitcoin from "../lock/node_modules/bitcoinjs-lib/src/index.js";
import { ECPairFactory } from "../lock/node_modules/ecpair/src/index.js";
import * as ecc from "../lock/node_modules/tiny-secp256k1/lib/index.js";
import bitcoinMessage from "../lock/node_modules/bitcoinjs-message/index.js";
import { verifyMembership } from "./verify.mjs";
import { membershipStatement } from "./crowdlock.mjs";

const ECPair = ECPairFactory(ecc);
const R = fileURLToPath(new URL("../", import.meta.url));

let failures = 0;
const check = (name, got, want, detail = "") => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`);
};

// --- what the page loads ---------------------------------------------------

const index = JSON.parse(readFileSync(R + "crowdlocks/index.json", "utf8"));
const c = JSON.parse(readFileSync(R + `crowdlocks/${index.crowdlocks[0]}.json`, "utf8"));
const STATEMENT = membershipStatement(c);

console.log("\n" + "-".repeat(74));
console.log("THE JOIN PAGE'S LOGIC");
console.log("-".repeat(74));
console.log(`crowdlock   ${c.name}`);
console.log(`statement   ${STATEMENT}`);
console.log();

check("The registry names at least one Crowdlock", index.crowdlocks.length > 0, true);
check("The statement carries the declaration's fingerprint",
  STATEMENT.includes(c.declaration.sha256), true);
check("The fingerprint matches the declaration file",
  c.declaration.sha256,
  createHash("sha256").update(readFileSync(R + c.declaration.file, "utf8"), "utf8").digest("hex"));

// --- a real member ---------------------------------------------------------

const kp = ECPair.makeRandom();
const priv = Buffer.from(kp.privateKey);
const address = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey) }).address;
const signature = bitcoinMessage.sign(STATEMENT, priv, kp.compressed, { segwitType: "p2wpkh" }).toString("base64");

const good = verifyMembership({ address, signature, message: STATEMENT });
check("A genuine signature is accepted", good.valid, true, address);

// --- the ways the page must refuse -----------------------------------------

console.log();
const retyped = STATEMENT.replace("join as a member", "join as a Member");
check("A retyped statement with one letter changed is refused",
  verifyMembership({ address, signature, message: retyped }).valid, false,
  "why the page says copy rather than retype");

const other = ECPair.makeRandom();
const otherAddress = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(other.publicKey) }).address;
const mismatch = verifyMembership({ address: otherAddress, signature, message: STATEMENT });
check("A signature pasted under the wrong address is refused", mismatch.valid, false);
check("…and the page can name the address it really belongs to",
  mismatch.derived, address, "so the message is useful rather than just 'invalid'");

check("Half a signature is refused",
  verifyMembership({ address, signature: signature.slice(0, 40), message: STATEMENT }).valid, false);
check("Nonsense is refused",
  verifyMembership({ address, signature: "not a signature", message: STATEMENT }).valid, false);
check("An empty signature is refused",
  verifyMembership({ address, signature: "", message: STATEMENT }).valid, false);

// A declaration fingerprint that does not match this Crowdlock must not pass,
// or a signature could be lifted from another instance.
const otherStatement = membershipStatement({
  declaration: { ...c.declaration, sha256: "b".repeat(64) },
});
check("A signature for a different declaration is refused",
  verifyMembership({ address, signature, message: otherStatement }).valid, false,
  "signatures cannot be moved between Crowdlocks");

console.log("\n" + "-".repeat(74));
console.log(failures === 0
  ? "The join page will accept a real member and refuse everything else."
  : `${failures} check(s) failed.`);
console.log();
process.exit(failures === 0 ? 0 : 1);
