// The app's Crowdlock loader, tested against the real files in this repository.
//
// Run: node crowdlocks.test.mjs   (needs no chain)
//
// Milestone 2 is done when a tampered Crowdlock is refused and a test
// registration reaches a test register. This is the first half: the loader
// the phone runs, given the real Kop Fund and test Crowdlock files, and then
// given doctored copies of them — which it must turn away, with the reason.

import { readFileSync } from "node:fs";
import { esploraChain } from "../src/wallet/esplora.mjs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { loadCrowdlock, baseFor, membershipOf, committedTotal, submitJoin, STARTING_LIST, shortBtc, poundsPerBtc, COUNTING_RULE_URL, submitLock, locksOnRegister, openLinkFor, fileUrlFromOpenLink, shareLinkFor, rankFound, matchesSearch } from "../src/crowdlocks.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = "https://jimbus9.github.io/fanfund/";

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(66)} ${detail}`);
};

/** A fetch that serves this repository as if it were the live site, with optional tampering. */
const siteFetch = (tamper = {}) => async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith(SITE)) return new Response("not found", { status: 404 });
  const path = u.slice(SITE.length).split("?")[0];
  if (tamper[path] !== undefined) return new Response(tamper[path], { status: 200 });
  try { return new Response(readFileSync(join(REPO, path)), { status: 200 }); }
  catch { return new Response("not found", { status: 404 }); }
};

console.log("-".repeat(80));
console.log("LOADING THE REAL CROWDLOCKS");
console.log("-".repeat(80));

check("A file in crowdlocks/ reads its paths from the site root",
  baseFor(`${SITE}crowdlocks/kop-fund.json`) === SITE, baseFor(`${SITE}crowdlocks/kop-fund.json`));
check("A file anywhere else reads them from its own folder",
  baseFor("https://example.org/club/my-crowdlock.json") === "https://example.org/club/");

const kop = await loadCrowdlock(`${SITE}crowdlocks/kop-fund.json`, siteFetch());
check("The Kop Fund loads and passes every check", kop.ok, kop.ok ? kop.crowdlock.network : kop.problems.join("; "));
check("…its statement is byte-for-byte the one member 1 signed",
  kop.ok && kop.statement === JSON.parse(readFileSync(join(REPO, "registrations.json"), "utf8")).declaration.statement);
check("…and it knows member 1", kop.ok && membershipOf(kop.register, "BC1QX22LEJ8SLM4G6F5L85TTE0PERAHA7KM30LQXW7")?.n === 1);

const test = await loadCrowdlock(`${SITE}crowdlocks/kop-fund-testnet4.json`, siteFetch());
check("The test Crowdlock loads and passes every check", test.ok, test.ok ? test.crowdlock.network : test.problems.join("; "));
check("…it is on testnet4, and takes registrations through its relays, not an endpoint",
  test.ok && test.crowdlock.network === "testnet4" && test.crowdlock.relays.length > 0 && !test.crowdlock.join_endpoint);
check("…and a different declaration from The Kop Fund", test.ok && kop.ok && test.statement !== kop.statement);
check("Both are on the app's starting list", STARTING_LIST.length === 2);

console.log("-".repeat(80));
console.log("REFUSING WHAT IT SHOULD");
console.log("-".repeat(80));

const refuses = async (what, result, expect) => {
  const r = await result;
  const ok = !r.ok && r.problems.some((p) => p.includes(expect));
  check(what, ok, r.ok ? "ACCEPTED IT" : r.problems[0].slice(0, 46));
};

const realDecl = readFileSync(join(REPO, "spec/declaration-v1.txt"), "utf8");
await refuses("A declaration altered by one word",
  loadCrowdlock(`${SITE}crowdlocks/kop-fund.json`, siteFetch({ "spec/declaration-v1.txt": realDecl.replace("glory", "money") })),
  "hashes to");
const doctored = JSON.parse(readFileSync(join(REPO, "crowdlocks/kop-fund-testnet4.json"), "utf8"));
doctored.declaration.sha256 = JSON.parse(readFileSync(join(REPO, "crowdlocks/kop-fund.json"), "utf8")).declaration.sha256;
await refuses("A Crowdlock file claiming somebody else's fingerprint",
  loadCrowdlock(`${SITE}crowdlocks/kop-fund-testnet4.json`, siteFetch({ "crowdlocks/kop-fund-testnet4.json": JSON.stringify(doctored) })),
  "hashes to");
const swappedReg = JSON.parse(readFileSync(join(REPO, "crowdlocks/test/registrations.json"), "utf8"));
swappedReg.declaration.sha256 = "0".repeat(64);
await refuses("A register that names a different declaration",
  loadCrowdlock(`${SITE}crowdlocks/kop-fund-testnet4.json`, siteFetch({ "crowdlocks/test/registrations.json": JSON.stringify(swappedReg) })),
  "");
await refuses("A link that is not https", loadCrowdlock("http://jimbus9.github.io/fanfund/crowdlocks/kop-fund.json", siteFetch()), "https");
await refuses("Something that is not a link", loadCrowdlock("the kop fund please", siteFetch()), "not a link");
await refuses("A link to nothing, said plainly", loadCrowdlock(`${SITE}crowdlocks/nonesuch.json`, siteFetch()), "no Crowdlock file at that link");

console.log("-".repeat(80));
console.log("TOTALS AND JOINING");
console.log("-".repeat(80));

// A pretend chain with one lock in date and above the minimum, one below it,
// and one whose date has passed — only the first may count.
const now = 1800000000;
const fakeLoaded = {
  crowdlock: { chain_api: "https://chain.example", minimum_counted_lock_sats: 10000 },
  // Three signed; only member one holds a lock that counts.
  register: { members: [{ n: 1, address: "tb1qone" }, { n: 2, address: "tb1qtwo" }, { n: 3, address: "tb1qthree" }], locks: [
    { address: "tb1qcounts", member: "tb1qone", locktime: now + 1000 },
    { address: "tb1qtoosmall", member: "tb1qtwo", locktime: now + 1000 },
    { address: "tb1qlapsed", member: "tb1qtwo", locktime: now - 1 },
    { address: "TB1QCOUNTS", member: "tb1qone", locktime: now + 1000 },
  ] },
};
const chainFetch = async (url) => {
  const coins = { tb1qcounts: [{ txid: "a", vout: 0, value: 50000, status: { confirmed: true } }, { txid: "b", vout: 0, value: 999, status: { confirmed: false } }],
    tb1qtoosmall: [{ txid: "c", vout: 0, value: 5000, status: { confirmed: true } }],
    tb1qlapsed: [{ txid: "d", vout: 0, value: 90000, status: { confirmed: true } }] };
  const addr = String(url).split("/address/")[1].split("/")[0];
  return Response.json(coins[addr] ?? []);
};
const totals = await committedTotal(fakeLoaded, chainFetch, now);
check("The committed total counts only confirmed, in-date, above-minimum locks, once each",
  totals.sats === 50000n && totals.locks === 1, `${totals.sats} sats in ${totals.locks} lock(s)`);
check("…and the only people it counts are committed members, never signatures",
  totals.members === 1, `${totals.members} committed of 3 signed`);

let posted = null;
const endpointFetch = async (url, init) => { posted = { url, body: JSON.parse(init.body) }; return Response.json({ ok: true, n: 7 }); };
const joined = await submitJoin({ join_endpoint: "https://example.com/join/submit?c=x" }, { address: "tb1qme", signature: "sig" }, endpointFetch);
check("Joining posts the address and signature to the Crowdlock's own endpoint",
  joined.ok && joined.n === 7 && posted.url.endsWith("?c=x") && posted.body.address === "tb1qme");
const noEndpoint = await submitJoin({}, { address: "tb1qme", signature: "sig" }, endpointFetch);
check("With no endpoint, it says to use a pull request instead", !noEndpoint.ok && noEndpoint.error.includes("pull request"));
const down = await submitJoin({ join_endpoint: "https://x" }, { address: "a", signature: "s" }, async () => { throw new Error("offline"); });
check("If the register can't be reached, it says the signature is fine", !down.ok && down.error.includes("signature is fine"));

check("The minimum is written plainly", shortBtc(200000) === "0.002 BTC" && shortBtc(10000) === "0.0001 BTC" && shortBtc(100000000) === "1 BTC");
const priceFetch = async (url) => (url === "https://mempool.space/api/v1/prices" ? Response.json({ USD: 60000, GBP: 46000 }) : new Response("", { status: 404 }));
check("Real bitcoin gets a rough pound figure", (await poundsPerBtc({ network: "mainnet", chain_api: "https://mempool.space/api" }, priceFetch)) === 46000);
check("Test bitcoin gets none, because it has no value", (await poundsPerBtc({ network: "testnet4", chain_api: "x" }, priceFetch)) === null);
check("No price source means no pound figure, not a wrong one", (await poundsPerBtc({ network: "mainnet", chain_api: "https://down" }, async () => { throw new Error("offline"); })) === null);
check("The link points at the counting rule's section on the minimum", COUNTING_RULE_URL.endsWith("counting-rule.md#the-minimum"));

const reg = { locks: [{ address: "tb1qa", member: "TB1QME", locktime: 5, cosigner_pubkey: "02cc" }, { address: "tb1qb", member: "tb1qother", locktime: 6, cosigner_pubkey: "02cc" }] };
const mine = locksOnRegister(reg, "tb1qme");
check("A member's own locks are found on the register, whatever the case", mine.length === 1 && mine[0].address === "tb1qa" && mine[0].cosignerPubkey === "02cc");
let lockPosted = null;
const lockOk = await submitLock({ lock_endpoint: "https://example.com/lock/submit?c=x" },
  { ownerPubkey: "02aa", cosignerPubkey: "02cc", locktime: 9, address: "tb1qa" },
  async (url, init) => { lockPosted = { url, body: JSON.parse(init.body) }; return Response.json({ ok: true }); });
check("A lock is posted to the Crowdlock's own lock endpoint, in the register's field names",
  lockOk.ok && lockPosted.url.endsWith("?c=x") && lockPosted.body.owner_pubkey === "02aa" && lockPosted.body.cosigner_pubkey === "02cc" && lockPosted.body.locktime === 9);
const again = await submitLock({ lock_endpoint: "https://x" }, { ownerPubkey: "a", cosignerPubkey: "b", locktime: 1, address: "c" },
  async () => Response.json({ error: "that lock is already on the register" }, { status: 409 }));
check("A lock already on the register counts as done", again.ok);
const early = await submitLock({ lock_endpoint: "https://x" }, { ownerPubkey: "a", cosignerPubkey: "b", locktime: 1, address: "c" },
  async () => Response.json({ error: "there are no confirmed coins at that lock address yet" }, { status: 409 }));
check("Any other refusal is passed on as it was given", !early.ok && early.error.includes("no confirmed coins"));

// An explorer that never answers: the app must give up and say so, not spin forever.
const silent = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
let gaveUp = null;
try { await esploraChain("https://x", silent, 50).utxos("tb1qme"); } catch (e) { gaveUp = e.message; }
check("An explorer that never answers is given up on, with a plain reason", /didn't answer/.test(gaveUp ?? ""), gaveUp ?? "IT WAITED FOREVER");
let unreachable = null;
try { await esploraChain("https://x", async () => { throw new TypeError("Network request failed"); }, 50).utxos("tb1qme"); } catch (e) { unreachable = e.message; }
check("One that can't be reached says so too", /couldn't reach/.test(unreachable ?? ""));

// An explorer that says "too many requests": wait, try again, and if it never
// relents, say so plainly. And don't ask the same thing twice in quick succession.
const noWait = { wait: async () => {} };
let calls = 0;
const busyOnce = async () => (++calls === 1 ? new Response("slow down", { status: 429 }) : Response.json([]));
const after = await esploraChain("https://x", busyOnce, 50, noWait).utxos("tb1qme");
check("A 'too many requests' is waited out and asked again", Array.isArray(after) && calls === 2, `${calls} calls`);
let waitedFor = null;
const busyAlways = async () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } });
let busyMsg = null;
try { await esploraChain("https://x", busyAlways, 50, { wait: async (ms) => { waitedFor = ms; } }).utxos("tb1qme"); } catch (e) { busyMsg = e.message; }
check("If it never relents, the fan is told it's busy, in plain words", /busy — wait a minute and tap Refresh/.test(busyMsg ?? ""), busyMsg ?? "NO ERROR");
check("The explorer's own 'try again in' is honoured", waitedFor === 3000, String(waitedFor));
calls = 0;
const counting = async () => { calls++; return Response.json([]); };
const c1 = esploraChain("https://x", counting, 50), c2 = esploraChain("https://x", counting, 50);
await Promise.all([c1.utxos("tb1qa"), c1.utxos("tb1qa"), c2.utxos("tb1qa")]);
check("The same question asked several times at once goes to the explorer once", calls === 1, `${calls} calls`);
await c1.utxos("tb1qb");
check("A different question is still asked", calls === 2, `${calls} calls`);
await c1.broadcast("00");
calls = 0;
await c2.utxos("tb1qa");
check("After sending, answers already in hand are forgotten", calls === 1, `${calls} calls`);
calls = 0;
const flaky = async () => (++calls === 1 ? new Response("no", { status: 500 }) : Response.json([]));
const fc = esploraChain("https://x", flaky, 50);
try { await fc.utxos("tb1qa"); } catch {}
await fc.utxos("tb1qa");
check("A failed answer isn't remembered", calls === 2, `${calls} calls`);

// Every co-signer key this repository publishes must be a real point on the
// curve: one that only looks right would make every lock naming it impossible
// to spend by the purchase route, and nothing would say so until it was tried.
{
  const { readdirSync, readFileSync } = await import("node:fs");
  const { isPublicKey } = await import("../src/wallet/core.mjs");
  const dir = new URL("../../crowdlocks/", import.meta.url);
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "index.json")) {
    for (const k of JSON.parse(readFileSync(new URL(f, dir), "utf8")).cosigner_keys ?? []) if (!isPublicKey(k)) bad.push(`${f}: ${k.slice(0, 12)}…`);
  }
  check("Every co-signer key this repository publishes is a real public key", bad.length === 0, bad.join(", "));
  const { checkCosignerXpubs } = await import("../src/wallet/core.mjs");
  const badX = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "index.json")) {
    const r = checkCosignerXpubs(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
    if (!r.ok) badX.push(`${f}: ${r.problems.join("; ")}`);
  }
  check("Every co-signer xpub this repository publishes stands for one of its keys", badX.length === 0, badX.join(", "));
}

// The app's lock must be the very script the method's reference code reads,
// or the early-release detector would be reading the wrong shape of witness.
{
  const { accountFromWords, lockFor } = await import("../src/wallet/core.mjs");
  const { lockAddress } = await import("../../method/js/lockrecord.mjs");
  const acct = accountFromWords("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "testnet4");
  const cosignerPubkey = "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c";
  const l = lockFor({ account: acct, cosignerPubkey, locktime: 1893456000 });
  check("The app's lock is byte-for-byte the method's lock script",
    l.address === lockAddress({ ownerPubkey: acct.publicKey, cosignerPubkey, locktime: 1893456000 }, "tb"), l.address);
}

// The co-signer's record, as the Crowdlock screen reads it.
{
  const { coSignerRecord } = await import("../src/crowdlocks.mjs");
  const L = { address: "tb1qlock", locktime: 2000000000, member: "tb1qm", cosigner_pubkey: "02cc" };
  const early = { txid: "e1", status: { confirmed: true, block_time: 1900000000 }, vin: [{ prevout: { scriptpubkey_address: "tb1qlock", value: 5000 }, witness: ["aa", "", "bb", "cc"] }], vout: [{ scriptpubkey_address: "tb1qelsewhere" }] };
  const onDate = { txid: "h1", status: { confirmed: true, block_time: 2000000100 }, vin: [{ prevout: { scriptpubkey_address: "tb1qlock2", value: 5000 }, witness: ["01", "bb", "cc"] }], vout: [{ scriptpubkey_address: "tb1qm" }] };
  const loaded = { crowdlock: { chain_api: "https://rec" }, register: { locks: [L, { ...L, address: "tb1qlock2" }, L] }, destinations: { entries: [] } };
  const fake = async (url) => Response.json(String(url).includes("tb1qlock2") ? [onDate] : [early]);
  const rec = await coSignerRecord(loaded, fake);
  check("The Crowdlock screen finds a co-signer's early release, once, and nothing else",
    rec.releases.length === 1 && rec.releases[0].txid === "e1" && rec.releases[0].member === "tb1qm" && rec.unreadable === 0);
}

// A hardware wallet's view of the lock. Given the co-signer as an xpub, the
// same lock must come out at exactly the same address, and turn into the
// wallet policy a Ledger (BIP 388) accepts. If either fails, no hardware
// wallet member could ever take a lock home.
{
  const { Output, networks: nets } = await import("@bitcoinerlab/descriptors");
  const { createRequire } = await import("node:module");
  const { accountFromWords, lockFor, xpubForNetwork, keyFromXpub } = await import("../src/wallet/core.mjs");
  const req = createRequire(import.meta.url);
  const { derivePolicyFromOutput } = req(join(dirname(fileURLToPath(import.meta.url)), "../node_modules/@bitcoinerlab/descriptors-core/dist/hww/policies.js"));
  const acct = accountFromWords("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "testnet4");
  const XP = xpubForNetwork("xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V", "testnet4");
  const t = 1893456000;
  const plain = lockFor({ account: acct, cosignerPubkey: keyFromXpub(XP), locktime: t });
  const out = new Output({ descriptor: `wsh(and_v(v:pk(${acct.keyExpression}),or_i(after(${t}),pk(${XP}/0/0))))`, network: nets.testnet });
  check("Written with xpubs, the way a hardware wallet sees it, the lock is the same address", out.getAddress() === plain.address, plain.address);
  const pol = await derivePolicyFromOutput({ output: out, getMasterFingerprint: async () => Buffer.from(acct.keyExpression.slice(1, 9), "hex") });
  check("…and becomes the wallet policy a Ledger accepts",
    pol.descriptorTemplate === `wsh(and_v(v:pk(@0/**),or_i(after(${t}),pk(@1/**))))` && pol.keyRoots[1] === XP && pol.change === 0 && pol.index === 0,
    pol.descriptorTemplate);
}

// Warning members when a Crowdlock's co-signer keys change.
{
  const { keyChanges, historyLinkFor } = await import("../src/crowdlocks.mjs");
  const A = "02" + "a".repeat(64), B = "03" + "b".repeat(64);
  check("The first look sets the baseline, with nothing to warn about", !keyChanges(null, [A]).changed);
  check("The same keys: no warning", !keyChanges([A], [A]).changed);
  const ch = keyChanges([A], [A, B]);
  check("An added key is caught", ch.changed && ch.added[0] === B && ch.removed.length === 0);
  const gone = keyChanges([A, B], [B]);
  check("A removed key is caught", gone.changed && gone.removed[0] === A && gone.added.length === 0);
  check("A key swapped for its mirror (02 to 03) isn't a change", !keyChanges([A], ["03" + "a".repeat(64)]).changed);
  check("A key this phone added doesn't warn when it appears", !keyChanges([A], [A, B], [B]).changed);
  check("…nor while the website still shows the old list (the false 'removed' James saw)", !keyChanges([A], [A], [B]).changed);
  check("A key someone else added still warns, alongside one this phone added", keyChanges([A], [A, B, "02" + "c".repeat(64)], [B]).added.length === 1);
  check("The warning links to the file's public history",
    historyLinkFor("https://somefan.github.io/the-pub-fund/crowdlocks/the-pub-fund.json") === "https://github.com/somefan/the-pub-fund/commits/main/crowdlocks/the-pub-fund.json");
}

// Sharing
const kopUrl = `${SITE}crowdlocks/kop-fund.json`;
const app = openLinkFor(kopUrl);
check("An app link carries the Crowdlock's file link, and gives it back", app.startsWith("crowdlock://add?url=") && fileUrlFromOpenLink(app) === kopUrl);
check("An app link to anything but an https file link is ignored",
  fileUrlFromOpenLink("crowdlock://add?url=" + encodeURIComponent("http://x.example/c.json")) === null
    && fileUrlFromOpenLink("https://example.com") === null && fileUrlFromOpenLink("crowdlock://add?url=%E0%A4%A") === null);
check("Sharing The Kop Fund sends people to its join page", kop.ok && shareLinkFor(kop) === "https://jimbus9.github.io/fanfund/join/");
check("A Crowdlock naming no page is shared as its site", test.ok && shareLinkFor(test) === SITE);

// Finding
const found = rankFound([
  { name: "Spam 1", sats: 0n, members: 0 }, { name: "Small", sats: 50000n, members: 3 },
  { name: "Big", sats: 900000n, members: 2 }, { name: "Also small", sats: 50000n, members: 5 },
]);
check("Found Crowdlocks rank by committed bitcoin, then committed members", found.map((x) => x.name).join(",") === "Big,Also small,Small,Spam 1");
check("Search matches the name or what it's for", matchesSearch({ name: "The Pub Fund", about: "Buying the Red Lion" }, "red lion") && !matchesSearch({ name: "X", about: "Y" }, "pub"));

console.log("-".repeat(80));
console.log(failures === 0 ? "The app's Crowdlock loader accepts the real files and refuses doctored ones." : `${failures} check(s) failed.`);
console.log("-".repeat(80));
process.exit(failures === 0 ? 0 : 1);
