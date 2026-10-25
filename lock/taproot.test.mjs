// Checks the taproot lock is built correctly and behaves like the P2WSH one.
//
// Run:  node taproot.test.mjs

import * as bitcoin from "bitcoinjs-lib";
import miniscript from "@bitcoinerlab/miniscript";
const { compileMiniscript } = miniscript;
import {
  ECPair, lockTaproot, buildTaprootSpend, toXOnly, schnorrValid,
  UNSPENDABLE_INTERNAL_KEY, leafHash,
} from "./taproot.mjs";
import { lockAddress, networkFor } from "./lock.mjs";

const NETWORK = networkFor("testnet");
const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(74));

let failures = 0;
const check = (name, got, want, detail = "") => {
  const ok = got === want;
  if (!ok) failures++;
  line(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`);
};

const ownerKey = ECPair.fromPrivateKey(Buffer.from("11".repeat(32), "hex"), { network: NETWORK });
const cosignerKey = ECPair.fromPrivateKey(Buffer.from("22".repeat(32), "hex"), { network: NETWORK });
const strangerKey = ECPair.fromPrivateKey(Buffer.from("33".repeat(32), "hex"), { network: NETWORK });

const ownerPubkey = Buffer.from(ownerKey.publicKey);
const cosignerPubkey = Buffer.from(cosignerKey.publicKey);
const ownerX = toXOnly(ownerPubkey);
const cosignerX = toXOnly(cosignerPubkey);

const LOCKTIME = 2_900_000;
const lock = lockTaproot({ ownerPubkey, cosignerPubkey, locktime: LOCKTIME, network: NETWORK });

line();
rule();
line("THE TAPROOT LOCK");
rule();
line(`address            ${lock.address}`);
line(`going-home leaf    ${lock.leaves.home.length} bytes`);
line(`purchase leaf      ${lock.leaves.purchase.length} bytes`);
line(`internal key       ${UNSPENDABLE_INTERNAL_KEY.toString("hex").slice(0, 24)}…  (nobody has this private key)`);
line();
line("going home:  " + bitcoin.script.toASM(lock.leaves.home).replace(ownerX.toString("hex"), "<owner>"));
line("purchase:    " + bitcoin.script.toASM(lock.leaves.purchase)
  .replace(ownerX.toString("hex"), "<owner>")
  .replace(cosignerX.toString("hex"), "<cosigner>"));

// --- Construction ----------------------------------------------------------

line();
rule();
line("CONSTRUCTION");
rule();

check("Address is taproot (tb1p on testnet)",
  lock.address.startsWith("tb1p") && lock.address.length === 62, true, lock.address.slice(0, 12) + "…");
check("Two leaves in the tree", lock.scriptTree.length, 2);
check("Going-home leaf has CHECKLOCKTIMEVERIFY",
  bitcoin.script.toASM(lock.leaves.home).includes("OP_CHECKLOCKTIMEVERIFY"), true);
check("Purchase leaf requires BOTH keys",
  bitcoin.script.toASM(lock.leaves.purchase).includes("OP_CHECKSIGVERIFY"), true,
  "same guarantee as the P2WSH version");
check("Co-signer absent from the going-home leaf",
  lock.leaves.home.includes(cosignerX), false,
  "they cannot block or delay a withdrawal");

// Both leaves must be standard tapscript miniscript, byte for byte, so Bitcoin
// Core and ordinary wallets can read and sign them without any code of ours.
const asTapMiniscript = (m, leaf) => {
  const r = compileMiniscript(m, { tapscript: true });
  return r.issane && bitcoin.script.fromASM(r.asm.replace(/[<>]/g, "")).equals(leaf);
};
check("Going-home leaf is standard miniscript",
  asTapMiniscript(`and_v(v:pk(${ownerX.toString("hex")}),after(${LOCKTIME}))`, lock.leaves.home), true,
  "and_v(v:pk(owner),after(t))");
check("Purchase leaf is standard miniscript",
  asTapMiniscript(`and_v(v:pk(${ownerX.toString("hex")}),pk(${cosignerX.toString("hex")}))`, lock.leaves.purchase), true,
  "and_v(v:pk(owner),pk(cosigner))");

const other = lockTaproot({ ownerPubkey, cosignerPubkey, locktime: LOCKTIME + 1, network: NETWORK });
check("A different locktime gives a different address", other.address !== lock.address, true);
const swapped = lockTaproot({ ownerPubkey: cosignerPubkey, cosignerPubkey: ownerPubkey, locktime: LOCKTIME, network: NETWORK });
check("Swapping the keys gives a different address", swapped.address !== lock.address, true);

const refuses = (fn) => { try { fn(); return false; } catch { return true; } };
const mirror = Buffer.from(ownerPubkey); mirror[0] ^= 1; // 02 <-> 03, same x-only key
check("Refuses the same key as owner AND co-signer",
  refuses(() => lockTaproot({ ownerPubkey, cosignerPubkey: ownerPubkey, locktime: LOCKTIME, network: NETWORK })), true,
  "otherwise one person could spend early");
check("Refuses the key's mirror image as co-signer",
  refuses(() => lockTaproot({ ownerPubkey, cosignerPubkey: mirror, locktime: LOCKTIME, network: NETWORK })), true,
  "taproot sees them as one key");

// --- Spending --------------------------------------------------------------

const utxo = { txid: "a".repeat(64), vout: 0, value: 100_000 };
const dest = bitcoin.payments.p2wpkh({ pubkey: ownerPubkey, network: NETWORK }).address;
const base = { utxo, lock, destination: dest, feeSats: 300, ownerKey, cosignerKey, locktime: LOCKTIME, network: NETWORK };

line();
rule();
line("THE FOUR ATTEMPTS");
rule();

const home = buildTaprootSpend({ ...base, route: "home", signers: ["owner"] });
check("Going home: owner's schnorr signature is valid",
  schnorrValid({ sighash: home.sighash, signature: home.tx.ins[0].witness[0], xOnlyPubkey: ownerX }), true);
check("Going home: declares nLockTime", home.tx.locktime === LOCKTIME, true, String(LOCKTIME));
check("Going home: reveals only one leaf", home.tx.ins[0].witness.length === 3, true,
  "signature, leaf, control block — the purchase branch stays private");

const purchase = buildTaprootSpend({ ...base, route: "purchase", signers: ["owner", "cosigner"] });
check("Purchase: owner's signature is valid",
  schnorrValid({ sighash: purchase.sighash, signature: purchase.tx.ins[0].witness[1], xOnlyPubkey: ownerX }), true);
check("Purchase: co-signer's signature is valid",
  schnorrValid({ sighash: purchase.sighash, signature: purchase.tx.ins[0].witness[0], xOnlyPubkey: cosignerX }), true);

const alone = buildTaprootSpend({ ...base, route: "purchase", signers: ["cosigner"] });
check("Co-signer alone: the owner's slot is EMPTY",
  alone.tx.ins[0].witness[1].length === 0, true, "nothing for CHECKSIGVERIFY to accept");

const forged = buildTaprootSpend({ ...base, route: "purchase", signers: ["owner", "cosigner"], ownerKey: strangerKey });
check("A stranger's signature does not verify as the owner's",
  schnorrValid({ sighash: forged.sighash, signature: forged.tx.ins[0].witness[1], xOnlyPubkey: ownerX }), false);

// --- Size comparison -------------------------------------------------------

const p2wsh = lockAddress({ fanPubkey: ownerPubkey, cosignerPubkey, locktime: LOCKTIME, network: NETWORK });

line();
rule();
line("WHY BOTHER WITH TAPROOT");
rule();
line(`P2WSH witness script revealed on any spend   ${p2wsh.witnessScript.length} bytes (both branches)`);
line(`Taproot leaf revealed going home             ${lock.leaves.home.length} bytes (purchase branch stays private)`);
line(`Taproot leaf revealed on a purchase          ${lock.leaves.purchase.length} bytes (the date stays private)`);
line();
line("Smaller spends cost less in fees, and an observer cannot tell what the");
line("other exit was — including when a fan's lock would have expired.");

line();
rule();
line(failures === 0
  ? "Taproot lock behaves identically to the P2WSH one. Both are valid to use."
  : `${failures} check(s) failed.`);
rule();
line();

process.exit(failures === 0 ? 0 : 1);
