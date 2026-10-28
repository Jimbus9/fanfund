// The deployment configuration, checked here rather than on a phone.
//
// Run:  node js/worker.test.mjs
//
// The first attempt to deploy this site failed in Cloudflare's build, which
// is a slow and unpleasant place to find a mistake — especially for somebody
// standing in a lab watching a build log on a phone. Everything that failure
// would have caught is checked here instead, in under a second.
//
// The failure itself: the build runs `npx wrangler deploy`, which installs
// wrangler into the build folder first, and the publisher then tried to serve
// its own tooling as part of the website. It stopped on a 137 MB binary.
// .assetsignore is what prevents that, so its contents are not optional and
// are tested like code.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const R = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};

console.log("\n" + "-".repeat(74));
console.log("THE DEPLOYMENT WOULD SUCCEED");
console.log("-".repeat(74));

// --- the configuration exists and says what it must ------------------------

check("wrangler.jsonc exists", existsSync(join(R, "wrangler.jsonc")));
check(".assetsignore exists", existsSync(join(R, ".assetsignore")),
  "without it the build publishes its own tooling and fails");

// jsonc: strip // comments before parsing. Nothing here uses a // inside a
// string, and the test would fail loudly if that changed.
const raw = readFileSync(join(R, "wrangler.jsonc"), "utf8");
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));

check("The Worker is named kop-fund", config.name === "kop-fund", config.name);
check("Its entry point is worker.js", config.main === "worker.js", config.main);
check("The entry point exists", existsSync(join(R, config.main ?? "")));
check("Static files are served from the repository root", config.assets?.directory === ".");
check("The entry point can reach them", config.assets?.binding === "ASSETS",
  "without the binding, env.ASSETS is undefined and every page 500s");
check("A compatibility date is pinned", /^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date ?? ""),
  config.compatibility_date ?? "missing");

// --- the ignore list covers what actually broke -----------------------------

