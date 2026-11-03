// Starting a Crowdlock, tested without GitHub: the files it builds, loaded by
// the app's own loader as if published, a registration taken in by the inbox
// code copied into the new repository, and the GitHub steps in order.
//
// Run: node start.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildCrowdlock, declarationSkeleton, NO_RETURNS, slugify } from "../src/start.mjs";
import { startSignIn, waitForSignIn, createCrowdlockRepo, CLIENT_ID, SCOPES, canWrite, updateCrowdlockRepo, addMaintainer, addCosignerKey } from "../src/github.mjs";
import { repoFromFileUrl, versionStatus, changesSince } from "../src/crowdlocks.mjs";
import template from "../src/template.mjs";
import { loadCrowdlock } from "../src/crowdlocks.mjs";
import { accountFromWords, cosignerFromWords, newWords, signStatement } from "../src/wallet/core.mjs";

let failures = 0;
const check = (what, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(70)} ${detail}`); };
const rule = (t) => { console.log("-".repeat(80)); if (t) { console.log(t); console.log("-".repeat(80)); } };

rule("THE CO-SIGNER KEY FOR A NEW CROWDLOCK");
const words = newWords();
const member = accountFromWords(words, "testnet4");
const co = cosignerFromWords(words, "testnet4");
check("It comes from the same backup words, on its own path", co.path === "m/84'/1'/7713'/0/0" && cosignerFromWords(words, "testnet4").publicKey === co.publicKey);
check("…and is never the member key", co.publicKey.slice(2) !== member.publicKey.slice(2));

rule("WHAT A FOUNDER TYPES");
const site = "https://somefan.github.io/the-pub-fund/";
const base = {
  name: "The Pub Fund", about: "Regulars buying the Red Lion so it stays a pub for good.", title: "THE RED LION DECLARATION",
  network: "mainnet", minimumSats: 100000, cosignerPubkey: "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c", testCosignerPubkey: co.publicKey,
  siteBase: site, today: "2026-11-01",
};
const filled = declarationSkeleton("THE RED LION DECLARATION").replace(/\[Write it here[^\]]*\]/, "We are buying the Red Lion so that it stays a pub, owned by nobody who can sell it.");

let r = buildCrowdlock({ ...base, declarationText: declarationSkeleton() });
check("The skeleton alone is refused until the founder writes their purpose", !r.ok && r.problems.some((p) => p.includes("[Write it here")));
r = buildCrowdlock({ ...base, declarationText: filled.replace(NO_RETURNS, "Members may receive a share of profits.") });
check("A declaration without the no-returns line is refused", !r.ok && r.problems.some((p) => p.includes("no-returns line")));
r = buildCrowdlock({ ...base, declarationText: filled, title: "Red Lion (2026)" });
check("A title with brackets is refused", !r.ok && r.problems.some((p) => p.includes("brackets")));
r = buildCrowdlock({ ...base, declarationText: filled, cosignerPubkey: "not a key" });
check("Real bitcoin without a proper co-signer key is refused", !r.ok && r.problems.some((p) => p.includes("co-signer")));
check("Names become safe repository names", slugify("The Pub Fund — Red Lion!") === "the-pub-fund-red-lion" && slugify("") === "crowdlock");

rule("WHAT IT BUILDS, LOADED BY THE APP AS IF PUBLISHED");
const real = buildCrowdlock({ ...base, declarationText: filled });
check("A real-bitcoin Crowdlock is built, with a test copy beside it", real.ok && real.fingerprints.length === 2, real.ok ? real.slug : real.problems.join("; "));
const files = real.files;
const served = (fs) => async (url) => {
  const u = String(url);
  if (!u.startsWith(site)) return new Response("no", { status: 404 });
  const p = u.slice(site.length).split("?")[0];
  return p in fs ? new Response(fs[p], { status: 200 }) : new Response("no", { status: 404 });
};
const realLoaded = await loadCrowdlock(real.links[0].url, served(files));
check("The real Crowdlock passes every check the app applies to anybody's", realLoaded.ok && realLoaded.crowdlock.network === "mainnet",
  realLoaded.ok ? "" : realLoaded.problems.join("; "));
const testLoaded = await loadCrowdlock(real.links[1].url, served(files));
check("So does its test copy, on testnet4 with the phone's co-signer key",
  testLoaded.ok && testLoaded.crowdlock.network === "testnet4" && testLoaded.crowdlock.cosigner_keys[0] === co.publicKey);
check("The two have different fingerprints, so no signature can cross", realLoaded.crowdlock.declaration.sha256 !== testLoaded.crowdlock.declaration.sha256);
check("Both name relays and spares, and no endpoint of ours",
  [realLoaded, testLoaded].every((l) => l.crowdlock.relays.length === 5 && l.crowdlock.spare_relays.length === 3 && !l.crowdlock.join_endpoint));
check("The repository carries the relay inbox and the code it runs",
  [".github/workflows/relay-inbox.yml", "relay/inbox.mjs", "relay/package-lock.json", "js/inbox.mjs", "js/vendor/noble-hashes/_md.js", ".nojekyll"].every((p) => p in files));
check("…and a front page with both join links", files["index.html"].includes(real.links[0].url) && files["index.html"].includes(real.links[1].url));
const testOnly = buildCrowdlock({ ...base, network: "testnet4", cosignerPubkey: undefined, declarationText: filled });
check("A test-only Crowdlock is just the test copy", testOnly.ok && testOnly.fingerprints.length === 1 && !("registrations.json" in testOnly.files));

rule("THE COPIED INBOX WORKS ON THE NEW CROWDLOCK");
// Write the repository to disk and run the copied inbox code on a real,
// signed registration for the test copy, exactly as its job would.
const dir = mkdtempSync(join(tmpdir(), "crowdlock-"));
for (const [p, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), content); }
const { applyRecords } = await import(join(dir, "js/inbox.mjs"));
const { finalizeEvent, generateSecretKey } = await import("nostr-tools/pure");
const { recordEventTemplate } = await import(join(dir, "js/inbox.mjs"));
const t = testLoaded.crowdlock;
const signature = signStatement(member, testLoaded.statement);
const event = finalizeEvent(recordEventTemplate({ type: "join", address: member.address, signature }, t.declaration.sha256, 1800000000), generateSecretKey());
const applied = await applyRecords(testLoaded.register, [event], {
  crowdlock: t, statement: testLoaded.statement, now: 1800000000, today: "2026-11-01", confirmedSats: async () => 0,
});
check("The founder's own signature joins their new Crowdlock as member 1", applied.register.members[0]?.n === 1 && applied.register.members[0].address === member.address);

rule("GITHUB: SIGN-IN AND SETTING IT UP");
const calls = [];
let polls = 0;
const fakeGitHub = async (url, init = {}) => {
  const u = String(url); const body = init.body ? JSON.parse(init.body) : null;
  calls.push(`${init.method ?? "GET"} ${u.replace("https://api.github.com", "")}`);
  if (u.endsWith("/login/device/code")) calls.deviceBody = body;
  if (u.endsWith("/login/device/code")) return Response.json({ device_code: "dev", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 });
  if (u.endsWith("/login/oauth/access_token")) return Response.json(++polls < 3 ? { error: "authorization_pending" } : { access_token: "tok" });
  if (u.endsWith("/user")) return Response.json({ login: "SomeFan" });
  if (u.endsWith("/user/repos")) return Response.json({}, { status: 201 });
  if (u.includes("/git/ref/heads/main")) return Response.json({ object: { sha: "c0" } });
  if (u.includes("/git/commits/c0")) return Response.json({ tree: { sha: "t0" } });
  if (u.endsWith("/git/trees")) { calls.treeFiles = body.tree.map((x) => x.path); calls.treeBase = body.base_tree; return Response.json({ sha: "t1" }, { status: 201 }); }
  if (u.endsWith("/git/commits")) { calls.parents = body.parents; return Response.json({ sha: "c1" }, { status: 201 }); }
  if (u.includes("/git/refs/heads/main")) { calls.newHead = body.sha; return Response.json({}); }
  if (u.endsWith("/pages")) return Response.json({}, { status: 201 });
  if (u.endsWith("/dispatches")) return new Response(null, { status: calls.filter((c) => c.endsWith("/dispatches")).length < 2 ? 404 : 204 });
  return Response.json({ message: "unexpected" }, { status: 500 });
};
const code = await startSignIn(fakeGitHub);
check("Sign-in starts with a short code to type at github.com/login/device", code.userCode === "ABCD-1234" && code.verificationUri.endsWith("/login/device"));
check("…for the Crowdlock app, asking only to make a public repository and its job file",
  CLIENT_ID === "Ov23li5lTD1JhdYTsd63" && SCOPES === "public_repo workflow" && calls.deviceBody?.scope === SCOPES && calls.deviceBody?.client_id === CLIENT_ID);
const token = await waitForSignIn(code, fakeGitHub, async () => {});
check("It waits while the founder is still allowing it, then gets the permission", token === "tok" && polls === 3);
const denied = waitForSignIn(code, async () => Response.json({ error: "access_denied" }), async () => {});
let deniedMsg = ""; try { await denied; } catch (e) { deniedMsg = e.message; }
check("If the founder says no, nothing is created and the app says so", deniedMsg.includes("chose not to allow"));

const steps = [];
const made = await createCrowdlockRepo({ token, repoName: real.slug, description: base.about, files, progress: (s) => steps.push(s) }, fakeGitHub, async () => {});
check("The repository is made in the founder's own account", made.owner === "SomeFan" && made.siteBase === "https://somefan.github.io/the-pub-fund/");
check("Every file goes in, in one commit on top of GitHub's first",
  calls.treeFiles.length === Object.keys(files).length && calls.treeBase === "t0" && calls.parents[0] === "c0" && calls.newHead === "c1");
check("Its site is switched on and its inbox started, retrying while the job registers",
  calls.some((c) => c.endsWith("/pages")) && made.inboxStarted && calls.filter((c) => c.endsWith("/dispatches")).length === 2);
check("The founder is told each step", steps.length === 4, steps.join(" → "));

rule("LOOKING AFTER IT: UPDATES AND MAINTAINERS");
check("The repository is read from a GitHub Pages link", JSON.stringify(repoFromFileUrl(real.links[0].url)) === JSON.stringify({ owner: "somefan", repo: "the-pub-fund" })
  && repoFromFileUrl("https://example.org/c.json") === null);
check("A new Crowdlock publishes the version it runs", files["relay/VERSION"] === template.version + "\n");
check("Up to date, behind, made before versions, the source, or not the app's",
  versionStatus(template.version, template.version, true) === "current" && versionStatus("2026-10-31", template.version, true) === "behind"
    && versionStatus(null, template.version, true) === "behind" && versionStatus("source\n", template.version, true) === "source"
    && versionStatus(null, template.version, false) === "unknown");
check("An update lists only what changed since",
  changesSince("2026-10-31", template.changes).every((c) => c.version > "2026-10-31") && changesSince("2026-10-31", template.changes).length === template.changes.length - 1
    && changesSince(null, template.changes).length === template.changes.length && changesSince(template.version, template.changes).length === 0);
check("An update never touches the declaration, register, settings or front page",
  !Object.keys(template.files).some((p) => /^(crowdlocks\/|test\/|declaration\.txt|registrations\.json|destinations\.json|index\.html|README\.md)/.test(p)));

const gcalls = [];
const fakeRepo = (perms) => async (url, init = {}) => {
  const u = String(url).replace("https://api.github.com", ""); const body = init.body ? JSON.parse(init.body) : null;
  gcalls.push(`${init.method ?? "GET"} ${u}`);
  if (u === "/repos/somefan/the-pub-fund") return Response.json({ permissions: perms });
  if (u.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "c5" } });
  if (u.endsWith("/git/commits/c5")) return Response.json({ tree: { sha: "t5" } });
  if (u.endsWith("/git/trees")) { gcalls.tree = body.tree.map((x) => x.path); return Response.json({ sha: "t6" }, { status: 201 }); }
  if (u.endsWith("/git/commits")) { gcalls.message = body.message; return Response.json({ sha: "c6" }, { status: 201 }); }
  if (u.endsWith("/git/refs/heads/main")) return Response.json({});
  if (u.endsWith("/dispatches")) return new Response(null, { status: 204 });
  if (u === "/users/janesmith") return Response.json({ login: "janesmith" });
  if (u === "/users/nobody-here") return Response.json({ message: "Not Found" }, { status: 404 });
  if (u === "/repos/somefan/the-pub-fund/collaborators/janesmith") { gcalls.perm = body.permission; return Response.json({ id: 1 }, { status: 201 }); }
  return Response.json({ message: "unexpected " + u }, { status: 500 });
};
check("A member who isn't founder or maintainer can't write", !(await canWrite("t", "somefan", "the-pub-fund", fakeRepo({ push: false, pull: true }))));
check("The founder or a maintainer can", await canWrite("t", "somefan", "the-pub-fund", fakeRepo({ push: true })));
await updateCrowdlockRepo({ token: "t", owner: "somefan", repo: "the-pub-fund", files: template.files, message: "Update" }, fakeRepo({ push: true }));
check("An update writes the inbox's files in one commit and restarts the inbox",
  gcalls.tree.length === Object.keys(template.files).length && gcalls.includes("POST /repos/somefan/the-pub-fund/actions/workflows/relay-inbox.yml/dispatches"));
check("A maintainer is invited with write access, not ownership",
  (await addMaintainer({ token: "t", owner: "somefan", repo: "the-pub-fund", username: "@janesmith" }, fakeRepo({ push: true }))) === "invited" && gcalls.perm === "push");
let badName = ""; try { await addMaintainer({ token: "t", owner: "somefan", repo: "the-pub-fund", username: "nobody-here" }, fakeRepo({})); } catch (e) { badName = e.message; }
check("A username that doesn't exist is caught, in plain words", badName.includes("no GitHub account called nobody-here"));
let junk = ""; try { await addMaintainer({ token: "t", owner: "x", repo: "y", username: "jane smith!" }, fakeRepo({})); } catch (e) { junk = e.message; }
check("Something that isn't a username is caught before asking GitHub", junk.includes("isn't a GitHub username"));

// Adding a co-signer key to a Crowdlock that already exists.
const { checkWithNewKey } = await import("../src/start.mjs");
const { newestCosigner, pathInRepo } = await import("../src/crowdlocks.mjs");
const { isPublicKey } = await import("../src/wallet/core.mjs");
const realPath = `crowdlocks/${real.slug}.json`;
const realFile = files[realPath];
const oldKey = JSON.parse(realFile).cosigner_keys[0];
const newKey = co.publicKey;
const withContents = (perms) => { const inner = fakeRepo(perms); return async (url, init = {}) => {
  const u = String(url).replace("https://api.github.com", "");
  if (u === `/repos/somefan/the-pub-fund/contents/${realPath}`) return Response.json({ content: Buffer.from(realFile).toString("base64").replace(/(.{60})/g, "$1\n") });
  return inner(url, init);
}; };
const addedKey = await addCosignerKey({ token: "t", owner: "somefan", repo: "the-pub-fund", path: realPath, key: newKey.toUpperCase(), check: checkWithNewKey }, withContents({ push: true }));
check("A co-signer key is added alongside the one already there, never replacing it",
  addedKey.keys.length === 2 && addedKey.keys[0] === oldKey && addedKey.keys[1] === newKey && gcalls.tree.length === 1 && gcalls.tree[0] === realPath);
check("New locks use the newest key; the old one stays for locks already made", newestCosigner({ cosigner_keys: addedKey.keys }) === newKey && newestCosigner({ cosigner_keys: [] }) === undefined);
let dupe = ""; try { await addCosignerKey({ token: "t", owner: "somefan", repo: "the-pub-fund", path: realPath, key: oldKey, check: checkWithNewKey }, withContents({ push: true })); } catch (e) { dupe = e.message; }
check("The same key twice is refused", dupe.includes("already has that"));
const offCurve = "02" + "00".repeat(31) + "05";
let bad = ""; try { await addCosignerKey({ token: "t", owner: "somefan", repo: "the-pub-fund", path: realPath, key: offCurve, check: checkWithNewKey }, withContents({ push: true })); } catch (e) { bad = e.message; }
check("A key that only looks right — not a real point on the curve — is refused", !isPublicKey(offCurve) && isPublicKey(newKey) && bad.includes("not a real public key"), bad);

// Co-signer xpubs, for hardware wallets.
{
  const { keyFromXpub, xpubForNetwork, checkCosignerXpubs, cosignerKeyFromWords, cosignerFromWords } = await import("../src/wallet/core.mjs");
  const BIP84 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const XP = "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
  const KEY = "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c";
  check("A co-signer key's xpub is BIP84's published account key, and its first key is the co-signer key",
    cosignerKeyFromWords(BIP84).xpub === XP && keyFromXpub(XP) === KEY);
  const tp = xpubForNetwork(XP, "testnet4");
  check("The same xpub rewritten for test networks (tpub) stands for the same key, and converts back",
    tp.startsWith("tpub") && keyFromXpub(tp) === KEY && xpubForNetwork(tp, "mainnet") === XP);
  check("A test copy's phone-made co-signer comes with its tpub", keyFromXpub(cosignerFromWords(words, "testnet4").xpub) === co.publicKey);
  check("Something that isn't an xpub stands for nothing", keyFromXpub(KEY) === null && keyFromXpub("xpub123") === null);
  check("An xpub that stands for one of the keys passes", checkCosignerXpubs({ cosigner_keys: [KEY], cosigner_xpubs: [XP] }).ok);
  const wrong = checkCosignerXpubs({ cosigner_keys: [co.publicKey], cosigner_xpubs: [XP] });
  check("An xpub for a key that isn't listed is refused — a hardware wallet would build a lock nobody counts", !wrong.ok && wrong.problems[0].includes("not one of"));

  const withX = buildCrowdlock({ ...base, declarationText: filled, cosignerPubkey: XP, testCosignerPubkey: cosignerFromWords(words, "testnet4").xpub });
  const rf = JSON.parse(withX.files[`crowdlocks/${real.slug}.json`]), tf = JSON.parse(withX.files[`crowdlocks/${real.slug}-test.json`]);
  check("Starting a Crowdlock with an xpub publishes the key and the xpub together",
    withX.ok && rf.cosigner_keys[0] === KEY && rf.cosigner_xpubs[0] === XP && tf.cosigner_keys[0] === co.publicKey && tf.cosigner_xpubs[0].startsWith("tpub"));

  // Adding the xpub for a key the Crowdlock already has.
  const keyed = JSON.stringify({ ...JSON.parse(realFile), cosigner_keys: [KEY] }, null, 2);
  const serve = (file) => { const inner = fakeRepo({ push: true }); return async (url, init = {}) => {
    const u = String(url).replace("https://api.github.com", "");
    if (u === `/repos/somefan/the-pub-fund/contents/${realPath}`) return Response.json({ content: Buffer.from(file).toString("base64") });
    return inner(url, init);
  }; };
  const onlyX = await addCosignerKey({ token: "t", owner: "somefan", repo: "the-pub-fund", path: realPath, key: KEY, xpub: XP, check: checkWithNewKey }, serve(keyed));
  check("An xpub for a key already there is added on its own, the keys unchanged",
    onlyX.keys.length === 1 && onlyX.keys[0] === KEY && onlyX.xpubs[0] === XP && gcalls.message.startsWith("Add a co-signer xpub"));
  const both = await addCosignerKey({ token: "t", owner: "somefan", repo: "the-pub-fund", path: realPath, key: KEY, xpub: XP, check: checkWithNewKey }, serve(realFile));
  check("A new key given as an xpub adds the key and the xpub", both.keys.at(-1) === KEY && both.xpubs[0] === XP);
  let again = ""; try { await addCosignerKey({ token: "t", owner: "somefan", repo: "the-pub-fund", path: realPath, key: KEY, xpub: XP, check: checkWithNewKey }, serve(JSON.stringify({ ...JSON.parse(keyed), cosigner_xpubs: [XP] }))); } catch (e) { again = e.message; }
  check("…and the same xpub twice is refused", again.includes("already has"));
  const other = cosignerKeyFromWords(words).publicKey;
  const notKop = JSON.stringify({ ...JSON.parse(realFile), cosigner_keys: [co.publicKey] }, null, 2);
  let mismatch = ""; try { await addCosignerKey({ token: "t", owner: "somefan", repo: "the-pub-fund", path: realPath, key: other, xpub: XP, check: checkWithNewKey }, serve(notKop)); } catch (e) { mismatch = e.message; }
  check("An xpub that doesn't stand for the key being added is refused", mismatch.includes("not one of"));
}
check("A Crowdlock's file is found inside its repository from its link",
  pathInRepo("https://somefan.github.io/the-pub-fund/crowdlocks/the-pub-fund.json") === "crowdlocks/the-pub-fund.json" && pathInRepo("https://example.com/x.json") === null);

rule();
console.log(failures === 0 ? "Starting a Crowdlock builds one that passes every check, and sets it up in the founder's own account." : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
