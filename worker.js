// The site, plus the one endpoint it has.
//
// Everything here is static except two endpoints: POST /join/submit, which
// adds a signed registration, and POST /lock/submit, which adds a lock (see
// submitLock below). Any other request is handed straight to the static files,
// which Cloudflare serves without this code running at all.
//
// POST /join takes an address and a signature from the join page, checks the
// signature, and if it is good, adds it to registrations.json in the
// repository. That is all it does. It holds no key of the fund's, signs
// nothing, moves no money, and cannot create a member who did not sign:
// producing a signature is the one thing it cannot do.
//
// WHY A SERVER IS ACCEPTABLE HERE, which is the question worth asking of any
// part of this project — look at what this one can do wrong. It can refuse
// somebody, delay somebody, or write rubbish into the register. Those are
// exactly the powers any publisher of a registration already has, and the
// specification has always treated the publisher as untrusted, which is why
// it offers a second route involving nobody: open a pull request. That route
// stays open, and it is what makes this one safe to add. If this endpoint
// breaks, has its token stolen, or is switched off, nobody is prevented from
// joining — and every failure reply below says so.
//
// It holds no state. The register is read from GitHub on every request and
// written straight back, so GitHub stays the single copy of the truth and
// there is nothing here to go stale, leak, or disagree with what is
// published. It has no rate limit of its own either: Cloudflare's sits in
// front of it, maintained by people who do that for a living rather than
// hand-rolled here and got wrong.

import { addRegistration } from "./js/append.mjs";
import { prepareLock, addLock } from "./js/lockrecord.mjs";
import { membershipStatement } from "./js/crowdlock.mjs";

const REPO = "Jimbus9/fanfund";
const BRANCH = "main";
const CROWDLOCK = "crowdlocks/kop-fund.json";
const REGISTER = "registrations.json";

const json = (status, body) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // The join page served from here needs no permission. This is for the
      // github.io copy, which remains the front door.
      "access-control-allow-origin": "https://jimbus9.github.io",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });

async function gh(token, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "kop-fund-join",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`github ${path}: ${res.status}`);
  return res.json();
}

/** A file's current text, and the blob sha a write has to quote back. */
async function readFile(token, path) {
  const meta = await gh(token, `contents/${path}?ref=${BRANCH}`);
  const text = new TextDecoder().decode(
    Uint8Array.from(atob(meta.content.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
  );
  return { text, sha: meta.sha };
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function join(request, env) {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return json(503, {
      error: "the endpoint is not configured yet",
      alternative: `open a pull request adding your record to ${REGISTER}`,
    });
  }

  let submission;
  try {
    submission = await request.json();
  } catch {
    return json(400, { error: "that was not JSON" });
  }

  let crowdlock, register, sha;
  try {
    crowdlock = JSON.parse((await readFile(token, CROWDLOCK)).text);
    const current = await readFile(token, REGISTER);
    register = JSON.parse(current.text);
    sha = current.sha;
  } catch {
    return json(502, {
      error: "could not read the register just now — nothing was changed",
      alternative: `open a pull request adding your record to ${REGISTER}`,
    });
  }

  // Rebuilt from the Crowdlock's own file on every request, never taken from
  // the submission and never written in here. If the declaration ever
  // changed, this would start verifying against the new one with no redeploy.
  const statement = membershipStatement(crowdlock);

  if (register.declaration?.sha256 !== crowdlock.declaration.sha256) {
    return json(500, {
      error: "the register and the Crowdlock disagree about the declaration; refusing to write",
    });
  }

  const outcome = addRegistration(register, submission, {
    statement,
    today: new Date().toISOString().slice(0, 10),
  });
  if (!outcome.ok) return json(outcome.status, { error: outcome.reason });

  try {
    await gh(token, `contents/${REGISTER}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Member ${outcome.n}`,
        content: toBase64(JSON.stringify(outcome.register, null, 2) + "\n"),
        sha,        // refuses the write if the register changed in the meantime
        branch: BRANCH,
      }),
    });
  } catch {
    return json(502, {
      error: "your signature is valid but the register could not be written just now",
      alternative: `open a pull request adding your record to ${REGISTER}`,
    });
  }

  return json(200, {
    ok: true,
    n: outcome.n,
    message: `You are member ${outcome.n}. The register will show you within a minute.`,
  });
}

// POST /lock/submit — the same shape as joining, for a lock.
//
// A lock address hides its terms until it is spent, so its owner has to tell
// the register "this address is my lock, made from these two keys and this
// date". This rebuilds the address from those terms and publishes the lock
// only if it comes out identical, the owner is a member, and confirmed coins
// are already there. It can refuse a lock but cannot invent one: the terms,
// not this code, decide who can ever move the coins. The pull request route
// stays open, and every failure below says so.
async function submitLock(request, env) {
  const token = env.GITHUB_TOKEN;
  const alternative = `open a pull request adding your lock to ${REGISTER}`;
  if (!token) return json(503, { error: "the endpoint is not configured yet", alternative });

  let submission;
  try {
    submission = await request.json();
  } catch {
    return json(400, { error: "that was not JSON" });
  }

  let crowdlock, register, sha;
  try {
    crowdlock = JSON.parse((await readFile(token, CROWDLOCK)).text);
    const current = await readFile(token, REGISTER);
    register = JSON.parse(current.text);
    sha = current.sha;
  } catch {
    return json(502, { error: "could not read the register just now — nothing was changed", alternative });
  }

  const prepared = prepareLock(submission, {
    crowdlock, register, now: Math.floor(Date.now() / 1000),
  });
  if (!prepared.ok) return json(prepared.status, { error: prepared.reason });

  // The one fact taken from outside: confirmed coins at the address, read from
  // the chain source the Crowdlock itself names.
  let confirmedSats;
  try {
    const res = await fetch(`${crowdlock.chain_api}/address/${prepared.lock.address}`);
    if (!res.ok) throw new Error(String(res.status));
    const s = (await res.json()).chain_stats;
    confirmedSats = s.funded_txo_sum - s.spent_txo_sum;
  } catch {
    return json(502, { error: "could not read the blockchain just now — nothing was changed", alternative });
  }

  const outcome = addLock(register, prepared.lock, {
    confirmedSats, today: new Date().toISOString().slice(0, 10),
  });
  if (!outcome.ok) return json(outcome.status, { error: outcome.reason });

  const n = register.members.find((m) => m.address === prepared.lock.member)?.n;
  try {
    await gh(token, `contents/${REGISTER}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Lock for member ${n}`,
        content: toBase64(JSON.stringify(outcome.register, null, 2) + "\n"),
        sha,        // refuses the write if the register changed in the meantime
        branch: BRANCH,
      }),
    });
  } catch {
    return json(502, { error: "your lock is genuine but the register could not be written just now", alternative });
  }

  return json(200, {
    ok: true,
    address: prepared.lock.address,
    unlocks: prepared.lock.unlocks,
    message: "Your lock is on the register. It will appear within a minute.",
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // The endpoint has its own path, separate from /join, which is the join
    // PAGE and an ordinary static file. One path, one job.
    if (pathname === "/join/submit") {
      if (request.method === "POST") return join(request, env);
      if (request.method === "OPTIONS") return json(204, {});
      return json(405, { error: "post an address and a signature" });
    }

    if (pathname === "/lock/submit") {
      if (request.method === "POST") return submitLock(request, env);
      if (request.method === "OPTIONS") return json(204, {});
      return json(405, { error: "post a lock's owner key, co-signer key and locktime" });
    }

    return env.ASSETS.fetch(request);
  },
};