const ignored = readFileSync(join(R, ".assetsignore"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

for (const needed of ["node_modules", "worker.js", "wrangler.jsonc", "lock/"]) {
  check(`.assetsignore excludes ${needed}`, ignored.includes(needed));
}

// --- the entry point actually works ----------------------------------------

const worker = await import(join(R, "worker.js"));
check("worker.js parses and its imports resolve", true);
check("worker.js exports a fetch handler", typeof worker.default?.fetch === "function");

// A request for an ordinary page must go to the static files untouched. If
// this ever stopped happening, every page on the site would break at once.
let askedAssets = null;
const env = { ASSETS: { fetch: (r) => { askedAssets = new URL(r.url).pathname; return new Response("asset"); } } };

await worker.default.fetch(new Request("https://example.com/register/"), env);
check("An ordinary page is handed to the static files", askedAssets === "/register/", askedAssets);

askedAssets = null;
await worker.default.fetch(new Request("https://example.com/join/"), env);
check("The join PAGE is static, not the endpoint", askedAssets === "/join/", askedAssets);

const notConfigured = await worker.default.fetch(
  new Request("https://example.com/join/submit", {
    method: "POST", body: "{}", headers: { "content-type": "application/json" },
  }), {});
check("With no token the endpoint refuses rather than breaking", notConfigured.status === 503,
  String(notConfigured.status));
check("…and names the route that does not depend on it",
  (await notConfigured.clone().json()).alternative?.includes("pull request"));

const wrongMethod = await worker.default.fetch(new Request("https://example.com/join/submit"), env);
check("A GET on the endpoint is refused", wrongMethod.status === 405, String(wrongMethod.status));

// --- the lock endpoint ------------------------------------------------------

const lockNoToken = await worker.default.fetch(
  new Request("https://example.com/lock/submit", {
    method: "POST", body: "{}", headers: { "content-type": "application/json" },
  }), {});
check("With no token the lock endpoint refuses rather than breaking", lockNoToken.status === 503,
  String(lockNoToken.status));
check("…and names the pull request route",
  (await lockNoToken.clone().json()).alternative?.includes("pull request"));

const lockGet = await worker.default.fetch(new Request("https://example.com/lock/submit"), env);
check("A GET on the lock endpoint is refused", lockGet.status === 405, String(lockGet.status));

// A whole lock submission, with GitHub and the blockchain stood in for. This
// is the only way to try the route before a co-signer key exists, because
// until then every real lock is (correctly) refused.
{
  const proven = await import(join(R, "lock", "lock.mjs"));
  const { memberAddressForOwnerKey } = await import(join(R, "js", "verify.mjs"));
  const key = (seed) => Buffer.from(proven.ECPair.fromPrivateKey(Buffer.alloc(32, seed)).publicKey).toString("hex");
  const OWNER = key(1), COSIGNER = key(2);
  const kop = JSON.parse(readFileSync(join(R, "crowdlocks", "kop-fund.json"), "utf8"));
  const crowdlock = { ...kop, cosigner_keys: [COSIGNER] };
  const member = memberAddressForOwnerKey(OWNER, "bc");
  const register = { declaration: { sha256: kop.declaration.sha256 },
    members: [{ n: 1, address: member, signature: "x", signed: "2026-10-27" }], locks: [] };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

  let written = null, chainAsked = null, chainSats = 300000;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/contents/crowdlocks/kop-fund.json")) return Response.json({ content: b64(crowdlock), sha: "c" });
    if (u.includes("/contents/registrations.json") && (init.method ?? "GET") === "GET")
      return Response.json({ content: b64(register), sha: "r1" });
    if (u.includes("/contents/registrations.json") && init.method === "PUT") {
      written = JSON.parse(init.body); return Response.json({});
    }
    if (u.startsWith(crowdlock.chain_api)) {
      chainAsked = u;
      return Response.json({ chain_stats: { funded_txo_sum: chainSats, spent_txo_sum: 0 } });
    }
    return new Response("unexpected " + u, { status: 500 });
  };
  const submit = (body) => worker.default.fetch(new Request("https://example.com/lock/submit", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), { GITHUB_TOKEN: "test" });

  try {
    const terms = { owner_pubkey: OWNER, cosigner_pubkey: COSIGNER,
      locktime: Math.floor(Date.now() / 1000) + 365 * 86400 };
    const ok = await submit(terms);
    const okBody = await ok.json();
    check("A genuine, funded lock is accepted end to end", ok.status === 200, okBody.error ?? okBody.address);
    check("…the chain was asked about the rebuilt address", chainAsked?.endsWith(okBody.address ?? "?"));
    const after = written && JSON.parse(Buffer.from(written.content, "base64").toString());
    check("…the register written back holds exactly one new lock",
      after?.locks?.length === 1 && after.locks[0].member === member);
    check("…quoting the version it read, so a clash is refused", written?.sha === "r1");
    check("…with a commit message naming the member", written?.message === "Lock for member 1", written?.message);

    written = null; chainSats = 0;
    const empty = await submit(terms);
    check("An unfunded lock is refused and nothing is written", empty.status === 409 && written === null,
      String(empty.status));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- two people at once -----------------------------------------------------
//
// Every write quotes the version it read, so GitHub refuses it if the register
// changed meanwhile. That is correct, and it is why two people joining at the
// same moment cannot overwrite each other. The question is what the second
// person is then told. Until now: "the register could not be written just
// now" — sent away because somebody else joined in the same minute.
//
// Now the conflict is retried, and the decision is made AGAIN from scratch
// against the newly read register rather than replayed. That distinction is
// the whole of it: if the fresh register already holds this address, the
// duplicate check has to see it, or a retry would write a member twice.
{
  const kop = JSON.parse(readFileSync(join(R, "crowdlocks", "kop-fund.json"), "utf8"));
  const MEMBER = {
    address: "bc1qx22lej8slm4g6f5l85tte0peraha7km30lqxw7",
    signature: "H7yCAMd+09Ap+GnsO7chcHd9ILDdBvMBruTeHF6WPyBHTUH6e2dJlaGi3nRGuaEtYvC9258+LzM1Y9kLmJpsD5I=",
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const emptyRegister = () => ({ declaration: { sha256: kop.declaration.sha256 }, members: [], locks: [] });

  const realFetch = globalThis.fetch;

  /** GitHub that refuses the first `conflicts` writes, as if somebody else wrote first. */
  const stub = (conflicts, registerAt) => {
    let puts = 0, reads = 0;
    const state = { puts: () => puts, written: null, reads: () => reads };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/contents/crowdlocks/")) return Response.json({ content: b64(kop), sha: "c" });
      if (u.includes("/contents/registrations.json") && (init.method ?? "GET") === "GET") {
        return Response.json({ content: b64(registerAt(reads++)), sha: `r${reads}` });
      }
      if (u.includes("/contents/registrations.json") && init.method === "PUT") {
        puts++;
        if (puts <= conflicts) return new Response("conflict", { status: 409 });
        state.written = JSON.parse(init.body);
        return Response.json({});
      }
      return new Response("unexpected " + u, { status: 500 });
    };
    return state;
  };

  const submit = () => worker.default.fetch(new Request("https://example.com/join/submit", {
    method: "POST", body: JSON.stringify(MEMBER), headers: { "content-type": "application/json" },
  }), { GITHUB_TOKEN: "test" });

  try {
    // One collision, then the register is still empty: the join succeeds.
    let s = stub(1, () => emptyRegister());
    let res = await submit();
    check("A write conflict is retried rather than reported", res.status === 200, String(res.status));
    check("…and it really did take a second attempt", s.puts() === 2, `${s.puts()} write(s)`);
    check("…and the register was re-read before deciding again", s.reads() === 2, `${s.reads()} read(s)`);
    const writtenRegister = JSON.parse(Buffer.from(s.written.content, "base64").toString());
    check("…and exactly one member was written, not two", writtenRegister.members.length === 1,
      `${writtenRegister.members.length} member(s)`);

    // The collision was the SAME person being added by another route. The
    // retry must refuse as a duplicate, not write them in twice.
    s = stub(1, (n) => (n === 0 ? emptyRegister()
      : { ...emptyRegister(), members: [{ n: 1, ...MEMBER, signed: "2026-10-27" }] }));
    res = await submit();
    check("A retry decides again, so a duplicate is caught the second time around",
      res.status === 409, String(res.status));
    check("…and nothing was written", s.written === null);

    // Collisions all the way down stop rather than looping.
    s = stub(99, () => emptyRegister());
    res = await submit();
    check("Endless collisions give up instead of looping", res.status === 503, String(res.status));
    check("…after a bounded number of attempts", s.puts() === 3, `${s.puts()} write(s)`);
    check("…and still name the route that needs nobody",
      (await res.clone().json()).alternative?.includes("pull request"));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log();
console.log("-".repeat(74));
console.log(failures === 0
  ? "The deployment is configured correctly and the entry point behaves."
  : `${failures} problem(s) — the deployment would fail or the site would break.`);
console.log("-".repeat(74));
process.exit(failures === 0 ? 0 : 1);
