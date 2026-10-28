// Library check for the Crowdlock app (28 October 2026).
//
// Run, from this folder:
//   npm install --ignore-scripts      (once; skips native builds nothing here needs)
//   npm run check
//
// Question: can bitcoinjs-lib + @bitcoinerlab/descriptors — the libraries the
// app is planned on — build our exact lock from a standard descriptor, and sign
// and spend both of its exits, without our own script or signing code?
//
// Judged by a node that enforces Bitcoin's rules: bcoin, a full node written in
// JavaScript, run as a private regtest chain in memory, with its clock moved
// forward so a dated lock genuinely expires. Bitcoin Core could not be
// downloaded where this was written; Core already enforced this exact lock
// script on testnet4, and what this checks is the library. The leveldown stub
// exists only because bcoin loads a database module it does not use in memory.
//
// VERDICT: stay on bitcoinjs + descriptors; no switch to BDK.
//
//   * The descriptor wsh(and_v(v:pk(owner),or_i(after(t),pk(cosigner)))) gives
//     byte-for-byte the script in lock/lock.mjs.
//   * Funding and going home are entirely the library's high-level route. Before
//     the date the node refuses it (non-final); after, it accepts.
//   * Co-signer alone: the library refuses to build a spend at all.
//   * FINDING — the purchase exit. Given both keys, the high-level route always
//     takes the cheapest valid branch, which is going home and needs the date,
//     and it has no option to choose otherwise. So a purchase spend cannot be
//     built that way. It does not need to be: the fan only signs a commitment
//     (nLockTime 0, spec/commitment-format.md), which the library's PSBT API
//     signs correctly, and the co-signer completes it. Our only code is picking,
//     from the miniscript library's own list of valid solutions, the one that
//     needs no date, and laying its items out as the witness — a few lines the
//     commitment format already fixes. The node accepted it before the date.
//   * BDK can choose the branch natively and has a maintained React Native
//     package (bdk-rn), but it is a compiled Rust module needing a custom Expo
//     build, and nothing here requires it. Revisit if the hand-placed witness
//     ever grows beyond this one fixed shape.

import { createRequire } from "node:module";
import { Output, ECPair, Psbt, signers, networks } from "@bitcoinerlab/descriptors";

const require = createRequire(import.meta.url);
const bcoin = require("bcoin");

