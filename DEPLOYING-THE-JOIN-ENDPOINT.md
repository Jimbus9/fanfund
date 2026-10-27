# Deploying the join endpoint

The endpoint is `functions/join.js`, deployed as a Cloudflare Pages Function.
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

`js/append.test.mjs` is the real test of this endpoint, because the judgement
lives in `js/append.mjs` and the network code around it is deliberately thin.
Nineteen checks, mostly refusals:

    node js/append.test.mjs

A signature for a different declaration, somebody else's signature claimed for
your address, half a signature, an address already on the register (including
in upper case, since bech32 is case-insensitive), a megabyte where an address
should be, a register file of the wrong shape. It also proves that a refusal
leaves the register byte-for-byte untouched.

## Step 1 — create the Pages project

1. **dash.cloudflare.com**, signed in.
2. Menu → **Workers & Pages** → **Create** → the **Pages** tab → **Connect to
   Git**.
3. Authorise GitHub. Cloudflare takes **read** access to the repository, which
   is public anyway.
4. Pick `Jimbus9/fanfund` → **Begin setup**.
5. Project name `kop-fund`, production branch `main`.
6. Framework preset **None**, build command **empty**, build output directory
   `/`.
7. **Save and Deploy.**

The repository is 52 files with no dependencies committed, so the deploy takes
seconds and publishes the site as it stands.

This creates a second copy of the site at `kop-fund.pages.dev`. The
`jimbus9.github.io/fanfund/` address remains the front door; the Cloudflare
copy exists because the endpoint has to live somewhere. Either tidy that up
later by moving hosting properly, or leave it.

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

In the `kop-fund` Pages project: **Settings** → **Environment variables** →
**Production** → **Add variable**.

- Name: `GITHUB_TOKEN`
- Value: the token
- **Encrypt it.** There is a button or checkbox for this; use it. Encrypted
  variables cannot be read back out of the dashboard afterwards.

**Do not paste the token into a chat, a document, or this repository.**

Then **Deployments** → **Retry deployment** on the latest one, so the function
starts with the variable present. A variable added after a deploy does not
reach the already-running one.

## Step 4 — check it

Visiting `kop-fund.pages.dev/join` in a browser should answer:

    { "error": "post an address and a signature" }

That is the endpoint refusing a GET, which means it is alive. If you get a
404, the function did not deploy. If you get the `503` about not being
configured, the variable did not reach it — retry the deployment.

## Step 5 — wire it into the join page

The page needs the endpoint's address. Tell me the `pages.dev` URL and I will
add the button, with the pull request route kept alongside it.

## Replacing the token later

Make a new token with the same settings, update the environment variable,
retry the deployment, then delete the old token on GitHub.

## If it is ever switched off

Nothing in the register is lost, because the register has never lived here. It
is read from GitHub on every request and written straight back, so GitHub
remains the single copy and this endpoint holds no state of its own.
