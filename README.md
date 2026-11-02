# Crowdlock, and The Kop Fund

This repository holds four things that are easy to mix up. This page says which is which and where it lives.

1. **Crowdlock** — the method. A set of published rules for a fund that nobody pools money into: fans lock their own bitcoin, and a purchase is funded by each fan signing their own locked money into it. Anyone can copy it.
2. **The Kop Fund** — one Crowdlock: a fund of Liverpool supporters buying a stake in Liverpool Football Club. It is the first instance of the method, and the only one run from this repository.
3. **The Kop Fund's website** — the public pages for The Kop Fund, and the small services that run beside them.
4. **The Crowdlock app** — a phone wallet that follows the method. It works with any Crowdlock, and any founder can start one.

If you are new, read `spec/declaration-v1.txt` (what The Kop Fund is for), then `spec/running-your-own.md` (what the method is).

## 1. Crowdlock (the method)

General to any Crowdlock. Nothing in these files names Liverpool.

| What | Where |
| --- | --- |
| The six general documents: membership record, counting rule, lock, proposal and settlement, commitment, destinations | `spec/` (all files except `declaration-v1.txt` and `index.html`) |
| How to run your own Crowdlock, and how to make a co-signer key | `spec/running-your-own.md` |
| Checking a membership signature, and reading a Crowdlock's file | `js/verify.mjs`, `js/crowdlock.mjs` |
| Accepting a registration or a lock, and deciding whether it counts | `js/append.mjs`, `js/lockrecord.mjs`, `js/inbox.mjs`, `js/relayhealth.mjs` |
| The lock script, commitments and taproot (taproot is built but not in use) | `lock/` |
| Making a co-signer key, offline | `cosigner/` |
| Anchoring the declaration in Bitcoin | `anchor/` |
| The relay inbox: collecting records from Nostr relays | `relay/` (also copied into every founder's repository) |
| The licence: code MIT, documents CC BY 4.0 | `LICENSE`, `spec/LICENSE` |

## 2. The Kop Fund (this instance)

Values and documents that belong only to The Kop Fund.

| What | Where |
| --- | --- |
| The declaration, the one document that cannot change | `spec/declaration-v1.txt` and its Bitcoin timestamp `spec/declaration-v1.txt.ots` |
| Its parameters: name, minimum, lock lengths, relays, the site | `crowdlocks/kop-fund.json` (listed in `crowdlocks/index.json`) |
| Its test instance on testnet4, with its own throwaway declaration | `crowdlocks/kop-fund-testnet4.json`, `crowdlocks/test/` |
| The register: members and locks | `registrations.json` |
| The destinations list: where money may be sent | `destinations.json` |
| The relay inbox's own state: which relays are silent, which Crowdlocks were announced | `relay/health.json`, `relay/announced.json`, `relay/VERSION` |

## 3. The Kop Fund's website

The public pages at https://jimbus9.github.io/fanfund/, and the services behind them.

| What | Where |
| --- | --- |
| Front page | `index.html` |
| The pages: Why, How it works, Risks, The register, The documents | `why/`, `how/`, `risk/`, `register/`, `spec/index.html` |
| Join: wallet-by-wallet signing and checking, then posting to the relays | `join/` |
| A mock-up of the register, with invented figures | `mock/` |
| Styling | `style.css` |
| GitHub Pages setting (stops Pages mangling the files) | `.nojekyll` |
| The relay inbox's schedule, run by GitHub | `.github/workflows/relay-inbox.yml` |
| The old join and lock endpoint, being retired | `worker.js`, `wrangler.jsonc`, `DEPLOYING-THE-JOIN-ENDPOINT.md` |

## 4. The Crowdlock app

Everything under `app/`, built by `.github/workflows/app.yml`.

| What | Where |
| --- | --- |
| The screens | `app/App.tsx` |
| Wallet and keys | `app/src/wallet/` |
| Loading, checking and joining Crowdlocks, finding and starting them | `app/src/crowdlocks.mjs`, `app/src/start.mjs`, `app/src/github.mjs`, `app/src/relays.mjs` |
| This build's own settings: the Crowdlocks it starts with | `app/src/build.mjs` (the one file that differs between builds) |
| The inbox copied into every new Crowdlock, packed by a script | `app/template/`, `app/src/template.mjs` (generated; `app/scripts/make-template.mjs`) |
| Tests against a private test chain | `app/test-chain/` |

## Tests

Each part has its own tests. Install a part's dependencies first, with `npm ci` in that folder.

- Method: `js/*.test.mjs`, `lock/*.test.mjs`, `cosigner/cosigner.test.mjs`, `anchor/anchor.test.mjs`, `relay/inbox.test.mjs`
- App: `app/test-chain/*.test.mjs`, and `node app/scripts/make-template.mjs --check`

## Rules for changes

- Shared code and the six general documents must not name The Kop Fund, except as an example marked as one.
- Values for one Crowdlock go in its own file, not in code.
- The declaration can never change. A change would be a new version.
