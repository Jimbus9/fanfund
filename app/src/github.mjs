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

  let head;
  for (let i = 0; i < 10 && !head; i++) {
    try { head = await gh("GET", `/repos/${owner}/${repoName}/git/ref/heads/main`); }
    catch (e) { if (e.status !== 404 && e.status !== 409) throw e; await sleep(1500); }
  }
  if (!head) throw new Error("GitHub made the repository but it isn't ready yet — try again in a minute");
  const baseCommit = await gh("GET", `/repos/${owner}/${repoName}/git/commits/${head.object.sha}`);

  progress("Writing the declaration, register and inbox");
  const tree = await gh("POST", `/repos/${owner}/${repoName}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
  });
  const commit = await gh("POST", `/repos/${owner}/${repoName}/git/commits`, {
    message: "Start this Crowdlock\n\nSet up by the Crowdlock app: the declaration, an empty register, a plain front page, and the relay inbox that collects members' registrations and locks.",
    tree: tree.sha, parents: [head.object.sha],
  });
  await gh("PATCH", `/repos/${owner}/${repoName}/git/refs/heads/main`, { sha: commit.sha });

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
