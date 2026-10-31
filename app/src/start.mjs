// Starting a new Crowdlock: everything a founder's repository holds, built
// from what they typed, and checked by the same code that checks every other
// Crowdlock before anything is created. Pure: no network, no keys.
//
// A real-bitcoin Crowdlock is always made with a matching test copy beside it,
// on testnet4 with its own fingerprint, so a founder can rehearse joining,
// locking and taking a lock home with worthless money first. A test-only
// Crowdlock is just the test copy.
//
// What lands in the founder's repository:
//   crowdlocks/index.json            which Crowdlocks the site lists
//   crowdlocks/<slug>.json           the real Crowdlock (real bitcoin only)
//   declaration.txt                  its declaration
//   registrations.json               its register, empty
//   destinations.json                its destinations list, empty
//   crowdlocks/<slug>-test.json      the test copy, and under test/ the same
//   index.html                       a plain front page with the join link
//   + the relay inbox and its code (src/template.mjs)

import { canonicalise, declarationHash, membershipStatement, checkCrowdlock, checkRegisterFiles, checkSeparate } from "../../js/crowdlock.mjs";
import template from "./template.mjs";

/** The one line every declaration started in the app must keep, word for word. */
export const NO_RETURNS =
  "Nobody who signs this, locks money for it or commits money to it will receive anything financial in return, ever: no payout, no dividend, no interest and no share of any profit. Money goes in; nothing financial comes out.";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom", "wss://offchain.pub"];
export const DEFAULT_SPARES = ["wss://relay.snort.social", "wss://nostr-pub.wellorder.net", "wss://relay.nostr.bg"];

const CHAIN = { mainnet: "https://mempool.space/api", testnet4: "https://mempool.space/testnet4/api" };
const TEST_LENGTHS = [1 / 8766, 1 / 365.25, 1];   // an hour, a day, a year
const REAL_LENGTHS = [1, 3, 5];

/** A skeleton declaration with the no-returns line already in it. */
export function declarationSkeleton(title = "OUR DECLARATION") {
  return [
    title.toUpperCase(),
    "",
    "What we are raising money for, and why:",
    "",
    "[Write it here, in plain words. Say what the money will buy, who will hold it, and what happens if it never gets bought.]",
    "",
    "THE RULE THAT DOES NOT CHANGE",
    "",
    NO_RETURNS,
    "",
    "Nobody holds anybody else's money. Each person's money stays in a wallet only they control, locked until a date they choose, and nothing can move it without their own signature.",
    "",
  ].join("\n");
}

