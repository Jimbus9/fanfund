// Loading and checking Crowdlocks. Network code only: nothing here sees a key.
//
// The app has no Crowdlock written into it. It starts from a list of links,
// and a fan can add any other Crowdlock by pasting a link to its file, hosted
// anywhere. Whether from the starting list or pasted in, every Crowdlock is
// checked here with exactly the code the register page uses (js/crowdlock.mjs)
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

import { checkCrowdlock, checkRegisterFiles, membershipStatement } from "../../js/crowdlock.mjs";
import { esploraChain } from "./wallet/esplora.mjs";

/** The links the app starts with. Anything else can be added by the fan. */
export const STARTING_LIST = [
  "https://jimbus9.github.io/fanfund/crowdlocks/kop-fund.json",
  "https://jimbus9.github.io/fanfund/crowdlocks/kop-fund-testnet4.json",
];

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
  };
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
 * The Crowdlock counting rule, where it explains the minimum. The rule is one
 * of the method's general documents, the same for every Crowdlock; only the
 * minimum's size is each Crowdlock's own (minimum_counted_lock_sats).
 */
export const COUNTING_RULE_URL = "https://github.com/Jimbus9/fanfund/blob/main/spec/counting-rule.md#the-minimum";

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
