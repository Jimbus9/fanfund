// Can the offline co-signing machine actually do its job?
//
//   cd lock/library-check && npm install --ignore-scripts && npm run cosigner
//
// The co-signing machine is the one piece of this project that holds a key
// belonging to the fund rather than to a fan. Before James sits down in front
// of a Raspberry Pi and disconnects it from the world forever, it is worth
// knowing that the thing he is building can do what it is for.
//
// WHAT IT IS FOR, precisely: a supporter publishes a commitment — their own
// half of a transaction spending their own lock into a purchase, signed by
// them, with the co-signer's slot left empty and nLockTime 0. The machine
// adds the second signature. Thousands of times, unattended, with no network
// and no human approving each one.
//
// THE QUESTION THIS SETTLES. The plan said the machine would run Bitcoin
// Core, because the lock was rewritten in miniscript so that Core could sign
// these in bulk. But Core cannot be downloaded into this workspace, and more
// to the point it may not be needed: `completeCommitment` in commitment.mjs
// already performs exactly this operation, with nothing but bitcoinjs, and it
// is the code whose output the real network accepted on testnet4. So the
// question is not "can we co-sign" — that is proven on a live chain — but
// "does the machine need Bitcoin Core at all, or only Node and this
// repository?"
//
// The judge here is bcoin: a full node written in JavaScript, enforcing
// Bitcoin's consensus and standardness rules, run as a private chain in
// memory. It is not our code and it has no reason to be kind to us.

import { createRequire } from "node:module";
import { Output, ECPair, Psbt, signers, networks } from "@bitcoinerlab/descriptors";

