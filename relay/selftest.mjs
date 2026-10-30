// Self-test for the relay route: make a brand-new key, sign a Crowdlock's
// membership statement with it, and post the registration to that Crowdlock's
// relays — exactly what a member's app does. The next inbox run should add it
// as a new member. Test Crowdlocks only: it refuses real bitcoin.
//
//   node selftest.mjs kop-fund-testnet4

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { signAsync, getPublicKey, utils } from "../js/vendor/noble-secp256k1.js";
import { messageHash, memberAddressForOwnerKey, verifyMembership } from "../js/verify.mjs";
import { membershipStatement } from "../js/crowdlock.mjs";
import { hrpFor } from "../js/lockrecord.mjs";
import { postRecord } from "./nostr.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2] ?? "kop-fund-testnet4";
const crowdlock = JSON.parse(readFileSync(join(ROOT, "crowdlocks", `${name}.json`), "utf8"));
if (crowdlock.network === "mainnet") { console.log("Refusing: the self-test only posts to test Crowdlocks."); process.exit(1); }
if (!Array.isArray(crowdlock.relays)) { console.log(`${name} names no relays.`); process.exit(1); }

const hrp = hrpFor(crowdlock.network);
const priv = utils.randomPrivateKey();
const pub = Buffer.from(getPublicKey(priv, true)).toString("hex");
const address = memberAddressForOwnerKey(pub, hrp);
const statement = membershipStatement(crowdlock);
const sig = await signAsync(messageHash(statement), priv);
const signature = Buffer.concat([Buffer.from([31 + sig.recovery]), Buffer.from(sig.toCompactRawBytes())]).toString("base64");

const check = verifyMembership({ address, signature, message: statement, hrp });
if (!check.valid) { console.log(`The self-test made a bad signature: ${check.reason}`); process.exit(1); }

console.log(`Posting a registration for a brand-new test member, ${address}`);
const results = await postRecord(crowdlock.relays, { type: "join", address, signature }, crowdlock.declaration.sha256);
for (const r of results) console.log(`  ${r.relay}: ${r.ok ? "accepted" : `refused or unreachable (${r.reason})`}`);
if (!results.some((r) => r.ok)) process.exit(1);
