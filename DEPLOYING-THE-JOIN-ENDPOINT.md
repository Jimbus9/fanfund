# Deploying the join endpoint

The endpoint is `worker.js`, deployed as a Cloudflare Worker serving the site alongside it.
Every step is done in a browser — there is no command line, which means it can
be done from a phone.

It does one thing: take an address and a signature from the join page, check
the signature, and if it is good, add it to `registrations.json`. It holds no
key of the fund's, signs nothing and moves no money.

## Why a server is acceptable here

Ask of any part of this project what the piece can do wrong. This one can
refuse somebody, delay somebody, or write rubbish into the register. It cannot
forge a signature, alter one, or add a member who did not sign — producing a
signature is the one thing it cannot do.

Those are exactly the powers any publisher of a registration already has, and
the specification has always treated the publisher as untrusted. That is why
`registration-format.md` offers a second route involving nobody at all: *"Open
a pull request adding your entry to registrations.json."*

**That route stays open, and it is what makes this one safe to add.** If this
endpoint breaks, has its token stolen, or is switched off, nobody is prevented
from joining. The endpoint itself says so when it cannot work: every failure
reply names the pull request route.

## What it refuses

`js/append.test.mjs` is the real test of what this endpoint will accept, because the judgement
lives in `js/append.mjs` and the network code around it is deliberately thin.
Nineteen checks, mostly refusals:

    node js/append.test.mjs

A signature for a different declaration, somebody else's signature claimed for
your address, half a signature, an address already on the register (including
in upper case, since bech32 is case-insensitive), a megabyte where an address
should be, a register file of the wrong shape. It also proves that a refusal
leaves the register byte-for-byte untouched.

## Step 1 — connect the repository

In the Cloudflare dashboard: **Workers & Pages** → **Create** → import
`Jimbus9/fanfund` from GitHub. Cloudflare takes **read** access to the
repository, which is public anyway. Project name `kop-fund`, branch `main`,
deploy command `npx wrangler deploy`.

`wrangler.jsonc` in the repository supplies the rest, so the dashboard's own
build settings barely matter.

**The first attempt at this failed**, and the reason is worth keeping. The
build runs `npx wrangler deploy`, which installs wrangler into the build
folder before publishing — and the publisher then tried to serve its own
tooling as part of the website, stopping on a 137 MB binary. `.assetsignore`
is what prevents that. `js/worker.test.mjs` checks it, so the same failure
cannot come back quietly.

This creates a second copy of the site at `kop-fund.<something>.workers.dev`.
The `jimbus9.github.io/fanfund/` address remains the front door; the
Cloudflare copy exists because the endpoint has to live somewhere. Either
tidy that up later by moving hosting properly, or leave it.

## Step 2 — make the GitHub token, at this point and not before

A token with write access to the repository sitting in a notepad for a week is
worse than no token. Make it when you are about to paste it in.

On GitHub: avatar → **Settings** → **Developer settings** (bottom of the left
menu) → **Personal access tokens** → **Fine-grained tokens** → **Generate new
token**.

| Field | Value |
| --- | --- |
| Token name | `kop-fund-join` |
| Expiration | 90 days — put a reminder in the calendar to replace it |
| Resource owner | your own account |
| Repository access | **Only select repositories** → `Jimbus9/fanfund` |
| Permissions → Repository → Contents | **Read and write** |

Nothing else. Not "All repositories", and no second permission. If this token
leaks, the whole of its power is editing files in one public repository, where
every change is visible and reversible.

Copy it once. GitHub will not show it again.

## Step 3 — give it to Cloudflare and nobody else

In the `kop-fund` project: **Settings** → **Variables and Secrets** → **Add**.

- Type: **Secret** (not plain text). A secret cannot be read back out of the
  dashboard afterwards.
- Name: `GITHUB_TOKEN`
- Value: the token

**Do not paste the token into a chat, a document, or this repository.**

Then redeploy, so the endpoint starts with the secret present. A secret added
after a deployment does not reach the one already running.

## Step 4 — check it

Visiting `/join/submit` on the workers.dev address should answer:

    { "error": "post an address and a signature" }

That is the endpoint refusing a GET, which means it is alive. A 404 means the
Worker did not deploy. The `503` about not being configured means the secret
did not reach it — redeploy.

`/join/` on the same address should show the ordinary join page, because the
endpoint has its own path and the page is a static file.

## Step 5 — wire it into the join page

The page needs the endpoint's address. Tell me the `workers.dev` URL and I
will add the button, with the pull request route kept alongside it.

## Replacing the token later

Make a new token with the same settings, update the secret, redeploy, then
delete the old token on GitHub.

## If it is ever switched off

Nothing in the register is lost, because the register has never lived here. It
is read from GitHub on every request and written straight back, so GitHub
remains the single copy and this endpoint holds no state of its own.
