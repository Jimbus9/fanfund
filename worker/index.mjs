// The join endpoint.
//
// One job: take an address and a signature from the website, check the
// signature, and if it is good, add it to registrations.json in the
// repository. That is all. It holds no keys of the fund's, signs nothing,
// moves no money, and cannot create a member who did not sign — producing a
// signature is the one thing it cannot do.
//
// WHY A SERVER IS ACCEPTABLE HERE, which is the question worth asking of any
// piece of this project: look at what this one can actually do wrong. It can
// refuse somebody, delay somebody, or write rubbish into the register. Those
// are exactly the powers any publisher of a registration already has, and the
// design has always treated the publisher as untrusted — which is why the
// specification offers a second route that does not involve us at all. That
// route stays open. If this endpoint breaks, leaks its key, or is switched
// off, nobody is prevented from joining; they open a pull request instead.
//
// It deliberately does NOT hold a rate limit of its own. Cloudflare's own
// rate limiting sits in front of it and is configured in the dashboard, so
// the protection is not something we hand-rolled and can get wrong.

import { addRegistration } from "./append.mjs";
import { membershipStatement } from "../js/crowdlock.mjs";

const REPO = "Jimbus9/fanfund";
const BRANCH = "main";
const CROWDLOCK = "crowdlocks/kop-fund.json";
const REGISTER = "registrations.json";

// The site is the only page meant to post here. This is politeness to
// browsers, not a security boundary — anyone can post from anywhere, and the
// signature check is what actually matters.
const ALLOWED = ["https://jimbus9.github.io"];

const json = (status, body, origin) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": ALLOWED.includes(origin) ? origin : ALLOWED[0],
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      "cache-control": "no-store",
    },
  });

async function gh(env, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "kop-fund-join",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`github ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** A file's current text and its blob sha, which a write must quote back. */
async function readFile(env, path) {
  const meta = await gh(env, `contents/${path}?ref=${BRANCH}`);
  const text = new TextDecoder().decode(
    Uint8Array.from(atob(meta.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)),
  );
  return { text, sha: meta.sha };
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") ?? "";

    if (request.method === "OPTIONS") return json(204, {}, origin);
    if (request.method !== "POST") {
      return json(405, { error: "post an address and a signature" }, origin);
    }
    if (!env.GITHUB_TOKEN) {
      return json(503, { error: "the endpoint is not configured; open a pull request instead" }, origin);
    }

    let submission;
    try {
      submission = await request.json();
    } catch {
      return json(400, { error: "that was not JSON" }, origin);
    }

    let crowdlock, register, sha;
    try {
      crowdlock = JSON.parse((await readFile(env, CROWDLOCK)).text);
      const current = await readFile(env, REGISTER);
      register = JSON.parse(current.text);
      sha = current.sha;
    } catch (e) {
      // The register could not be read, so nothing was changed. Say so, and
      // point at the route that does not depend on us.
      return json(502, {
        error: "could not read the register just now — nothing was changed",
        alternative: `open a pull request adding your record to ${REGISTER}`,
      }, origin);
    }

    // The statement is rebuilt from the Crowdlock's own file on every request,
    // never trusted from the submission and never hard-coded here. If the
    // declaration ever changed, this endpoint would start verifying against
    // the new one without being redeployed.
    const statement = membershipStatement(crowdlock);

    if (register.declaration?.sha256 !== crowdlock.declaration.sha256) {
      return json(500, {
        error: "the register and the Crowdlock disagree about the declaration; refusing to write",
      }, origin);
    }

    const today = new Date().toISOString().slice(0, 10);
    const outcome = addRegistration(register, submission, { statement, today });
    if (!outcome.ok) return json(outcome.status, { error: outcome.reason }, origin);

    try {
      await gh(env, `contents/${REGISTER}`, {
        method: "PUT",
        body: JSON.stringify({
          message: `Member ${outcome.n}`,
          content: toBase64(JSON.stringify(outcome.register, null, 2) + "\n"),
          sha,          // refuses the write if the register changed meanwhile
          branch: BRANCH,
        }),
      });
    } catch (e) {
      return json(502, {
        error: "the signature is valid but the register could not be written just now",
        alternative: `open a pull request adding your record to ${REGISTER}`,
      }, origin);
    }

    return json(200, {
      ok: true,
      n: outcome.n,
      message: `You are member ${outcome.n}. The register will show you within a minute.`,
    }, origin);
  },
};
