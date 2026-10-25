// What can be proven without a Bitcoin node.
//
// This checks the lock is BUILT correctly: the script says what we think it
// says, the address derives from it, every signature is valid over the right
// sighash, and the attempts that are supposed to be missing a signature really
// are missing it.
//
// It does NOT prove the network enforces the lock. No amount of local testing
// can prove that — only a node can refuse a transaction. That is what
// run-testnet.mjs is for, and the difference matters: this file proves our
// construction, the testnet run proves Bitcoin's enforcement.
//
// Run:  node selftest.mjs

import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import {
  ECPair, lockScript, lockAddress, buildSpend, describeLocktime, networkFor,
  LOCKTIME_THRESHOLD,
} from "./lock.mjs";

const NETWORK = networkFor("testnet");
const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(74));

let failures = 0;
function check(name, got, want, detail = "") {
  const ok = got === want;
  if (!ok) failures++;
  line(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`);
}

// Fixed keys so this file produces the same output every run and a reviewer
// can diff it. Test keys, worthless, never used for anything real.
const fanKey = ECPair.fromPrivateKey(Buffer.from("11".repeat(32), "hex"), { network: NETWORK });
const cosignerKey = ECPair.fromPrivateKey(Buffer.from("22".repeat(32), "hex"), { network: NETWORK });
const strangerKey = ECPair.fromPrivateKey(Buffer.from("33".repeat(32), "hex"), { network: NETWORK });

const fanPubkey = Buffer.from(fanKey.publicKey);
const cosignerPubkey = Buffer.from(cosignerKey.publicKey);

const LOCKTIME = 2_900_000; // a block height, well in the future on testnet
const { address, witnessScript } = lockAddress({ fanPubkey, cosignerPubkey, locktime: LOCKTIME, network: NETWORK });

line();
rule();
line("THE LOCK");
rule();
line(`locktime        ${describeLocktime(LOCKTIME)}`);
line(`address         ${address}`);
line(`witness script  ${witnessScript.length} bytes`);
line();
line("decompiled:");
for (const chunk of bitcoin.script.decompile(witnessScript)) {
  if (Buffer.isBuffer(chunk)) {
    const named = chunk.equals(fanPubkey) ? "  <- the fan's key"
      : chunk.equals(cosignerPubkey) ? "  <- the co-signer's key" : "";
    line(`  ${chunk.toString("hex")}${named}`);
  } else {
    line(`  ${bitcoin.script.toASM([chunk])}`);
  }
}

// --- Construction ----------------------------------------------------------

line();
rule();
line("CONSTRUCTION");
rule();

const asm = bitcoin.script.toASM(witnessScript);

check("Script contains CHECKLOCKTIMEVERIFY", asm.includes("OP_CHECKLOCKTIMEVERIFY"), true);
check("Script has two branches (IF / ELSE / ENDIF)",
  asm.includes("OP_IF") && asm.includes("OP_ELSE") && asm.includes("OP_ENDIF"), true);
check("Purchase branch requires BOTH keys (CHECKSIGVERIFY)",
  asm.includes("OP_CHECKSIGVERIFY"), true,
  "this is the line that stops the co-signer acting alone");
check("Address is P2WSH (62 chars, tb1q on testnet)",
  address.length === 62 && address.startsWith("tb1q"), true, address.slice(0, 12) + "…");
check("Address derives from this exact script",
  bitcoin.payments.p2wsh({ redeem: { output: witnessScript, network: NETWORK }, network: NETWORK }).address === address,
  true);

// Changing anything must change the address, or the lock is not committing to
// what we think it commits to.
const other = lockAddress({
  fanPubkey, cosignerPubkey, locktime: LOCKTIME + 1, network: NETWORK,
}).address;
check("A different locktime gives a different address", other !== address, true);
const swapped = lockAddress({
  fanPubkey: cosignerPubkey, cosignerPubkey: fanPubkey, locktime: LOCKTIME, network: NETWORK,
}).address;
check("Swapping the two keys gives a different address", swapped !== address, true,
  "the roles are not interchangeable");

// One key in both roles would let one person supply both purchase signatures
// and move the coin before its date. Building such a lock must be refused.
const refuses = (fn) => { try { fn(); return false; } catch { return true; } };
const mirror = Buffer.from(fanPubkey); mirror[0] ^= 1; // 02 <-> 03, same x
check("Refuses the same key as fan AND co-signer",
  refuses(() => lockAddress({ fanPubkey, cosignerPubkey: fanPubkey, locktime: LOCKTIME, network: NETWORK })), true,
  "otherwise one person could spend early");
check("Refuses the key's mirror image as co-signer",
  refuses(() => lockAddress({ fanPubkey, cosignerPubkey: mirror, locktime: LOCKTIME, network: NETWORK })), true);

// --- The four attempts -----------------------------------------------------

const utxo = { txid: "a".repeat(64), vout: 0, value: 100_000 };
const DEST = bitcoin.payments.p2wpkh({ pubkey: fanPubkey, network: NETWORK }).address;
const common = { utxo, witnessScript, destination: DEST, feeSats: 300, fanKey, cosignerKey, locktime: LOCKTIME, network: NETWORK };

function witnessOf(spend) { return spend.tx.ins[0].witness; }
function emptySlots(spend) { return witnessOf(spend).filter((w) => w.length === 0).length; }

function sigValid(spend, index, pubkey) {
  const sig = witnessOf(spend)[index];
  if (!sig || sig.length === 0) return false;
  const decoded = bitcoin.script.signature.decode(sig);
  return ecc.verify(spend.sighash, pubkey, decoded.signature);
}

line();
rule();
line("THE FOUR ATTEMPTS");
rule();

// 1. Fan alone, going home. Valid signature, and it declares the locktime.
const home = buildSpend({ ...common, route: "home", signers: ["fan"] });
check("Going home: fan's signature is valid", sigValid(home, 0, fanPubkey), true);
check("Going home: declares nLockTime", home.tx.locktime === LOCKTIME, true, String(home.tx.locktime));
check("Going home: no co-signer involved at all", witnessOf(home).length === 3, true,
  "signature, branch selector, script");

// 2. Fan + co-signer, purchase route.
const purchase = buildSpend({ ...common, route: "purchase", signers: ["fan", "cosigner"] });
check("Purchase: fan's signature is valid", sigValid(purchase, 1, fanPubkey), true);
check("Purchase: co-signer's signature is valid", sigValid(purchase, 0, cosignerPubkey), true);
check("Purchase: needs no locktime", purchase.tx.locktime === 0, true);
check("Purchase: both signatures present", emptySlots(purchase) === 1, true, "only the branch selector is empty");

// 3. Co-signer alone down the purchase route — the one that must never work.
const alone = buildSpend({ ...common, route: "purchase", signers: ["cosigner"] });
check("Co-signer alone: the fan's slot is EMPTY", witnessOf(alone)[1].length === 0, true,
  "nothing for CHECKSIGVERIFY to accept");
check("Co-signer alone: cannot be made valid locally", sigValid(alone, 1, fanPubkey), false);

// 4. A stranger's signature in the fan's place.
const forged = buildSpend({
  ...common, route: "purchase", signers: ["fan", "cosigner"], fanKey: strangerKey,
});
check("Stranger's signature does not verify as the fan's",
  sigValid(forged, 1, fanPubkey), false,
  "a valid signature from the wrong key is still the wrong key");

// --- The thing this file cannot do -----------------------------------------

line();
rule();
line("WHAT THIS CANNOT PROVE");
rule();
line("The going-home transaction above is correctly built and correctly signed.");
line("Whether the network REFUSES it before the locktime is not something any");
line("local check can establish — only a node can reject a transaction.");
line();
line(`Early spend attempt, fully signed and ready to be refused:`);
line(`  txid     ${home.txid}`);
line(`  locktime ${home.tx.locktime}  (a node must reject this until the chain reaches it)`);
line();
line("Run run-testnet.mjs on a machine with internet access to prove enforcement.");

line();
rule();
line(failures === 0
  ? "All construction checks passed. The lock is built as specified."
  : `${failures} check(s) failed.`);
rule();
line();

process.exit(failures === 0 ? 0 : 1);
