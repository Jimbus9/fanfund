# Running your own

**Version 1 · 24 October 2026**

Everything here is free to copy, for any club, any sport, or any cause that fits.
Copying it is not tolerated, it is the intended outcome. Nobody needs permission,
nobody needs to tell us, and nothing is owed to anybody if it works.

This document separates the **method** — which is general — from **this
instance**, which happens to be about buying a stake in Liverpool Football Club.

The method is called **Crowdlock**. It is a set of published rules, not a
program: anyone can build software that follows them, or follow them with an
ordinary wallet and no app at all. An instance is *a* Crowdlock, the way a
particular society is a co-operative. **The Kop Fund is a Crowdlock.** Yours
will be another, with its own name and its own declaration.

## Crowdlock is six documents, plus your own declaration

| | Document | General? |
| --- | --- | --- |
| 1 | The declaration | **No — yours will say something else entirely** |
| 2 | Registration format | Yes |
| 3 | Counting rule | Yes |
| 4 | Lock format | Yes |
| 5 | Proposal and settlement format | Yes |
| 6 | Commitment format | Yes |
| 7 | Published destinations format | Yes |

The declaration is the only one that is *about* anything. The other six describe
a mechanism: how a crowd of strangers can commit money towards buying something,
with nobody ever holding anybody else's money, and no way for anyone to be made
to pay.

Write your own declaration. Keep the six.

## What Crowdlock is for

**A crowd buying an asset it intends to hold permanently and never take income
from, without a custodian.**

A football club is one example. A pub, a piece of woodland, a local newspaper, a
building, a windfarm, a shuttered factory — all the same shape. What matters is
that there is a thing, a seller, a price, and a large number of people who would
each put in a small share and want nothing back.

### The one condition that is not negotiable

**Contributors must receive nothing financial, ever.** No dividend, no interest,
no profit share, no buyback, no appreciation they can realise.

If you intend to pay anybody a return, **this is the wrong specification**. What
you would be building is a collective investment scheme, which in most countries
is heavily regulated, and the design here offers none of the protections such a
scheme is required to have. Take proper advice instead of copying this.

The whole design leans on that condition. It is why nobody needs to be trusted
with a pot of money, why there is no custodian, and why the thing cannot quietly
become somebody's business.

## What Crowdlock is bad at

Said plainly, so that nobody adopts it for the wrong job:

- **Small amounts.** On-chain fees and on-ramp costs make commitments under a
  couple of hundred pounds poor value. It cannot do a tenner.
- **Speed.** A proposal takes weeks by design and settlement is paced across
  days. It cannot react to an opportunity that closes on Friday.
- **Vague goals.** It needs an identifiable seller, a price, and an address that
  can be published and attested in advance. "Fund our campaign" does not fit.
- **Anybody who might need their money back on demand.** A lock is a lock.
- **A trickle rather than a target.** Crowdlock funds something with a price: a
  stake, a building, a year's costs written as a figure and a date. It has no
  notion of a standing order, so it cannot be a subscription. A charity's whole
  year *can* be a target. "A bit each month, forever" cannot.

## What the money may be spent on is your declaration's business

The Kop Fund's declaration says committed money buys and holds a stake, so its
running costs have to come from somewhere else. **That is a rule The Kop Fund
wrote for itself, not a limit of the method.**

A Crowdlock whose declaration says it funds an air ambulance every year, or a
stadium expansion once a stake is owned, is doing exactly what it told its
members it would do. Repeat purchases are a normal shape. So is running several
Crowdlocks side by side, each with its own declaration and its own register,
which is what the instance files are for.

What does not bend is the condition above: **contributors receive nothing
financial, ever.** A donation is not a return, and neither is watching the thing
you paid for get built.

One warning for anyone funding something they only partly own. If supporters
hold two per cent of a club and then pay for a stand, ninety-eight per cent of
what they paid for belongs to the people they were trying to counterbalance. The
stand may well be worth building anyway — but that is a transfer, it should be
named as one, and a declaration that permits this should say so where its members
will read it.

## What your instance must publish

The six general documents are written against parameters rather than fixed
numbers. Publish your values for all of these **in one file**,
`crowdlocks/<your-name>.json`, and your instance is fully specified. The Kop
Fund's is `crowdlocks/kop-fund.json`: copy it and change the values.

