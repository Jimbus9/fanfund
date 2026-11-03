// Loading and checking Crowdlocks. Network code only: nothing here sees a key.
//
// The app has no Crowdlock written into it. It starts from a list of links,
// and a fan can add any other Crowdlock by pasting a link to its file, hosted
// anywhere. Whether from the starting list or pasted in, every Crowdlock is
// checked here with exactly the code the register page uses (method/js/crowdlock.mjs)
// before the app will show it or let anybody sign anything:
//
//   * the file is complete and coherent
//   * its declaration really hashes to the fingerprint the file claims
//   * its register files agree with it about which declaration they are
//
// A Crowdlock that fails is refused, with the reason shown. So the starting
// list is a convenience, not a permission: we decide nothing about which
// Crowdlocks exist.
//
// WHERE A CROWDLOCK'S OTHER FILES ARE. A Crowdlock file is published at
// <site>/crowdlocks/<name>.json, and the paths inside it (declaration, register)
// are relative to <site>/ — that is how this project's own files are laid out.
// A file published anywhere else has its paths read relative to its own folder.

import { checkCrowdlock, checkRegisterFiles, membershipStatement } from "../../method/js/crowdlock.mjs";
import { esploraChain } from "./wallet/esplora.mjs";
import { earlyReleases } from "../../method/js/release.mjs";
import { checkCosignerXpubs } from "./wallet/core.mjs";

// This build's starting list and counting-rule link live in ./build.mjs, the
// one file that differs between builds of the app.
export { STARTING_LIST, COUNTING_RULE_URL } from "./build.mjs";