let failures = 0;
const results = [];
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  results.push({ what, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(66)} ${detail}`);
};
const hex = (b) => Buffer.from(b).toString("hex");

// bcoin 1.0's regtest uses the bech32 prefix "rb" rather than "bcrt". Only the
// address text differs; scripts and signatures are identical.
const network = { ...networks.regtest, bech32: "rb" };

// Fixed keys so the run is repeatable.
const key = (b) => ECPair.fromPrivateKey(Buffer.alloc(32, b), { network });
const owner = key(1), cosigner = key(2), miner = key(3);
const OWNER = hex(owner.publicKey), COSIGNER = hex(cosigner.publicKey);

const node = new bcoin.FullNode({
  network: "regtest", memory: true, workers: false, indexTX: true,
  logLevel: "error", listen: false,
});
await node.open();
const rpc = (method, params = []) => node.rpc.execute({ method, params });

const minerOut = new Output({ descriptor: `wpkh(${hex(miner.publicKey)})`, network });
const mine = (n) => rpc("generatetoaddress", [n, minerOut.getAddress()]);
// Transactions go straight into the node's mempool, which runs the full
// consensus and standardness checks and throws on a refusal with its reason.
const broadcast = async (txHex) => {
  try { await node.mempool.addTX(bcoin.TX.fromRaw(Buffer.from(txHex, "hex"))); return { ok: true }; }
  catch (e) { return { ok: false, reason: String(e.reason ?? e.message).split(" (")[0] }; }
};
const mtp = async () => (await rpc("getblockchaininfo")).mediantime;

console.log("-".repeat(80));
console.log("SETTING UP A PRIVATE CHAIN");
console.log("-".repeat(80));

await mine(450); // past segwit's activation on this regtest
const info = await rpc("getblockchaininfo");
const segwit = info.bip9_softforks?.segwit?.status;
check("Segwit is active on the private chain", segwit === "active", `status ${segwit}, height ${info.blocks}`);

// ---------------------------------------------------------------------------
console.log("-".repeat(80));
console.log("THE LOCK, BUILT FROM A DESCRIPTOR");
console.log("-".repeat(80));

// A real date, two days after the chain's current median time.
const T = (await mtp()) + 2 * 86400;
const descriptor = `wsh(and_v(v:pk(${OWNER}),or_i(after(${T}),pk(${COSIGNER}))))`;

const lockOut = new Output({ descriptor, network });
const proven = await import("../lock.mjs");
const provenScript = hex(proven.lockScript({
  fanPubkey: Buffer.from(OWNER, "hex"), cosignerPubkey: Buffer.from(COSIGNER, "hex"), locktime: T,
}));
check("The descriptor's script is byte-for-byte our proven lock script",
  hex(lockOut.getWitnessScript()) === provenScript, `${provenScript.length / 2} bytes`);
check("It is a P2WSH address", lockOut.getAddress().startsWith("rb1q") && lockOut.getAddress().length === 62,
  lockOut.getAddress().slice(0, 16) + "…");

// ---------------------------------------------------------------------------
console.log("-".repeat(80));
console.log("FUNDING TWO LOCKS");
console.log("-".repeat(80));

const h = await rpc("getblockhash", [1]);
const cbTxid = (await rpc("getblock", [h])).tx[0];
const cbHex = await rpc("getrawtransaction", [cbTxid]);

const fund = new Psbt({ network });
const finFund = minerOut.updatePsbtAsInput({ psbt: fund, txHex: cbHex, vout: 0 });
const LOCKED = 1_000_000n;
lockOut.updatePsbtAsOutput({ psbt: fund, value: LOCKED }); // lock A
lockOut.updatePsbtAsOutput({ psbt: fund, value: LOCKED }); // lock B
minerOut.updatePsbtAsOutput({ psbt: fund, value: 5_000_000_000n - 2n * LOCKED - 10_000n });
signers.signECPair({ psbt: fund, ecpair: miner });
finFund({ psbt: fund });
const fundTx = fund.extractTransaction();
const funded = await broadcast(fundTx.toHex());
check("Two locks funded with the library's own transaction", funded.ok, funded.reason ?? fundTx.getId().slice(0, 16) + "…");
await mine(1);

const homeOut = new Output({ descriptor: `wpkh(${OWNER})`, network });
const purchaseOut = new Output({ descriptor: `addr(${minerOut.getAddress()})`, network }); // stands in for a destination

/** Build a spend of lock output `vout` choosing the branch for `signersPubKeys`. */
function spend({ vout, signerKeys, signWith, to }) {
  const out = new Output({ descriptor, network, signersPubKeys: signerKeys.map((k) => k.publicKey) });
  const psbt = new Psbt({ network });
  const fin = out.updatePsbtAsInput({ psbt, txHex: fundTx.toHex(), vout });
  to.updatePsbtAsOutput({ psbt, value: LOCKED - 2_000n });
  for (const k of signWith) signers.signECPair({ psbt, ecpair: k });
  fin({ psbt });
  const tx = psbt.extractTransaction();
  return { tx, locktime: tx.locktime, witnessItems: tx.ins[0].witness.length };
}

// ---------------------------------------------------------------------------
console.log("-".repeat(80));
console.log("THE FOUR BEHAVIOURS");
console.log("-".repeat(80));

// 1. Owner alone, before the date: the library builds it (it cannot know the
//    date has not come), and the node must refuse it.
const early = spend({ vout: 0, signerKeys: [owner], signWith: [owner], to: homeOut });
check("Owner alone: the library sets the lock's date as the transaction's locktime",
  early.locktime === T, `locktime ${early.locktime}`);
const earlyRes = await broadcast(early.tx.toHex());
check("Owner alone, before the date: the node REFUSES it", !earlyRes.ok, earlyRes.reason ?? "ACCEPTED");

// 2. Co-signer alone: there is no such branch, so the library must refuse to
//    build it at all.
let coAlone;
try { spend({ vout: 0, signerKeys: [cosigner], signWith: [cosigner], to: purchaseOut }); coAlone = "built"; }
catch (e) { coAlone = e.message; }
check("Co-signer alone: the library refuses to build a spend", coAlone !== "built", String(coAlone).slice(0, 60));

// 3. Owner plus co-signer, before the date: the purchase exit.
//
// (a) The library's high-level route, given both keys, picks the cheapest
//     valid branch — which is going home, needing the date. Recorded, because
//     it decides how the app has to build a commitment.
const auto = spend({ vout: 0, signerKeys: [owner, cosigner], signWith: [owner, cosigner], to: purchaseOut });
check("FINDING: given both keys, the high-level route picks the going-home branch",
  auto.locktime === T && auto.witnessItems === 3,
  `locktime ${auto.locktime}, ${auto.witnessItems} witness items`);
const autoRes = await broadcast(auto.tx.toHex());
check("…so that spend is refused before the date", !autoRes.ok, autoRes.reason ?? "ACCEPTED");

// (b) The commitment, exactly as spec/commitment-format.md describes it: the
//     fan signs a transaction with nLockTime 0 using the library's PSBT API
//     (which computes the sighash and signs), and the co-signer adds theirs.
//     The only choice made in our code is WHICH valid solution to take: the
//     one the miniscript library lists with no locktime.
const { satisfier } = await import("@bitcoinerlab/miniscript");
const psbt = new Psbt({ network });
psbt.addInput({
  hash: fundTx.getId(), index: 0,
  witnessUtxo: { script: lockOut.getScriptPubKey(), value: LOCKED },
  witnessScript: lockOut.getWitnessScript(),
});
psbt.setLocktime(0);
purchaseOut.updatePsbtAsOutput({ psbt, value: LOCKED - 2_000n });
psbt.signInput(0, owner);       // the fan's commitment
psbt.signInput(0, cosigner);    // the co-signer completing it
const sigs = Object.fromEntries(psbt.data.inputs[0].partialSig.map((p) => [hex(p.pubkey), hex(p.signature)]));
check("Both signatures were made by the library over the nLockTime-0 transaction",
  sigs[OWNER] && sigs[COSIGNER]);

const ms = `and_v(v:pk(@owner),or_i(after(${T}),pk(@cosigner)))`;
const { nonMalleableSats } = satisfier(ms, { knowns: ["<sig(@owner)>", "<sig(@cosigner)>"] });
const purchaseSat = nonMalleableSats.find((x) => x.nLockTime === undefined && x.nSequence === undefined);
check("The miniscript library lists a purchase solution needing no date", !!purchaseSat, purchaseSat?.asm);

// The solution is a list of stack items, e.g. "<sig(@cosigner)> 0 <sig(@owner)>".
// Each becomes a witness item: a signature, or an empty item for 0 (the
// "take the ELSE branch" selector). Then the witness script, as P2WSH requires.
const item = (tok) => tok === "0" ? Buffer.alloc(0)
  : Buffer.from(tok === "<sig(@owner)>" ? sigs[OWNER] : tok === "<sig(@cosigner)>" ? sigs[COSIGNER] : (() => { throw new Error("unexpected " + tok); })(), "hex");
const witness = [...purchaseSat.asm.trim().split(/\s+/).map(item), Buffer.from(lockOut.getWitnessScript())];
const varint = (n) => Buffer.from([n]); // every item here is under 253 bytes
psbt.finalizeInput(0, () => ({
  finalScriptWitness: Buffer.concat([varint(witness.length), ...witness.flatMap((w) => [varint(w.length), w])]),
}));
const both = psbt.extractTransaction();
check("The completed commitment has the purchase witness shape and no locktime",
  both.locktime === 0 && both.ins[0].witness.length === 4,
  `locktime ${both.locktime}, ${both.ins[0].witness.length} witness items`);
const bothRes = await broadcast(both.toHex());
check("Owner + co-signer, before the date: the node ACCEPTS it", bothRes.ok, bothRes.reason ?? both.getId().slice(0, 16) + "…");
await mine(1);

// 4. Move the private chain's clock past the date, then owner alone.
node.network.time.offset = T - Math.floor(Date.now() / 1000) + 3600;
for (let i = 0; i < 12; i++) await mine(1);
const after = await mtp();
check("The chain's median time has passed the lock's date", after > T, `${after - T}s past`);
const late = spend({ vout: 1, signerKeys: [owner], signWith: [owner], to: homeOut });
const lateRes = await broadcast(late.tx.toHex());
check("Owner alone, after the date: the node ACCEPTS it", lateRes.ok, lateRes.reason ?? late.tx.getId().slice(0, 16) + "…");
await mine(1);

// And the purchase spend did not need the co-signer to know anything secret
// beyond its own key — confirm both spends confirmed.
const mempool = await rpc("getrawmempool");
check("Both accepted spends confirmed in blocks", mempool.length === 0, `${mempool.length} left in mempool`);

await node.close();
console.log("-".repeat(80));
console.log(failures === 0
  ? "VERDICT: bitcoinjs + descriptors builds the exact lock and signs both exits correctly."
  : `VERDICT: ${failures} check(s) failed.`);
console.log("-".repeat(80));
process.exit(failures === 0 ? 0 : 1);
