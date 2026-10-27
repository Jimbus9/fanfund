// POST /join — the one endpoint this project has.
//
// It takes an address and a signature from the join page, checks the
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
// joining.
//
// It holds no state. The register is read from GitHub on every request and
// written straight back, so GitHub stays the single copy of the truth and
// there is nothing here to go stale, leak, or disagree with what is published.
//
// It has no rate limit of its own either. Cloudflare's own rate limiting sits
// in front of it, maintained by people who do that for a living rather than
// hand-rolled here and got wrong.

import { addRegistration } from "../js/append.mjs";
import { membershipStatement } from "../js/crowdlock.mjs";

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
      // The join page is served from this same site, so no cross-origin
      // permission is needed for it. This allows the github.io copy to post
      // here too, while that remains the front door.
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

export async function onRequestOptions() {
  return json(204, {});
}

export async function onRequestPost({ request, env }) {
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
    // Nothing was changed, so say so and point at the route that does not
    // depend on us.
    return json(502, {
      error: "could not read the register just now — nothing was changed",
      alternative: `open a pull request adding your record to ${REGISTER}`,
    });
  }

  // The statement is rebuilt from the Crowdlock's own file on every request,
  // never taken from the submission and never written in here. If the
  // declaration ever changed, this would start verifying against the new one
  // with no redeployment.
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

// A GET here is somebody poking at it, or a mis-wired page.
export async function onRequestGet() {
  return json(405, { error: "post an address and a signature" });
}
