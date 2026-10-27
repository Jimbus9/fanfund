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

console.log();
console.log("-".repeat(74));
console.log(failures === 0
  ? "The deployment is configured correctly and the entry point behaves."
  : `${failures} problem(s) — the deployment would fail or the site would break.`);
console.log("-".repeat(74));
process.exit(failures === 0 ? 0 : 1);
