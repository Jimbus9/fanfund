import { Buffer } from "buffer";
// Setting up a founder's Crowdlock in their own GitHub account. Network code
// only: no bitcoin key passes through here.
//
// Sign-in is GitHub's device flow: the app shows a short code, the founder
// enters it at github.com/login/device in any browser and allows "Crowdlock",
// and GitHub hands this phone a permission that lasts a few hours. No server
// of ours is involved and no secret is needed. The permission is used for the
// minute it takes to create the repository, kept in memory only, and never
// saved.

export const CLIENT_ID = "Ov23li5lTD1JhdYTsd63";
// public_repo: create a public repository and write its files and site.
// workflow: write the relay inbox's job file, which GitHub guards separately.
export const SCOPES = "public_repo workflow";

const API = "https://api.github.com";

/** Ask GitHub for a sign-in code. Returns { userCode, verificationUri, deviceCode, interval, expiresIn }. */
export async function startSignIn(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPES }),
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok || !b.device_code) throw new Error(b.error_description ?? "GitHub didn't give a sign-in code — try again in a moment");
  return { userCode: b.user_code, verificationUri: b.verification_uri, deviceCode: b.device_code, interval: b.interval ?? 5, expiresIn: b.expires_in ?? 900 };
}

/**
 * Wait for the founder to allow the app. Resolves with the access token, or
 * throws if they decline or the code expires. `sleep` is injectable for tests.
 */
export async function waitForSignIn({ deviceCode, interval, expiresIn }, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let wait = interval;
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(wait * 1000);
    const res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const b = await res.json().catch(() => ({}));
    if (b.access_token) return b.access_token;
    if (b.error === "authorization_pending") continue;
    if (b.error === "slow_down") { wait = (b.interval ?? wait + 5); continue; }
    if (b.error === "access_denied") throw new Error("You chose not to allow Crowdlock on GitHub, so nothing was created.");
    if (b.error === "expired_token") break;
    throw new Error(b.error_description ?? "GitHub refused the sign-in");
  }
  throw new Error("The sign-in code ran out. Start again for a new one.");
}

function client(token, fetchImpl) {
  return async (method, path, body, ok = [200, 201, 204]) => {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (!ok.includes(res.status)) {
      const e = new Error(json?.message ?? `GitHub answered ${res.status}`);
      e.status = res.status; e.body = json;
      throw e;
    }
    return json;
  };
}

/** Who is signed in, and is a repository of this name free? */
export async function whoAmI(token, repoName, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const me = await gh("GET", "/user");
  let taken = true;
  try { await gh("GET", `/repos/${me.login}/${repoName}`); } catch (e) { if (e.status === 404) taken = false; else throw e; }
  return { login: me.login, taken };
}

/** Write files to a repository's main branch as one commit. Returns the commit's sha. */
async function commitFiles(gh, owner, repo, files, message) {
  const head = await gh("GET", `/repos/${owner}/${repo}/git/ref/heads/main`);
  const base = await gh("GET", `/repos/${owner}/${repo}/git/commits/${head.object.sha}`);
  const tree = await gh("POST", `/repos/${owner}/${repo}/git/trees`, {
    base_tree: base.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
  });
  const commit = await gh("POST", `/repos/${owner}/${repo}/git/commits`, { message, tree: tree.sha, parents: [head.object.sha] });
  await gh("PATCH", `/repos/${owner}/${repo}/git/refs/heads/main`, { sha: commit.sha });
  return commit.sha;
}

/**
 * Create the Crowdlock: a public repository in the founder's account holding
 * every file, in one commit; its site switched on; its relay inbox started.
 * `files` is { path: text }. `progress(step)` is told each step as it starts.
 * Returns { owner, repo, siteBase, repoUrl }.
 */
export async function createCrowdlockRepo({ token, repoName, description, files, progress = () => {} }, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const gh = client(token, fetchImpl);
  const me = await gh("GET", "/user");
  const owner = me.login;

  progress("Creating the repository in your account");
  // auto_init gives the repository its first commit, which GitHub needs before
  // files can be added in one go.
  await gh("POST", "/user/repos", { name: repoName, description, private: false, auto_init: true, has_wiki: false, has_projects: false });

  let ready = false;
  for (let i = 0; i < 10 && !ready; i++) {
    try { await gh("GET", `/repos/${owner}/${repoName}/git/ref/heads/main`); ready = true; }
    catch (e) { if (e.status !== 404 && e.status !== 409) throw e; await sleep(1500); }
  }
  if (!ready) throw new Error("GitHub made the repository but it isn't ready yet — try again in a minute");

  progress("Writing the declaration, register and inbox");
  await commitFiles(gh, owner, repoName, files,
    "Start this Crowdlock\n\nSet up by the Crowdlock app: the declaration, an empty register, a plain front page, and the relay inbox that collects members' registrations and locks.");

  progress("Switching on its website");
  try { await gh("POST", `/repos/${owner}/${repoName}/pages`, { source: { branch: "main", path: "/" } }); }
  catch (e) { if (e.status !== 409) throw e; }   // 409: already on

  progress("Starting its relay inbox");
  let started = false;
  for (let i = 0; i < 6 && !started; i++) {
    try { await gh("POST", `/repos/${owner}/${repoName}/actions/workflows/relay-inbox.yml/dispatches`, { ref: "main" }); started = true; }
    catch (e) { if (e.status !== 404 && e.status !== 422) throw e; await sleep(3000); }   // the job file can take a moment to register
  }

  return {
    owner, repo: repoName, inboxStarted: started,
    siteBase: `https://${owner.toLowerCase()}.github.io/${repoName}/`,
    repoUrl: `https://github.com/${owner}/${repoName}`,
  };
}