| Parameter | What it is | This instance |
| --- | --- | --- |
| `name` | What your Crowdlock is called | The Kop Fund |
| `declaration` | Its title, version, file and SHA-256. **The SHA-256 is your instance's identity** | Supporters' Declaration v1, `declaration-v1.txt`, `3a0a0bca…6209b96` |
| `network` | Which chain | `mainnet` |
| `unit` | Unit of account for every published figure | `BTC` |
| `lock_lengths_years` | The fixed options a member may choose. Whole years on real bitcoin; a test Crowdlock may offer fractions (an hour is `1/8766`) so a lock can be made and taken home in one sitting | 1, 3 or 5 |
| `minimum_counted_lock_sats` | Below this, a lock does not count towards the total | 200,000 |
| `cosigner_keys` | Public keys for the lock's purchase exit | **Not yet chosen** — an empty list |
| `gathering_window_max_days` | Longest a proposal may gather | 28 |
| `settlement_window_max_days` | Longest settlement may take after that | 14 |
| `destination_wait_days` | How long a destination must be public before a proposal may name it | 14 |
| `attestor_keys` | Who attests destinations. **Never a co-signer's key** | **Not yet chosen** — an empty list |
| `attestor_threshold` | How many attestations an entry needs | 1 |
| `max_commitment_fee` | Fee cap on a commitment, as a fraction of the amount committed | 0.01 |
| `register` | Your registrations and destinations files | `registrations.json`, `destinations.json` |
| `chain_api` | Where the register reads balances from. Anybody can swap in their own | mempool.space |
| `disclaimer` | Optional. Shown on your register page | Not affiliated with Liverpool FC |
| `join_endpoint` | Optional. An https address that accepts signed registrations, so clients and apps can submit without GitHub. It can refuse but never forge; the pull request route stays open | The Kop Fund's Cloudflare Worker |
| `lock_endpoint` | Optional. The same for locks: an https address that checks a lock's terms against the chain and publishes it. Can refuse but never invent a lock; the pull request route stays open | The Kop Fund's Cloudflare Worker |
| `relays` | Optional. Public Nostr relays where members post signed registrations and locks, for the Crowdlock's own repository to collect every two minutes — no endpoint, account or key in the path | — |
| `spare_relays` | Optional. Published in advance; one replaces a live relay that has been silent for 7 days, in a commit saying so | — |

Choose them deliberately. Shorter windows suit a smaller, more connected crowd; a
higher minimum suits fewer, larger contributors; a longer destination wait suits
a larger purchase.

Nothing about any one Crowdlock is written into the code. The register page and
the lock tools read whichever file they are pointed at, so the same software
serves every instance. `node js/crowdlock.test.mjs` checks every file listed in
`crowdlocks/index.json`: that it is complete, that its declaration really hashes
to the fingerprint it claims, and that its register files agree with it.

## Several Crowdlocks side by side

One site, or one app, can carry as many Crowdlocks as people add. Add your file
to `crowdlocks/`, add its name to `crowdlocks/index.json`, and your register is
at `register/?c=<your-name>`. Three rules keep them apart:

- **Every Crowdlock has its own declaration.** Two sharing one would be the same
  Crowdlock, and the checks refuse it.
- **No two Crowdlocks share a co-signer key.** A lock is counted by the
  Crowdlock whose co-signer it names, so a shared key would let one coin be
  counted twice. The checks refuse it, and a commitment checked against the
  wrong Crowdlock's file is refused too, so money committed to one can never be
  counted by another.
- **One key across several Crowdlocks links your memberships publicly.** Your
  member address is derived from your key, so anyone can see that the same
  person backs both. That is a matter of privacy, not of safety, and nothing
  stops you doing it. If you would rather the two were not connected, use a
  separate wallet for each.

## Your instance is identified by its declaration's hash

This is not decoration. **Every signature in the method is made over a statement
containing that hash**, so a signature cannot be lifted out of one instance and
replayed into another. A registration proves agreement to *your* declaration, and
a destination attestation attests an entry in *your* list.

Two instances that copied the same parameters but wrote different declarations
remain cryptographically separate, with no coordination and no registry of
instances.

## About the language

These documents say "supporter", "fan" and "the club" throughout, because the
instance that wrote them is about football. If you are buying a woodland, change
every word of that — it is tone, not mechanism. Nothing in the behaviour depends
on it.

Two places where the words matter more than style:

- The **declaration** is signed, so its words are the thing people agreed to.
  Write it as though it will be quoted back at you in ten years, because it will.
- The **principles the other documents refer to by number** are your
  declaration's, not ours. If you renumber, check the references.

## What we would do differently if starting again

Offered because it is cheaper to read than to rediscover:

- **Do not pool money, in any form, however convenient.** Almost every hard
  problem in this project's earlier designs came from assuming a pot had to
  exist. Removing it removed all of them at once.
- **Decide nothing by vote that can be decided by funding.** A vote exists to
  instruct somebody holding money. If nobody holds money, the vote is machinery
  with nothing to do.
- **Put nothing in the declaration that will ever need to change.** Dates,
  numbers, names, procedures and technologies all belong elsewhere. Ours shrank
  by two thirds when that rule was applied, and it got stronger.
- **Publish the figures you would rather not.** Lapsed locks, failed
  registrations, proposals that died. A register that only shows good news is not
  a register.
- **Separate the key that approves a destination from the key that spends to
  it.** One compromise should not be able to deliver both halves.
- **Ask people whether they would contribute before building any of this.** We
  have still not done it. It remains the cheapest and most important untested
  assumption in the whole project, and we would be further along if we had
  started there.

## Licence and warranty

Take it. There is no warranty of any kind. Nobody outside this project has
reviewed the code or the documents, and at the time of writing none of it has
held real money.

If you find something wrong, saying so publicly helps every instance at once.
