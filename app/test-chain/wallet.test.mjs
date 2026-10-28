// The app's key module, tested on a private chain.
//
// Run, from this folder:
//   npm install --ignore-scripts      (once)
//   npm test
//
// Milestone 1 of the app plan is done when a wallet can be created, funded,
// deleted, restored from its 12 words with the same address and balance, and
// can send its waiting money out. Everything here does that against a real
// rule-enforcing node — bcoin on an in-memory regtest chain — using exactly
// the code the phone runs (../src/wallet/core.mjs). Nothing is mocked except
// the block explorer, which is replaced by the node itself.

import { createRequire } from "node:module";
import {
  newWords, wordsAreValid, tidyWords, accountFromWords, waitingBalance, buildSend, NETWORKS, DUST_SATS,
} from "../src/wallet/core.mjs";

const require = createRequire(import.meta.url);
const bcoin = require("bcoin");

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(66)} ${detail}`);
};
const rule = (t) => { console.log("-".repeat(80)); if (t) { console.log(t); console.log("-".repeat(80)); } };
const refuses = async (what, fn, expect) => {
  try { await fn(); check(what, false, "ACCEPTED IT"); }
  catch (e) { check(what, String(e.message).includes(expect), e.message.slice(0, 46)); }
};

// ---------------------------------------------------------------------------
rule("BACKUP WORDS");

const words = newWords();
check("New words are twelve words", words.split(" ").length === 12);
check("…and pass their own checksum", wordsAreValid(words));
check("Two sets of new words are never the same", newWords() !== words);
// Twelve "abandon"s fail the checksum — a fixed example, because changing one
// word of a random set still passes about one time in sixteen.
const broken = Array(12).fill("abandon").join(" ");
check("Words with one changed fail the checksum", !wordsAreValid(broken));
check("Messy typing is tidied (capitals, extra spaces)", tidyWords(`  ${words.toUpperCase().replace(/ /g, "   ")} `) === words);

// The published standard test vector (BIP84): these words must give this
// address in every wallet that follows the standard — including ours, or a fan
// could not take their words to Sparrow and find their money.
const vector = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
check("The standard BIP84 test words give the standard first address",
  accountFromWords(vector, "mainnet").address === "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  accountFromWords(vector, "mainnet").address);

// ---------------------------------------------------------------------------
rule("A PRIVATE CHAIN");

// bcoin 1.0's regtest uses the address prefix "rb" instead of "bcrt"; only the
// text of the address differs.
const net = { network: { ...NETWORKS.regtest.network, bech32: "rb" }, coin: 1 };

const node = new bcoin.FullNode({
  network: "regtest", memory: true, workers: false, indexTX: true, indexAddress: true,
  logLevel: "error", listen: false,
});
await node.open();
const rpc = (method, params = []) => node.rpc.execute({ method, params });

// The chain object the key module talks to — the same shape as the phone's
// block-explorer connector, answered by the node.
const chain = {
  async utxos(address) {
    // Newly mined coins cannot be spent for 100 blocks; like a real explorer's
    // wallet view, those are left out.
    const tip = node.chain.height;
    const coins = await node.getCoinsByAddress([bcoin.Address.fromString(address, "regtest")]);
    return coins
      .filter((c) => !(c.coinbase && c.height !== -1 && tip - c.height < 100))
      .map((c) => ({ txid: c.txid(), vout: c.index, value: c.value, confirmed: c.height !== -1 }));
  },
  async txHex(txid) { return (await node.getMeta(bcoin.util.revHex(txid))).tx.toRaw().toString("hex"); },
  async broadcast(hex) { await node.mempool.addTX(bcoin.TX.fromRaw(Buffer.from(hex, "hex"))); },
};

const minerWords = newWords();
const miner = accountFromWords(minerWords, net);
// Past segwit's activation first, paid to an address nobody uses, then 101
// blocks to the miner so exactly one of its mined coins has matured.
const nobody = accountFromWords(newWords(), net);
await rpc("generatetoaddress", [440, nobody.address]);
await rpc("generatetoaddress", [101, miner.address]);
check("The chain is up, with segwit active", (await rpc("getblockchaininfo")).bip9_softforks.segwit.status === "active");

// ---------------------------------------------------------------------------
rule("MILESTONE 1: CREATE, FUND, RESTORE, SEND OUT");

const fan = accountFromWords(words, net);
check("A new wallet has an address", fan.address.startsWith("rb1q"), fan.address.slice(0, 18) + "…");

const pay = await buildSend({ account: miner, chain, to: fan.address, amount: 2_500_000n, feeRate: 2 });
await chain.broadcast(pay.hex);
let bal = await waitingBalance(chain, fan.address);
check("Money sent to it shows as arriving before it confirms",
  bal.arriving === 2_500_000n && bal.confirmed === 0n, `${bal.arriving} arriving`);

await refuses("Nothing can be sent out until it confirms",
  () => buildSend({ account: fan, chain, to: miner.address, amount: 10_000n, feeRate: 2 }), "no confirmed money");

await rpc("generatetoaddress", [1, miner.address]);
bal = await waitingBalance(chain, fan.address);
check("Once mined it shows as confirmed", bal.confirmed === 2_500_000n && bal.arriving === 0n, `${bal.confirmed} sats`);

// "Delete the app and restore from the words": nothing is carried over except
// the twelve words, typed back in messily.
const restored = accountFromWords(`  ${words.toUpperCase()} `, net);
const restoredBal = await waitingBalance(chain, restored.address);
check("Restored from the words: the same address", restored.address === fan.address);
check("Restored from the words: the same balance", restoredBal.confirmed === bal.confirmed, `${restoredBal.confirmed} sats`);

const out = await buildSend({ account: restored, chain, to: miner.address, amount: 1_000_000n, feeRate: 3 });
await chain.broadcast(out.hex);
await rpc("generatetoaddress", [1, miner.address]);
bal = await waitingBalance(chain, fan.address);
check("Sending money out works, signed by the restored wallet", bal.confirmed === out.change,
  `sent ${out.sent}, fee ${out.fee}, change ${out.change}`);
check("…and the sums add up exactly", out.sent + out.fee + out.change === 2_500_000n);

const all = await buildSend({ account: restored, chain, to: miner.address, amount: "all", feeRate: 3 });
await chain.broadcast(all.hex);
await rpc("generatetoaddress", [1, miner.address]);
bal = await waitingBalance(chain, fan.address);
check("Sending everything empties the waiting balance, no change left", bal.total === 0n && all.change === 0n,
  `sent ${all.sent}, fee ${all.fee}`);

// ---------------------------------------------------------------------------
rule("WHAT THE KEY MODULE REFUSES");

await rpc("generatetoaddress", [0, miner.address]);
const top = await buildSend({ account: miner, chain, to: fan.address, amount: 50_000n, feeRate: 2 });
await chain.broadcast(top.hex);
await rpc("generatetoaddress", [1, miner.address]);

await refuses("An amount below the dust limit",
  () => buildSend({ account: fan, chain, to: miner.address, amount: DUST_SATS - 1n, feeRate: 2 }), "dust");
await refuses("A fee more than a tenth of what is sent",
  () => buildSend({ account: fan, chain, to: miner.address, amount: 2_000n, feeRate: 50 }), "more than a tenth");
await refuses("More than the balance",
  () => buildSend({ account: fan, chain, to: miner.address, amount: 60_000n, feeRate: 2 }), "not enough");
await refuses("An address on another network",
  () => buildSend({ account: fan, chain, to: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", amount: 10_000n, feeRate: 2 }),
  "not an address on this network");
await refuses("Something that is not an address at all",
  () => buildSend({ account: fan, chain, to: "send it to my mate", amount: 10_000n, feeRate: 2 }), "not an address");
await refuses("A silly fee rate",
  () => buildSend({ account: fan, chain, to: miner.address, amount: 10_000n, feeRate: 5000 }), "fee rate");
await refuses("Words that are not valid backup words",
  () => accountFromWords(broken, net), "not valid backup words");

await node.close();
rule();
console.log(failures === 0
  ? "Milestone 1's key module works on a real chain: create, fund, restore, send out, and the refusals hold."
  : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
