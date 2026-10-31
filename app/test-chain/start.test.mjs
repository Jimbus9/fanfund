// Starting a Crowdlock, tested without GitHub: the files it builds, loaded by
// the app's own loader as if published, a registration taken in by the inbox
// code copied into the new repository, and the GitHub steps in order.
//
// Run: node start.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildCrowdlock, declarationSkeleton, NO_RETURNS, slugify } from "../src/start.mjs";
import { startSignIn, waitForSignIn, createCrowdlockRepo, CLIENT_ID, SCOPES } from "../src/github.mjs";
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
  network: "mainnet", minimumSats: 100000, cosignerPubkey: "02" + "ab".repeat(32), testCosignerPubkey: co.publicKey,
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

rule();
console.log(failures === 0 ? "Starting a Crowdlock builds one that passes every check, and sets it up in the founder's own account." : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