const require = createRequire(import.meta.url);
const bcoin = require("bcoin");

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(64)} ${detail}`);
};
const hex = (b) => Buffer.from(b).toString("hex");
const rule = () => console.log("-".repeat(80));

// bcoin 1.0's regtest uses the bech32 prefix "rb" rather than "bcrt". Only the
// address text differs; scripts and signatures are identical.
const network = { ...networks.regtest, bech32: "rb" };
const key = (b) => ECPair.fromPrivateKey(Buffer.alloc(32, b), { network });
const owner = key(1), cosigner = key(2), miner = key(3), stranger = key(4);

const node = new bcoin.FullNode({
  network: "regtest", memory: true, workers: false, indexTX: true,
  logLevel: "error", listen: false,
});
await node.open();
const rpc = (method, params = []) => node.rpc.execute({ method, params });
const minerOut = new Output({ descriptor: `wpkh(${hex(miner.publicKey)})`, network });
const mine = (n) => rpc("generatetoaddress", [n, minerOut.getAddress()]);
const broadcast = async (txHex) => {
  try { await node.mempool.addTX(bcoin.TX.fromRaw(Buffer.from(txHex, "hex"))); return { ok: true }; }
  catch (e) { return { ok: false, reason: String(e.reason ?? e.message).split(" (")[0] }; }
};
const mtp = async () => (await rpc("getblockchaininfo")).mediantime;

console.log();
rule();
console.log("WHAT THE OFFLINE CO-SIGNING MACHINE HAS TO DO");
rule();
console.log();

await mine(450); // past segwit's activation on this regtest

// The real lock, from the real module — not a reimplementation.
const lock = await import("../lock.mjs");
const commitment = await import("../commitment.mjs");
const NETWORK = { ...lock.networkFor("testnet"), bech32: "rb" };

const T = (await mtp()) + 365 * 86400;          // a date a year out
const ownerPubkey = Buffer.from(owner.publicKey);
const cosignerPubkey = Buffer.from(cosigner.publicKey);
const built = lock.lockAddress({ fanPubkey: ownerPubkey, cosignerPubkey, locktime: T, network: NETWORK });

check("The lock builds from the proven module", Boolean(built.address), built.address.slice(0, 18) + "…");

// --- fund a lock on the private chain ---------------------------------------

const h = await rpc("getblockhash", [1]);
const cbTxid = (await rpc("getblock", [h])).tx[0];
const cbHex = await rpc("getrawtransaction", [cbTxid]);

const LOCKED = 1_000_000n;
const lockOut = new Output({
  descriptor: `wsh(and_v(v:pk(${hex(owner.publicKey)}),or_i(after(${T}),pk(${hex(cosigner.publicKey)}))))`,
  network,
});
check("The descriptor and our module agree on the script byte for byte",
  hex(lockOut.getWitnessScript()) === hex(built.witnessScript));

const fund = new Psbt({ network });
const finFund = minerOut.updatePsbtAsInput({ psbt: fund, txHex: cbHex, vout: 0 });
lockOut.updatePsbtAsOutput({ psbt: fund, value: LOCKED });
minerOut.updatePsbtAsOutput({ psbt: fund, value: 5_000_000_000n - LOCKED - 10_000n });
signers.signECPair({ psbt: fund, ecpair: miner });
finFund({ psbt: fund });
const fundTx = fund.extractTransaction();
const funded = await broadcast(fundTx.toHex());
check("A lock is funded on the private chain", funded.ok, funded.reason ?? "");
await mine(1);

const utxo = { txid: fundTx.getId(), vout: 0, value: Number(LOCKED) };
const DESTINATION = minerOut.getAddress();   // stands in for an attested destination

console.log();
rule();
console.log("THE SUPPORTER'S HALF — built on their own device, not on the Pi");
rule();
console.log();

const FEE = 500;
const COMMIT = Number(LOCKED) - FEE;   // whole coin, so no remainder lock is involved
const half = commitment.buildCommitment({
  utxo, witnessScript: built.witnessScript, destination: DESTINATION,
  commitSats: COMMIT, feeSats: FEE, ownerKey: owner, network: NETWORK,
});

const record = {
  proposal: "0".repeat(64),
  lock: {
    address: built.address,
    owner_pubkey: hex(owner.publicKey),
    cosigner_pubkey: hex(cosigner.publicKey),
    locktime: T,
  },
  tx: half.hex,
};

check("The supporter's half declares no locktime", half.tx.locktime === 0,
  "which is what makes the going-home branch unusable, so there is no branch to choose");

const unsigned = await broadcast(half.hex);
check("…and is REFUSED by the network on its own", !unsigned.ok, unsigned.reason ?? "it was ACCEPTED");

console.log();
rule();
console.log("THE MACHINE'S HALF — the whole of what the Pi does");
rule();
console.log();

// Everything from here uses only the co-signer's private key and the published
// record. No network, no chain, no Bitcoin Core.
const completed = commitment.completeCommitment({
  record, cosignerKey: cosigner, utxoValue: utxo.value, network: NETWORK,
});

const accepted = await broadcast(completed.hex);
check("Completed by the co-signer, the network ACCEPTS it", accepted.ok, accepted.reason ?? completed.txid.slice(0, 18) + "…");

await mine(1);
const confirmed = await rpc("getrawtransaction", [completed.txid, true]);
check("…and it confirms in a block", Boolean(confirmed?.blockhash), `height ${(await rpc("getblockchaininfo")).blocks}`);

// --- what the machine must NOT be able to do --------------------------------

console.log();
rule();
console.log("WHAT THE MACHINE CANNOT DO, WHICH MATTERS MORE");
rule();
console.log();

// A second lock to attack.
const fund2 = new Psbt({ network });
const h2 = await rpc("getblockhash", [2]);
const cb2 = await rpc("getrawtransaction", [(await rpc("getblock", [h2])).tx[0]]);
const fin2 = minerOut.updatePsbtAsInput({ psbt: fund2, txHex: cb2, vout: 0 });
lockOut.updatePsbtAsOutput({ psbt: fund2, value: LOCKED });
minerOut.updatePsbtAsOutput({ psbt: fund2, value: 5_000_000_000n - LOCKED - 10_000n });
signers.signECPair({ psbt: fund2, ecpair: miner });
fin2({ psbt: fund2 });
const fundTx2 = fund2.extractTransaction();
await broadcast(fundTx2.toHex());
await mine(1);
const utxo2 = { txid: fundTx2.getId(), vout: 0, value: Number(LOCKED) };

// The co-signer, alone, tries to take the coins. This is the attack the whole
// design exists to make impossible.
const theft = lock.buildSpend({
  utxo: utxo2, witnessScript: built.witnessScript,
  destination: minerOut.getAddress(), feeSats: 500, route: "purchase",
  fanKey: owner, cosignerKey: cosigner, signers: ["cosigner"],
  locktime: T, network: NETWORK,
});
const stolen = await broadcast(theft.hex);
check("The co-signer alone cannot move a coin", !stolen.ok, stolen.reason ?? "IT WAS ACCEPTED — STOP");

// The co-signer cannot redirect a supporter's money either. Here the machine
// behaves as badly as it can: it takes a real commitment, rewrites output 0 to
// pay somebody else, and co-signs the result. The owner's signature covers the
// outputs, so it no longer matches — and the machine cannot replace it, because
// it does not have the owner's key. This is the property the whole design rests
// on, so it is worth watching a node refuse it rather than taking it on faith.
const honest = commitment.buildCommitment({
  utxo: utxo2, witnessScript: built.witnessScript, destination: DESTINATION,
  commitSats: COMMIT, feeSats: FEE, ownerKey: owner, network: NETWORK,
});
const honestRecord = { ...record, tx: honest.hex };

const thief = new Output({ descriptor: `wpkh(${hex(stranger.publicKey)})`, network }).getAddress();
const bitcoin = (await import("bitcoinjs-lib")).default ?? (await import("bitcoinjs-lib"));
const rewritten = bitcoin.Transaction.fromHex(honest.hex);
rewritten.outs[0].script = bitcoin.address.toOutputScript(thief, NETWORK);

const redirected = commitment.completeCommitment({
  record: { ...honestRecord, tx: rewritten.toHex() },
  cosignerKey: cosigner, utxoValue: utxo2.value, network: NETWORK,
});
const stolenByRedirect = await broadcast(redirected.hex);
check("The co-signer cannot send the money somewhere else", !stolenByRedirect.ok,
  stolenByRedirect.reason ?? "IT WAS ACCEPTED — STOP");

// And the honest version of that same commitment still works, so the refusal
// above is the tampering being caught, not something else being broken.
const honestDone = commitment.completeCommitment({
  record: honestRecord, cosignerKey: cosigner, utxoValue: utxo2.value, network: NETWORK,
});
const honestAccepted = await broadcast(honestDone.hex);
check("…while the untampered one from the same lock is accepted", honestAccepted.ok,
  honestAccepted.reason ?? "so the refusal above was the tampering, not a broken fixture");

console.log();
rule();
console.log("BULK: THOUSANDS, UNATTENDED");
rule();
console.log();

const N = 2000;
const records = [];
for (let i = 0; i < N; i++) {
  records.push({
    ...record,
    tx: commitment.buildCommitment({
      utxo: { txid: hex(Buffer.alloc(32, (i % 250) + 1)), vout: i % 4, value: utxo.value },
      witnessScript: built.witnessScript, destination: DESTINATION,
      commitSats: COMMIT, feeSats: FEE, ownerKey: owner, network: NETWORK,
    }).hex,
  });
}

const started = Date.now();
for (const r of records) {
  commitment.completeCommitment({ record: r, cosignerKey: cosigner, utxoValue: utxo.value, network: NETWORK });
}
const took = Date.now() - started;
const perSecond = Math.round(N / (took / 1000));

check(`${N} commitments co-signed in ${(took / 1000).toFixed(1)}s`, true,
  `about ${perSecond.toLocaleString()} a second`);
check("100,000 commitments would take", true,
  `about ${Math.round(100_000 / perSecond)} seconds on this machine — a Pi is slower, but not hours`);

console.log();
rule();
console.log(failures === 0
  ? "The machine needs Node and this repository. It does not need Bitcoin Core."
  : `${failures} check(s) failed.`);
rule();
console.log();

await node.close();
process.exit(failures === 0 ? 0 : 1);
