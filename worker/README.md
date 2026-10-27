# The join endpoint

**Not deployed yet.** The code is here and tested; these are the steps to put
it live.

It does one thing: take an address and a signature from the website, check the
signature, and if it is good, add it to `registrations.json`. It holds no key
of the fund's, signs nothing, and moves no money.

## Why a server is acceptable here

Ask of any part of this project what the piece can do wrong. This one can
refuse somebody, delay somebody, or write rubbish into the register. It cannot
forge a signature, alter one, or add a member who did not sign — producing a
signature is the one thing it cannot do.

Those are exactly the powers any publisher of a registration already has, and
the specification has always treated the publisher as untrusted. That is why
`registration-format.md` offers a second route that involves nobody: *"Open a
pull request adding your entry to registrations.json."*

**That route stays open, and it is what makes this one safe to add.** If this
endpoint breaks, has its token stolen, or is switched off, nobody is prevented
from joining.

## What it refuses

`worker/append.test.mjs` is the real test of this endpoint, because the
judgement lives in `append.mjs` and the network code around it is deliberately
thin. Nineteen checks, mostly refusals:

    node worker/append.test.mjs

A signature for a different declaration, somebody else's signature claimed for
your address, half a signature, an address already on the register (including
in upper case, since bech32 is case-insensitive), a megabyte where an address
should be, and a register file of the wrong shape. It also proves that a
refusal leaves the register byte-for-byte untouched.

## Deploying it

**You need:** the Cloudflare account, and a GitHub token created at the moment
of deployment and never before. A token with write access to the repository
sitting in a notepad for a week is worse than no token.

**1. Install wrangler** (Cloudflare's command-line tool) and sign in:

    npm install -g wrangler
    wrangler login

**2. Make the GitHub token.** On GitHub: your avatar → **Settings** →
**Developer settings** (bottom of the left sidebar) → **Personal access
tokens** → **Fine-grained tokens** → **Generate new token**.

| Field | Value |
| --- | --- |
| Token name | `kop-fund-join` |
| Expiration | 90 days — put a reminder in your calendar to replace it |
| Resource owner | your own account |
| Repository access | **Only select repositories** → `Jimbus9/fanfund` |
| Permissions → Repository → Contents | **Read and write** |

Nothing else. Not "All repositories", and no other permission. If this token
leaks, the whole of its power is editing files in this one public repository,
where every change is visible and reversible.

**3. Give it to Cloudflare, not to anybody else:**

    cd worker
    wrangler secret put GITHUB_TOKEN

It will ask for the token; paste it there. Cloudflare stores it and will not
show it again. **Do not paste it into a chat, a document, or this repository.**

**4. Deploy:**

    wrangler deploy

It prints a URL ending in `.workers.dev`. That URL goes into the join page.

**5. Turn on Cloudflare's own rate limiting** for that Worker in the
dashboard. The endpoint deliberately has no rate limit of its own — the
protection should be Cloudflare's, which is maintained by people who do that
for a living, rather than something we hand-rolled and got wrong.

## Replacing the token later

Repeat step 2 with a new token, run `wrangler secret put GITHUB_TOKEN` again,
then delete the old token on GitHub. No redeployment needed.

## If it is ever switched off

The endpoint answers `503` and points at the pull request route. Nothing in
the register is lost, because the register has never lived here — it is read
from GitHub on every request and written straight back, so GitHub remains the
single copy and this endpoint holds no state of its own.
