// Proves Bitcoin itself enforces the lock.
//
// The self-test proves we BUILT the lock right. Only a node can prove the
// network REFUSES what it should refuse, which is what this does, on testnet,
// with coins that are free and worthless.
//
// It uses two locks so nothing depends on waiting around:
//
//   LOCK A   date far in the future  -> proves the fan cannot get out early,
//                                       proves the co-signer cannot act alone,
//                                       proves fan + co-signer can purchase.
//   LOCK B   date already passed     -> proves the fan alone can go home once
//                                       the date has been reached.
//
// Run:  node run-testnet.mjs
//
// It is resumable. Run it, fund the two addresses it prints, run it again.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as bitcoin from "bitcoinjs-lib";
import {
  ECPair, lockAddress, buildSpend, describeLocktime, networkFor,
} from "./lock.mjs";

const API = process.env.FANFUND_API || "https://mempool.space/testnet4/api";
const NETWORK = networkFor("testnet");
// fileURLToPath, not .pathname: on Windows .pathname yields "/C:/Users/..."
// and the leading slash makes Node resolve it against the current drive,
// producing "C:\\C:\\Users\\...". Linux never shows the bug.
const STATE = fileURLToPath(new URL("./lock-state.json", import.meta.url));
const FEE = 400;        // sats; testnet is cheap
const MIN_UTXO = 2000;  // sats; anything smaller is not worth spending

const line = (s = "") => console.log(s);
const rule = (c = "-") => line(c.repeat(74));

async function api(path, opts) {
  try {
    const res = await fetch(`${API}${path}`, opts);
    const text = (await res.text()).trim();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: `network error: ${e?.cause?.code || e.message}`, offline: true };
  }
}

async function tipHeight() {
  const r = await api("/blocks/tip/height");
  if (r.offline) {
    line();
    rule("=");
    line("CANNOT REACH THE NETWORK");
    rule("=");
    line(`Tried: ${API}`);
    line(`Got:   ${r.text}`);
    line();
    line("This needs internet access to a Bitcoin testnet API. Check you are online,");
    line("or point it somewhere else:");
    line();
    line("  FANFUND_API=https://blockstream.info/testnet/api node run-testnet.mjs");
    line();
    process.exit(2);
  }
  if (!r.ok) {
    line(`\nThe API answered but refused: ${r.status} ${r.text}`);
    process.exit(2);
  }
  const h = parseInt(r.text, 10);
  if (!Number.isInteger(h)) {
    line(`\nUnexpected answer from ${API}/blocks/tip/height: ${r.text.slice(0, 120)}`);
    process.exit(2);
  }
  return h;
}

async function utxos(address) {
  const r = await api(`/address/${address}/utxo`);
  if (!r.ok) return [];
  try {
    return JSON.parse(r.text)
      .filter((u) => u.value >= MIN_UTXO)
      .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
  } catch { return []; }
}

async function broadcast(hex) {
  const r = await api("/tx", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: hex,
  });
  return r;
}

// --- Keys ------------------------------------------------------------------
// Saved so the run survives you closing the terminal. Testnet only. If this
// file leaks, nothing of value is lost.