// ---------------------------------------------------------------------------
// Looking after a Crowdlock: updates and maintainers
//
// Only people GitHub lets write to the repository — its founder and the
// maintainers they add — can do either. Nobody else's sign-in can, and the
// app does not pretend otherwise.
// ---------------------------------------------------------------------------

/** Can the signed-in person write to this repository? */
export async function canWrite(token, owner, repo, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  try {
    const r = await gh("GET", `/repos/${owner}/${repo}`);
    return !!(r.permissions?.push || r.permissions?.admin || r.permissions?.maintain);
  } catch (e) { if (e.status === 404) return false; throw e; }
}

/**
 * Bring a Crowdlock's inbox up to date: the template's files written in one
 * commit whose message lists what changed. The Crowdlock's own files — its
 * declaration, register and settings — are never touched.
 */
export async function updateCrowdlockRepo({ token, owner, repo, files, message }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const sha = await commitFiles(gh, owner, repo, files, message);
  // Restart the inbox on the new code; if it is mid-run, it picks the new code
  // up at its next run anyway.
  try { await gh("POST", `/repos/${owner}/${repo}/actions/workflows/relay-inbox.yml/dispatches`, { ref: "main" }); } catch {}
  return sha;
}

/**
 * Invite someone to be a maintainer. GitHub emails them; they accept. Returns
 * "invited", or "already" if they already have access.
 */
export async function addMaintainer({ token, owner, repo, username }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const who = String(username ?? "").trim().replace(/^@/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(who)) throw new Error("That isn't a GitHub username — it's letters, numbers and dashes, like the name in their profile's address");
  try { await gh("GET", `/users/${who}`); } catch (e) { if (e.status === 404) throw new Error(`There's no GitHub account called ${who} — check the spelling with them`); throw e; }
  let res;
  try { res = await gh("PUT", `/repos/${owner}/${repo}/collaborators/${who}`, { permission: "push" }, [201, 204]); }
  catch (e) {
    if (e.status === 403 || e.status === 404 || e.status === 422) {
      throw new Error(`GitHub didn't let the app add ${who} (${e.message}). You can do it on github.com instead: open github.com/${owner}/${repo}, then Settings → Collaborators → Add people, and type ${who}.`);
    }
    throw e;
  }
  return res ? "invited" : "already";
}

// Signed in for this session only: kept in memory, never saved, and GitHub
// ends it by itself within hours. Saves a founder typing a code twice in a row.
let session = null;
/**
 * Add a co-signer key to a Crowdlock that already exists, alongside the keys it
 * has. Never removes one: a lock names its co-signer inside its address, so
 * removing a key would stop every lock naming it from being counted. Reads the
 * file from the repository itself (not the website, which can lag), adds the
 * key at the end — the newest key is the one new locks use — and commits.
 * `check(file)` is run on the result and must return { ok, problems }.
 */
export async function addCosignerKey({ token, owner, repo, path, key, check }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const got = await gh("GET", `/repos/${owner}/${repo}/contents/${path}`);
  const c = JSON.parse(Buffer.from(String(got.content).replace(/\s/g, ""), "base64").toString("utf8"));
  const k = String(key).trim().toLowerCase();
  const keys = Array.isArray(c.cosigner_keys) ? c.cosigner_keys : [];
  if (keys.some((x) => x.slice(2) === k.slice(2))) throw new Error("This Crowdlock already has that co-signer key.");
  const next = { ...c, cosigner_keys: [...keys, k] };
  const r = check ? check(next) : { ok: true };
  if (!r.ok) throw new Error(`That would break the Crowdlock file: ${r.problems.join("; ")}`);
  const sha = await commitFiles(gh, owner, repo, { [path]: JSON.stringify(next, null, 2) + "\n" },
    `Add a co-signer key to ${c.name ?? path}\n\nAdded from the Crowdlock app by its founder or a maintainer. The key is added alongside the ${keys.length} already there, none removed, so every existing lock still counts. New locks use this key.`);
  return { sha, keys: next.cosigner_keys };
}

export function rememberSignIn(token) { session = { token, until: Date.now() + 60 * 60 * 1000 }; }
export function currentSignIn() { return session && session.until > Date.now() ? session.token : null; }
