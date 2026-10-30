// The app's key module, tested on a private chain.
//
// Run, from this folder:
//   npm install --ignore-scripts      (once)
//   npm test
//
// Milestone 3 adds locking: a lock is made, counted as locked, refused on the
// way home before its date, and taken home after it.
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
  signStatement, lockFor, lockDate, buildLock, lockState, takeHome,
} from "../src/wallet/core.mjs";
import { lockAddress } from "../../js/lockrecord.mjs";
import { verifyMembership } from "../../js/verify.mjs";
import bitcoinMessage from "../../lock/node_modules/bitcoinjs-message/index.js";

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

// Wallets made elsewhere — a Ledger makes 24 words — must restore too.
const { generateMnemonic } = await import("../node_modules/@scure/bip39/index.js");
const { wordlist } = await import("../node_modules/@scure/bip39/wordlists/english.js");
const twentyFour = generateMnemonic(wordlist, 256);
check("24 backup words from another wallet are accepted", wordsAreValid(twentyFour) && twentyFour.split(" ").length === 24);
check("…and open a wallet", accountFromWords(twentyFour, "mainnet").address.startsWith("bc1q"));

// The published standard test vector (BIP84): these words must give this
// address in every wallet that follows the standard — including ours, or a fan
// could not take their words to Sparrow and find their money.
const vector = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
check("The standard BIP84 test words give the standard first address",
  accountFromWords(vector, "mainnet").address === "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  accountFromWords(vector, "mainnet").address);

// ---------------------------------------------------------------------------
rule("SIGNING A DECLARATION (milestone 2)");

// A signature the register cannot verify would turn a fan away at the door,
// so each one is checked by the register's own verifier and by bitcoinjs-
// message, the library BlueWallet uses — two independent judges.
const statement = "I agree to the Test Declaration v1 (sha256:29f943a5bf2c110200cb33d0299b00960b19f10f1942d14699aec154b39316df) and join as a member.";
for (const net of ["testnet4", "mainnet"]) {
  const acct = accountFromWords(words, net);
  const sig = signStatement(acct, statement);
  const hrp = net === "mainnet" ? "bc" : "tb";
  const ours = verifyMembership({ address: acct.address, signature: sig, message: statement, hrp });
  check(`On ${net}: the register's verifier accepts the app's signature`, ours.valid, ours.reason ?? "");
  let theirs = false;
  try { theirs = bitcoinMessage.verify(statement, acct.address, sig, null, true); } catch (e) { theirs = e.message; }
  check(`On ${net}: bitcoinjs-message accepts it too`, theirs === true, String(theirs));
  check(`On ${net}: it is the same kind of signature Sparrow made for member 1`,
    Buffer.from(sig, "base64")[0] >= 31 && Buffer.from(sig, "base64")[0] <= 34);
}
const acct = accountFromWords(words, "testnet4");
const sig = signStatement(acct, statement);
check("Signing is deterministic (same words, same statement, same signature)", signStatement(acct, statement) === sig);
check("A signature over one statement does not verify for another",
  !verifyMembership({ address: acct.address, signature: sig, message: statement.replace("v1", "v2"), hrp: "tb" }).valid);
const other = accountFromWords(newWords(), "testnet4");
check("Another wallet's signature does not verify for this address",
  !verifyMembership({ address: acct.address, signature: signStatement(other, statement), message: statement, hrp: "tb" }).valid);

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
  async everFunded(address) {
    return (await node.getMetaByAddress([bcoin.Address.fromString(address, "regtest")])).length > 0;
  },
  async medianTime() { return (await rpc("getblockchaininfo")).mediantime; },
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

// ---------------------------------------------------------------------------
rule("MILESTONE 3: LOCK, WATCH IT, TAKE IT HOME");

const saver = accountFromWords(newWords(), net);
const cosigner = accountFromWords(newWords(), net);
const toSaver = await buildSend({ account: miner, chain, to: saver.address, amount: 300_000n, feeRate: 2 });
await chain.broadcast(toSaver.hex);
await rpc("generatetoaddress", [1, miner.address]);

check("A one-year lock unlocks on a plain date, a year or so away",
  lockDate(1, 1800000000) % 86400 === 0 && lockDate(1, 1800000000) - 1800000000 >= 365 * 86400);
check("A test length under a day is not rounded", lockDate(1 / 8766, 1800000000) === 1800000000 + Math.ceil(3600));

await refuses("A lock whose co-signer is the fan's own key",
  async () => lockFor({ account: saver, cosignerPubkey: saver.publicKey, locktime: 1900000000 }), "your own key");
await refuses("A lock whose date is a block height",
  async () => lockFor({ account: saver, cosignerPubkey: cosigner.publicKey, locktime: 800000 }), "must be a date");

const T = (await chain.medianTime()) + 2 * 86400;
const lock = lockFor({ account: saver, cosignerPubkey: cosigner.publicKey, locktime: T });
const registerSays = lockAddress({ ownerPubkey: saver.publicKey, cosignerPubkey: cosigner.publicKey, locktime: T }, "rb");
check("The app's lock address is the one the register rebuilds", lock.address === registerSays, lock.address.slice(0, 18) + "…");

const stateOf = async () => lockState({ chain, lock, medianTime: await chain.medianTime() });
check("Before anything is sent, the lock is empty", (await stateOf()).state === "empty");

await refuses("Locking to terms that do not make the address",
  () => buildLock({ account: saver, chain, lock: { ...lock, locktime: T + 1 }, feeRate: 2 }), "do not make that address");
// Part of it, first: the rest stays waiting for another lock or Crowdlock.
const partLock = lockFor({ account: saver, cosignerPubkey: cosigner.publicKey, locktime: T + 86400 });
const part = await buildLock({ account: saver, chain, lock: partLock, feeRate: 2, amount: 100_000n });
await chain.broadcast(part.hex);
await rpc("generatetoaddress", [1, miner.address]);
const leftAfterPart = (await waitingBalance(chain, saver.address)).confirmed;
check("Locking part of it locks exactly that amount, and the rest stays waiting",
  (await lockState({ chain, lock: partLock, medianTime: await chain.medianTime() })).confirmed === 100_000n
    && leftAfterPart === 300_000n - 100_000n - part.fee, `${leftAfterPart} sats still waiting`);

const locking = await buildLock({ account: saver, chain, lock, feeRate: 2 });
await chain.broadcast(locking.hex);
check("Locking with no amount sends everything still waiting", (await stateOf()).state === "arriving",
  `${locking.sent} sats, fee ${locking.fee}`);
await rpc("generatetoaddress", [1, miner.address]);
let st = await stateOf();
check("Once confirmed it shows as locked", st.state === "locked" && st.confirmed === locking.sent, `${st.confirmed} sats`);
check("…and the waiting balance is empty", (await waitingBalance(chain, saver.address)).total === 0n);

const mt = await chain.medianTime();
await refuses("Taking it home before the date: the app refuses",
  () => takeHome({ account: saver, chain, lock, feeRate: 2, medianTime: mt }), "not passed yet");
const early = await takeHome({ account: saver, chain, lock, feeRate: 2, medianTime: mt, ignoreDate: true });
let earlyRefused;
try { await chain.broadcast(early.hex); earlyRefused = false; } catch (e) { earlyRefused = String(e.reason ?? e.message).split(" (")[0]; }
check("…and so does the network, if forced", earlyRefused !== false, String(earlyRefused));

// Move the private chain's clock past the date, as the library check does.
node.network.time.offset = T - Math.floor(Date.now() / 1000) + 3600;
for (let i = 0; i < 12; i++) await rpc("generatetoaddress", [1, miner.address]);
st = await stateOf();
check("After the date it shows as lapsed, still holding the money", st.state === "lapsed" && st.confirmed === locking.sent);

const home = await takeHome({ account: saver, chain, lock, feeRate: 2, medianTime: await chain.medianTime() });
await chain.broadcast(home.hex);
await rpc("generatetoaddress", [1, miner.address]);
check("The owner alone takes it home, and the network accepts it", (await stateOf()).state === "withdrawn",
  `${home.sent} sats home, fee ${home.fee}`);
check("…back into the waiting balance, every sat accounted for",
  (await waitingBalance(chain, saver.address)).confirmed === home.sent && home.sent + home.fee === locking.sent);

await node.close();
rule();
console.log(failures === 0
  ? "The key module works on a real chain: create, fund, restore, send out, lock, and take a lock home after its date."
  : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