// Links are handled as plain text rather than with URL objects: a phone's
// JavaScript engine has an incomplete URL implementation, and these few rules
// are all that is needed.
const LINK = /^https:\/\/[^\s/?#]+\/[^\s]*$/;
const stripQuery = (u) => u.split(/[?#]/)[0];

/** Where a Crowdlock file's relative paths start from. */
export function baseFor(fileUrl) {
  const u = stripQuery(fileUrl);
  const i = u.lastIndexOf("/crowdlocks/");
  return i >= 0 ? u.slice(0, i + 1) : u.slice(0, u.lastIndexOf("/") + 1);
}

/** A path from inside a Crowdlock file, as a full link. */
export function resolvePath(path, base) {
  const p = String(path ?? "");
  if (/^https:\/\//.test(p)) return p;
  if (p.includes("..") || p.startsWith("/")) throw new Error(`refusing the path ${p}`);
  return base + p;
}

/**
 * Load a Crowdlock from a link and check it. Never throws: returns
 * { ok: true, url, crowdlock, statement, register } or { ok: false, url, problems }.
 *
 * @returns {Promise<{ ok: true, url: string, crowdlock: any, declarationText: string, statement: string, register: any }
 *                 | { ok: false, url: string, problems: string[] }>}
 */
export async function loadCrowdlock(url, fetchImpl = globalThis.fetch) {
  const fail = (...problems) => ({ ok: false, url, problems });
  const fileUrl = String(url ?? "").trim();
  if (/^http:\/\//i.test(fileUrl)) return fail("a Crowdlock link must start with https://");
  if (!LINK.test(fileUrl)) return fail("that is not a link");

  const getJson = async (u) => { const r = await fetchImpl(u, { cache: "no-store" }); if (!r.ok) throw new Error(`${r.status} from ${u}`); return r.json(); };
  const getText = async (u) => { const r = await fetchImpl(u, { cache: "no-store" }); if (!r.ok) throw new Error(`${r.status} from ${u}`); return r.text(); };

  let crowdlock;
  try { crowdlock = await getJson(fileUrl); }
  catch (e) {
    return fail(String(e.message).startsWith("404 ")
      ? "There's no Crowdlock file at that link. Check it was copied in full."
      : `could not load the Crowdlock file: ${e.message}`);
  }

  const base = baseFor(fileUrl);
  let declarationText;
  try { declarationText = await getText(resolvePath(crowdlock?.declaration?.file, base)); }
  catch (e) { return fail(`could not load its declaration: ${e.message}`); }

  const fileCheck = checkCrowdlock(crowdlock, { declarationText });
  // An xpub that doesn't stand for one of its co-signer keys would have a
  // hardware wallet build a lock the register never counts.
  if (fileCheck.ok) { const xc = checkCosignerXpubs(crowdlock); if (!xc.ok) return fail(...xc.problems); }
  if (!fileCheck.ok) return fail(...fileCheck.problems);

  let registrations, destinations;
  try {
    registrations = await getJson(resolvePath(crowdlock.register.registrations, base));
    destinations = await getJson(resolvePath(crowdlock.register.destinations, base));
  } catch (e) { return fail(`could not load its register: ${e.message}`); }

  const agree = checkRegisterFiles(crowdlock, { registrations, destinations });
  if (!agree.ok) return fail(...agree.problems);

  return {
    ok: true,
    url: fileUrl,
    crowdlock,
    declarationText,
    statement: membershipStatement(crowdlock),
    register: registrations,
    destinations,
  };
}

// ---------------------------------------------------------------------------
// Sharing a Crowdlock
//
// crowdlock://add?url=<the Crowdlock file's link> opens this app straight onto
// that Crowdlock, checked like any other before it is shown. A phone's own
// camera reads it from a QR code; a web page can use it as a button. It only
// ever carries a link — the app decides nothing from it but where to look.
// ---------------------------------------------------------------------------

/** The app link that opens a Crowdlock in the app. */
export function openLinkFor(fileUrl) {
  return `crowdlock://add?url=${encodeURIComponent(fileUrl)}`;
}

/** The Crowdlock file link inside an app link, or null if it isn't one. */
export function fileUrlFromOpenLink(link) {
  const m = /^crowdlock:\/\/add\?url=([^&#\s]+)/i.exec(String(link ?? "").trim());
  if (!m) return null;
  let u;
  try { u = decodeURIComponent(m[1]); } catch { return null; }
  return LINK.test(u) ? u : null;
}

/** Where to send people when sharing: the Crowdlock's own page if it names one, else its site. */
export function shareLinkFor(loaded) {
  const site = loaded.crowdlock?.site;
  return typeof site === "string" && /^https:\/\//.test(site) ? site : baseFor(loaded.url);
}

/** Is this address a member, and which number? */
export function membershipOf(register, address) {
  const a = String(address).toLowerCase();
  return (register.members ?? []).find((m) => String(m.address).toLowerCase() === a) ?? null;
}

/**
 * The committed total, by the counting rule: confirmed coins at every lock
 * whose date is still ahead and which meets the minimum. Read from the
 * Crowdlock's own chain source, never from anything the register claims.
 *
 * The only count of people it gives is committed members: members holding at
 * least one lock that counts. A count of signatures is never shown, because a
 * signature costs nothing to make; anyone who wants that number can count the
 * published register.
 */
export async function committedTotal(loaded, fetchImpl = globalThis.fetch, now = Math.floor(Date.now() / 1000)) {
  const { crowdlock, register } = loaded;
  const chain = esploraChain(crowdlock.chain_api, fetchImpl);
  const seen = new Set();
  const committed = new Set();
  let sats = 0n, counted = 0;
  for (const lock of register.locks ?? []) {
    const address = String(lock.address).toLowerCase();
    if (seen.has(address) || !(lock.locktime > now)) continue;
    seen.add(address);
    const coins = (await chain.utxos(lock.address)).filter((c) => c.confirmed);
    const total = coins.reduce((s, c) => s + BigInt(c.value), 0n);
    if (total >= BigInt(crowdlock.minimum_counted_lock_sats)) {
      sats += total; counted++;
      if (lock.member) committed.add(String(lock.member).toLowerCase());
    }
  }
  return { sats, locks: counted, members: committed.size };
}

/**
 * The co-signer's record: every lock on the register that the co-signer helped
 * open before its date, other than to pay a listed destination. Read from the
 * chain alone, so nobody — the co-signer included — can keep one off it.
 * Returns { releases: [{ address, member, txid, at, sats, paidTo, confirmed, cosigner }], unreadable }.
 */
export async function coSignerRecord(loaded, fetchImpl = globalThis.fetch, now = Math.floor(Date.now() / 1000)) {
  const { crowdlock, register, destinations } = loaded;
  const chain = esploraChain(crowdlock.chain_api, fetchImpl);
  const seen = new Set();
  const releases = [];
  let unreadable = 0;
  for (const lock of register.locks ?? []) {
    const address = String(lock.address).toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    try {
      for (const r of earlyReleases(lock, await chain.txs(lock.address), destinations ?? null, now)) {
        releases.push({ address: lock.address, member: lock.member ?? null, ...r });
      }
    } catch { unreadable++; }
  }
  return { releases, unreadable };
}

/**
 * The Crowdlock counting rule, where it explains the minimum. The rule is one
 * of the method's general documents, the same for every Crowdlock; only the
 * minimum's size is each Crowdlock's own (minimum_counted_lock_sats).
 */

/**
 * Pounds per bitcoin right now, for an indicative figure only — never a
 * headline, never stored. Real bitcoin only: test coins have no value.
 * Returns a number, or null if there is no honest figure to give.
 */
export async function poundsPerBtc(crowdlock, fetchImpl = globalThis.fetch) {
  if (crowdlock.network !== "mainnet") return null;
  try {
    const r = await fetchImpl(`${crowdlock.chain_api}/v1/prices`, { cache: "no-store" });
    const gbp = (await r.json()).GBP;
    return typeof gbp === "number" && gbp > 0 ? gbp : null;
  } catch { return null; }
}

/** "0.002 BTC" — a minimum written without the trailing zeros. */
export function shortBtc(sats) {
  const v = BigInt(sats);
  const frac = (v % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${v / 100000000n}${frac ? "." + frac : ""} BTC`;
}

/** This member's locks on the register, as the app's lock terms. */
export function locksOnRegister(register, memberAddress) {
  const a = String(memberAddress).toLowerCase();
  return (register.locks ?? [])
    .filter((l) => String(l.member).toLowerCase() === a)
    .map((l) => ({ address: l.address, locktime: l.locktime, cosignerPubkey: l.cosigner_pubkey }));
}

/**
 * Put a lock on the Crowdlock's register, through its lock endpoint. Needs the
 * lock's money to have confirmed. Returns { ok: true } or { ok: false, error }.
 * "Already on the register" counts as success.
 */
export async function submitLock(crowdlock, { ownerPubkey, cosignerPubkey, locktime, address }, fetchImpl = globalThis.fetch) {
  if (!crowdlock.lock_endpoint) {
    return { ok: false, error: "this Crowdlock has no lock endpoint — submit the lock by pull request instead" };
  }
  try {
    const res = await fetchImpl(crowdlock.lock_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner_pubkey: ownerPubkey, cosigner_pubkey: cosignerPubkey, locktime, address }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { ok: true };
    if (res.status === 409 && /already on the register/.test(body.error ?? "")) return { ok: true };
    return { ok: false, error: body.error ?? `the register answered ${res.status}` };
  } catch {
    return { ok: false, error: "could not reach the register — the lock is safe, it will be tried again" };
  }
}

/**
 * Send a signed registration to the Crowdlock's join endpoint.
 * Returns { ok: true, n } or { ok: false, error }.
 */
export async function submitJoin(crowdlock, { address, signature }, fetchImpl = globalThis.fetch) {
  if (!crowdlock.join_endpoint) {
    return { ok: false, error: "this Crowdlock has no join endpoint — submit your registration by pull request instead" };
  }
  try {
    const res = await fetchImpl(crowdlock.join_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, signature }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { ok: true, n: body.n };
    return { ok: false, error: body.error ?? `the register answered ${res.status}`, alternative: body.alternative };
  } catch {
    return { ok: false, error: "could not reach the register — your signature is fine, try again in a moment" };
  }
}

/**
 * Order found Crowdlocks the way the register counts: committed bitcoin
 * first, then committed members, then name. Neither can be faked by
 * announcing, so a flood of junk announcements sinks to the bottom.
 */
export function rankFound(items) {
  return [...items].sort((a, b) =>
    (b.sats > a.sats ? 1 : b.sats < a.sats ? -1 : 0) || (b.members - a.members) || String(a.name).localeCompare(String(b.name)));
}

/** Does a found Crowdlock match what was typed in the search box? */
export function matchesSearch(item, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  return `${item.name} ${item.about ?? ""}`.toLowerCase().includes(q);
}

/**
 * The GitHub repository behind a Crowdlock published on GitHub Pages, from
 * its file's link — or null if it isn't hosted that way.
 */
/**
 * The co-signer key new locks name: the newest in the list. Older keys stay
 * listed so the locks already naming them keep counting.
 */
export function newestCosigner(crowdlock) {
  const keys = crowdlock?.cosigner_keys ?? [];
  return keys.length ? keys[keys.length - 1] : undefined;
}

/**
 * What changed in a Crowdlock's co-signer keys since this phone last looked.
 * `seen` is the list it saw then, or null the first time (nothing to compare,
 * so nothing to warn about). Compared on the x-coordinate, as the checks are.
 */
export function keyChanges(seen, now, expected = []) {
  if (!Array.isArray(seen)) return { added: [], removed: [], changed: false };
  const x = (list) => new Set((list ?? []).map((k) => String(k).toLowerCase().slice(2)));
  // `expected` is a key this phone added itself: no warning when it appears,
  // and none while the website hasn't caught up with it yet either.
  const before = x([...seen, ...(expected ?? [])]), after = x(now);
  const added = (now ?? []).filter((k) => !before.has(String(k).toLowerCase().slice(2)));
  const removed = seen.filter((k) => !after.has(String(k).toLowerCase().slice(2)));
  return { added, removed, changed: added.length + removed.length > 0 };
}

/** The public history of a Crowdlock's file on GitHub, where any key change shows who made it. */
export function historyLinkFor(fileUrl) {
  const where = repoFromFileUrl(fileUrl), path = pathInRepo(fileUrl);
  return where && path ? `https://github.com/${where.owner}/${where.repo}/commits/main/${path}` : null;
}

/** Where a Crowdlock's file sits inside its repository, from its link. */
export function pathInRepo(fileUrl) {
  const m = /^https:\/\/[a-z0-9-]+\.github\.io\/[A-Za-z0-9._-]+\/(.+)$/i.exec(String(fileUrl ?? ""));
  return m ? decodeURIComponent(m[1].split(/[?#]/)[0]) : null;
}

export function repoFromFileUrl(fileUrl) {
  const m = /^https:\/\/([a-z0-9-]+)\.github\.io\/([A-Za-z0-9._-]+)\//i.exec(String(fileUrl ?? ""));
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * What a Crowdlock's published inbox version means, given the app's.
 *   "source"   The Crowdlock method's reference repository, where this code is written — never offered an update
 *   "current"  up to date
 *   "behind"   an update is available
 *   "unknown"  not made by the app
 * `published` is the text of its method/relay/VERSION, or null if there is none.
 */
export function versionStatus(published, appVersion, hasInbox) {
  const v = typeof published === "string" ? published.trim() : null;
  if (v === "source") return "source";
  if (v === null) return hasInbox ? "behind" : "unknown";   // made before versions existed
  return v >= appVersion ? "current" : "behind";
}

/** The changes a Crowdlock on `published` would get by updating. */
export function changesSince(published, changes) {
  const v = typeof published === "string" ? published.trim() : "";
  return changes.filter((c) => c.version > v);
}