let state;
if (existsSync(STATE)) {
  state = JSON.parse(readFileSync(STATE, "utf8"));
  line(`\nUsing the keys saved in lock-state.json`);
} else {
  const fan = ECPair.makeRandom({ network: NETWORK });
  const cos = ECPair.makeRandom({ network: NETWORK });
  state = {
    fan: Buffer.from(fan.privateKey).toString("hex"),
    cosigner: Buffer.from(cos.privateKey).toString("hex"),
    note: "TESTNET KEYS ONLY. Worthless. Do not reuse for anything real.",
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  line(`\nGenerated fresh testnet keys and saved them to lock-state.json`);
}

const fanKey = ECPair.fromPrivateKey(Buffer.from(state.fan, "hex"), { network: NETWORK });
const cosignerKey = ECPair.fromPrivateKey(Buffer.from(state.cosigner, "hex"), { network: NETWORK });
const fanPubkey = Buffer.from(fanKey.publicKey);
const cosignerPubkey = Buffer.from(cosignerKey.publicKey);

// Where a spent coin goes: an ordinary address the fan controls.
const payout = bitcoin.payments.p2wpkh({ pubkey: fanPubkey, network: NETWORK }).address;

const height = await tipHeight();

// The two locktimes are fixed on the first run and saved, NOT recomputed from
// the current tip each time. A lock's address is derived from its locktime, so
// recomputing them would hand you two different addresses every time a block
// arrived — and the coins you had just sent to the old pair would be stranded
// while this sat there reporting "waiting".
if (state.lockA === undefined || state.lockB === undefined) {
  state.lockA = height + 50_000;          // years away at ten minutes a block
  state.lockB = Math.max(height - 10, 1); // already passed
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  line(`Fixed the two lock dates at block ${height} and saved them.`);
}
const LOCK_A = state.lockA;
const LOCK_B = state.lockB;

if (LOCK_B >= height) {
  line(`\nLock B's date (block ${LOCK_B}) has not been reached yet — the chain is`);
  line(`at ${height}. Wait for it to pass, then run this again.`);
  process.exit(0);
}

const A = lockAddress({ fanPubkey, cosignerPubkey, locktime: LOCK_A, network: NETWORK });
const B = lockAddress({ fanPubkey, cosignerPubkey, locktime: LOCK_B, network: NETWORK });

line();
rule("=");
line("THE TWO LOCKS");
rule("=");
line(`network         testnet4 via ${API}`);
line(`chain tip       block ${height}`);
line();
line(`LOCK A  still locked — ${describeLocktime(LOCK_A)}`);
line(`        ${A.address}`);
line();
line(`LOCK B  date passed  — ${describeLocktime(LOCK_B)}`);
line(`        ${B.address}`);
line();
line(`coins spent in this test end up at ${payout}`);

const [au, bu] = [await utxos(A.address), await utxos(B.address)];

if (au.length === 0 || bu.length === 0) {
  line();
  rule("=");
  line("FUND THEM, THEN RUN THIS AGAIN");
  rule("=");
  line("Search for a 'testnet4 faucet' and send a small amount to each address");
  line(`above — anything over ${MIN_UTXO} sats. They are test coins. They are free`);
  line("and they are not money.");
  line();
  line(`  LOCK A  ${A.address}  ${au.length ? "FUNDED" : "waiting"}`);
  line(`  LOCK B  ${B.address}  ${bu.length ? "FUNDED" : "waiting"}`);
  line();
  line("Then: node run-testnet.mjs");
  line();
  process.exit(0);
}

// --- The four attempts -----------------------------------------------------

const results = [];

async function attempt({ name, expect, spend, why }) {
  const r = await broadcast(spend.hex);
  const accepted = r.ok;
  const pass = expect === "accept" ? accepted : !accepted;
  results.push({ name, expect, accepted, pass, detail: accepted ? spend.txid : r.text, why });

  line();
  line(`${pass ? "PASS" : "FAIL"}  ${name}`);
  line(`      expected the network to ${expect === "accept" ? "ACCEPT" : "REFUSE"} it, and it ${accepted ? "ACCEPTED" : "REFUSED"} it`);
  line(`      ${accepted ? "txid: " + spend.txid : "node said: " + r.text.slice(0, 180)}`);
  if (why) line(`      ${why}`);
}

line();
rule("=");
line("THE FOUR ATTEMPTS");
rule("=");

const utxoA = au[0];
const utxoB = bu[0];
const baseA = { utxo: utxoA, witnessScript: A.witnessScript, destination: payout, feeSats: FEE, fanKey, cosignerKey, locktime: LOCK_A, network: NETWORK };
const baseB = { utxo: utxoB, witnessScript: B.witnessScript, destination: payout, feeSats: FEE, fanKey, cosignerKey, locktime: LOCK_B, network: NETWORK };

// 1. The fan tries to get out early. This is the promise the whole design
//    rests on: committed money cannot be pulled back out before its date.
await attempt({
  name: "Fan alone tries to go home BEFORE the date",
  expect: "refuse",
  spend: buildSpend({ ...baseA, route: "home", signers: ["fan"] }),
  why: "if this were accepted, a lock would mean nothing",
});

// 2. The co-signer tries to move it alone. This is the promise that nobody
//    holds anybody else's money.
await attempt({
  name: "Co-signer alone tries to move the coin",
  expect: "refuse",
  spend: buildSpend({ ...baseA, route: "purchase", signers: ["cosigner"] }),
  why: "if this were accepted, the co-signer would be a custodian",
});

// 3. Fan + co-signer send it into a purchase. Must work at any time.
await attempt({
  name: "Fan + co-signer move it into a purchase",
  expect: "accept",
  spend: buildSpend({ ...baseA, route: "purchase", signers: ["fan", "cosigner"] }),
  why: "this is how locked money reaches a deal before its date",
});

// 4. Fan alone goes home, after the date. Must work, with nobody's help.
await attempt({
  name: "Fan alone goes home AFTER the date",
  expect: "accept",
  spend: buildSpend({ ...baseB, route: "home", signers: ["fan"] }),
  why: "nobody can stop this and nobody needs to be asked",
});

// --- Verdict ---------------------------------------------------------------

line();
rule("=");
line("VERDICT");
rule("=");
for (const r of results) {
  line(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
}
line();
const failed = results.filter((r) => !r.pass).length;
if (failed === 0) {
  line("The lock behaves exactly as the declaration describes it.");
  line("Committed money cannot be withdrawn early. It cannot be taken by anyone.");
  line("It can reach a purchase with the owner's consent, and it comes home on");
  line("its date whether anyone cooperates or not.");
} else {
  line(`${failed} of ${results.length} attempts did not behave as specified.`);
  line("Do not build anything else on this lock until that is understood.");
}
rule("=");
line();

process.exit(failed === 0 ? 0 : 1);