/** A repository-safe short name from the Crowdlock's name. */
export function slugify(name) {
  return String(name ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "crowdlock";
}

const emptyRegister = (c) => ({
  format: 1,
  declaration: { sha256: c.declaration.sha256, statement: membershipStatement(c) },
  members: [],
  locks: [],
});
const emptyDestinations = (c, today) => ({
  format: 1, instance: c.declaration.sha256, updated: today,
  minimum_age_days: c.destination_wait_days, threshold: c.attestor_threshold, attestors: [], entries: [],
});

function crowdlockFile({ name, about, disclaimer, title, declFile, declText, network, minimumSats, cosigner, regDir }) {
  return {
    format: 1,
    name,
    about,
    disclaimer,
    declaration: { title, version: 1, file: declFile, sha256: declarationHash(declText) },
    network,
    unit: "BTC",
    lock_lengths_years: network === "mainnet" ? REAL_LENGTHS : TEST_LENGTHS,
    minimum_counted_lock_sats: minimumSats,
    cosigner_keys: [cosigner],
    gathering_window_max_days: 28,
    settlement_window_max_days: 14,
    destination_wait_days: 14,
    attestor_keys: [],
    attestor_threshold: 1,
    max_commitment_fee: 0.01,
    register: { registrations: `${regDir}registrations.json`, destinations: `${regDir}destinations.json` },
    chain_api: CHAIN[network],
    relays: DEFAULT_RELAYS,
    spare_relays: DEFAULT_SPARES,
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function frontPage({ name, about, links }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title>
<style>
  body { font: 17px/1.55 system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px 16px 60px; color: #1a1a1a; background: #fff; }
  code { word-break: break-all; background: #f3f3f3; padding: 2px 4px; border-radius: 4px; font-size: 14px; }
  .note { color: #555; font-size: 15px; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } code { background: #222; } .note { color: #aaa; } }
</style>
</head>
<body>
<h1>${esc(name)}</h1>
<p>${esc(about)}</p>
<p><strong>This is a Crowdlock.</strong> Nobody pools money. Each member keeps their own bitcoin in their own wallet, locked until a date they choose, and backs a purchase only by signing for it themselves. Nobody receives anything financial in return, ever.</p>
${links.map((l) => `<h2>${esc(l.label)}</h2>
<p>To join with the Crowdlock app, tap <em>Add a Crowdlock</em> and paste:</p>
<p><code>${esc(l.url)}</code></p>
<p class="note"><a href="${esc(l.declaration)}">Read the declaration</a> · <a href="${esc(l.register)}">The register</a> — every signature and lock, checkable by anyone.</p>`).join("\n")}
<p class="note">Started with the Crowdlock app. The method is published at <a href="https://jimbus9.github.io/fanfund/spec/">jimbus9.github.io/fanfund/spec</a>.</p>
</body>
</html>
`;
}

/**
 * Everything a new Crowdlock's repository holds.
 *
 *   name, about          what the founder typed
 *   title                the declaration's title (no brackets — it goes in the signed statement)
 *   declarationText      the declaration; must keep NO_RETURNS word for word
 *   network              "mainnet" (with a test copy) or "testnet4" (test copy only)
 *   minimumSats          the real Crowdlock's minimum counted lock
 *   cosignerPubkey       the real Crowdlock's co-signer (pasted in)
 *   testCosignerPubkey   the test copy's co-signer (made on the phone)
 *   siteBase             https://<owner>.github.io/<repo>/
 *   today                "YYYY-MM-DD"
 *
 * Returns { ok, problems } or { ok: true, files, links }.
 */
export function buildCrowdlock({ name, about, title, declarationText, network, minimumSats, cosignerPubkey, testCosignerPubkey, siteBase, today }) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  name = String(name ?? "").trim();
  about = String(about ?? "").trim();
  title = String(title ?? "").trim();
  const text = canonicalise(String(declarationText ?? ""));

  need(name.length >= 3 && name.length <= 80, "Give it a name of 3 to 80 characters.");
  need(about.length >= 10 && about.length <= 300, "Say in a sentence what it is for (10 to 300 characters).");
  need(title.length >= 3 && title.length <= 80, "Give the declaration a title of 3 to 80 characters.");
  need(!/[()\n]/.test(title), "The declaration's title can't contain brackets — it goes inside what members sign.");
  need(text.includes(NO_RETURNS), "The declaration must keep the no-returns line exactly as it is. It's the one rule every Crowdlock shares.");
  need(!text.includes("[Write it here"), "Replace the [Write it here…] part with what you're raising money for.");
  need(text.length <= 20000, "The declaration is too long — keep it under 20,000 characters.");
  need(network === "mainnet" || network === "testnet4", "Choose real or test bitcoin.");
  need(/^https:\/\/[^\s]+\/$/.test(siteBase ?? ""), "internal: the site address is missing");
  if (network === "mainnet") {
    need(Number.isInteger(minimumSats) && minimumSats >= 10000, "Set a minimum of at least 0.0001 BTC.");
    need(/^0[23][0-9a-f]{64}$/.test(cosignerPubkey ?? ""), "Paste the co-signer's public key: 66 characters, starting 02 or 03.");
  }
  need(/^0[23][0-9a-f]{64}$/.test(testCosignerPubkey ?? ""), "internal: the test co-signer key is missing");
  if (problems.length) return { ok: false, problems };

  const slug = slugify(name);
  const files = {};
  const crowdlocks = [];
  const links = [];

  if (network === "mainnet") {
    const c = crowdlockFile({
      name, about, disclaimer: "Nobody receives anything financial in return, ever. This is not an investment.",
      title, declFile: "declaration.txt", declText: text, network, minimumSats, cosigner: cosignerPubkey, regDir: "",
    });
    files[`crowdlocks/${slug}.json`] = JSON.stringify(c, null, 2) + "\n";
    files["declaration.txt"] = text;
    files["registrations.json"] = JSON.stringify(emptyRegister(c), null, 2) + "\n";
    files["destinations.json"] = JSON.stringify(emptyDestinations(c, today), null, 2) + "\n";
    crowdlocks.push({ c, text, slug });
    links.push({ label: "Real bitcoin", url: `${siteBase}crowdlocks/${slug}.json`, declaration: `${siteBase}declaration.txt`, register: `${siteBase}registrations.json` });
  }

  // The test copy: the same words under a test heading, so its fingerprint —
  // and so every signature on it — can never be mistaken for the real one.
  const testText = canonicalise(`TEST COPY. Practice only. Test bitcoin has no value, and signing this commits you to nothing.\n\n${text}`);
  const t = crowdlockFile({
    name: `${name} — TEST`, about: `A test copy of ${name} on Bitcoin's test network, for practising with test money. Nothing here is real.`,
    disclaimer: "TEST ONLY. Test bitcoin has no value. Joining here does not make you a member of the real one.",
    title: `${title} — test copy`, declFile: "test/declaration.txt", declText: testText, network: "testnet4",
    minimumSats: 10000, cosigner: testCosignerPubkey, regDir: "test/",
  });
  files[`crowdlocks/${slug}-test.json`] = JSON.stringify(t, null, 2) + "\n";
  files["test/declaration.txt"] = testText;
  files["test/registrations.json"] = JSON.stringify(emptyRegister(t), null, 2) + "\n";
  files["test/destinations.json"] = JSON.stringify(emptyDestinations(t, today), null, 2) + "\n";
  crowdlocks.push({ c: t, text: testText, slug: `${slug}-test` });
  links.push({ label: "Test copy (test bitcoin)", url: `${siteBase}crowdlocks/${slug}-test.json`, declaration: `${siteBase}test/declaration.txt`, register: `${siteBase}test/registrations.json` });

  // Every Crowdlock made here passes exactly the checks the app and the
  // register page apply to anybody's, before anything is created.
  for (const { c, text: tx } of crowdlocks) {
    const fc = checkCrowdlock(c, { declarationText: tx });
    problems.push(...fc.problems);
    const regs = JSON.parse(files[c.register.registrations]);
    const dests = JSON.parse(files[c.register.destinations]);
    problems.push(...checkRegisterFiles(c, { registrations: regs, destinations: dests }).problems);
  }
  problems.push(...checkSeparate(crowdlocks.map((x) => x.c)).problems);
  if (problems.length) return { ok: false, problems };

  files["crowdlocks/index.json"] = JSON.stringify({ crowdlocks: crowdlocks.map((x) => x.slug) }, null, 2) + "\n";
  files["index.html"] = frontPage({ name, about, links });
  files["README.md"] = `# ${name}\n\n${about}\n\nA Crowdlock: nobody pools money, nobody receives anything financial in return, ever. Site: ${siteBase}\n`;
  Object.assign(files, template.files);

  return {
    ok: true, slug, files, links,
    fingerprints: crowdlocks.map((x) => ({ slug: x.slug, sha256: x.c.declaration.sha256, network: x.c.network })),
  };
}
