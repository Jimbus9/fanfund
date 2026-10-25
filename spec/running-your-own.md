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

## The method is six documents and one declaration

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

## What the method is for

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

## What the method is bad at

Said plainly, so that nobody adopts it for the wrong job:

- **Small amounts.** On-chain fees and on-ramp costs make commitments under a
  couple of hundred pounds poor value. It cannot do a tenner.
- **Speed.** A proposal takes weeks by design and settlement is paced across
  days. It cannot react to an opportunity that closes on Friday.
- **Vague goals.** It needs an identifiable seller, a price, and an address that
  can be published and attested in advance. "Fund our campaign" does not fit.
- **Anybody who might need their money back on demand.** A lock is a lock.
- **Anything needing a continuous income.** Running costs must come from
  somewhere else entirely; committed money is for the purchase and nothing else.

## What your instance must publish

The six general documents are written against parameters rather than fixed
numbers. Publish your values for all of these, in one place, and your instance is
fully specified.

| Parameter | What it is | This instance |
| --- | --- | --- |
| `declaration` | Canonical text and its SHA-256. **This is your instance's identity** | `declaration-v1.txt`, `3a0a0bca…6209b96` |
| `network` | Which chain | Bitcoin mainnet |
| `unit` | Unit of account for every published figure | Bitcoin |
| `lock_lengths` | The fixed options a member may choose | 1, 3 or 5 years |
| `minimum_counted_lock` | Below this, a lock does not count towards the total | 200,000 sats |
| `cosigner_keys` | Public keys for the lock's purchase exit | **Not yet chosen** |
| `gathering_window_max` | Longest a proposal may gather | 4 weeks |
| `settlement_window_max` | Longest settlement may take after that | 2 weeks |
| `destination_wait` | How long a destination must be public before a proposal may name it | 14 days |
| `attestor_keys` | Who attests destinations. **Never the co-signer's key** | **Not yet chosen** |
| `attestor_threshold` | How many attestations an entry needs | 1 |
| `max_commitment_fee` | Fee cap on a commitment, as a share of the amount committed | 1% |
| `register` | Where registrations and commitments are published | This repository |

Choose them deliberately. Shorter windows suit a smaller, more connected crowd; a
higher minimum suits fewer, larger contributors; a longer destination wait suits
a larger purchase.

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
