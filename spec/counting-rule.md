# Counting rule

**Version 1 · 22 October 2026**

How every number this movement publishes is computed. Two people applying this
document to the same public data must reach the same answer. If they do not,
this document is at fault and should be corrected.

Principle 10 of the declaration: no figure is published that cannot be checked
by a stranger. This is the document that makes that possible.

## The unit of account is bitcoin

The authoritative figure is in **BTC**, not pounds.

A pound figure may be shown alongside it, and when it is, it must be marked as
an indicative conversion at the time of display. It is never the headline and
it is never archived as a fact.

The reason is not ideology. Priced in pounds, an ordinary fall in the bitcoin
price appears to shrink the movement while the target stands still, and nobody
whose money is locked can do anything about it. Priced in bitcoin, the movement
holds exactly what it held yesterday, and what has changed is the cost of the
thing it is trying to buy. The second description is the true one, and it keeps
a price source out of the only number that has to be beyond argument.

## The three states of a lock

Read directly from the blockchain, never from any record we keep.

| State | Condition | Counted |
| --- | --- | --- |
| **Locked** | Coins present at the lock address, locktime in the future | **Yes** |
| **Lapsed** | Coins present, locktime reached | No — published separately |
| **Withdrawn** | Coins no longer at the address | No |

**Lapsed money is not counted**, whether or not the owner has moved it. On the
date a lock reaches, the owner can spend those coins with a single signature,
which makes them indistinguishable from any other coins somebody happens to
own — and counting those would return the headline figure to meaninglessness.

**The lapsed figure is published on its own.** It is the renewal pipeline, and
the gap between "members drifting away" and "members who have not got round to
it" is the most useful health signal this movement has. Concealing it would be
a breach of principle 10.

## The committed total

```
committed = Σ (confirmed balance of every lock address in state "locked"
               whose balance is at least the minimum)
```

- Balances are read from the blockchain at a stated moment, and the moment is
  published with the figure.
- **Unconfirmed transactions do not count.** A lock counts from its first
  confirmation.
- Each lock address is counted once. An address appearing twice in the register
  is counted once.

## The minimum

**200,000 satoshis.** A lock below this does not count towards the committed
total.

Expressed in satoshis rather than pounds so it does not drift with the price.
Its only purpose is to stop a large number of worthless locks inflating the
figures — at this level, faking ten thousand of them would cost real money.

**Changing it.** The minimum may be revised, in a published amendment to this
document carrying a reason and an effective date, so that anyone can recompute
the totals under both the old rule and the new one and see exactly what the
change did.

**Existing locks are grandfathered.** A raised minimum never disqualifies a
lock that qualified when it was made. Otherwise a price movement could silently
remove supporters from the count, which would be the opposite of the point.

## The member count

Two different numbers, and they must never be conflated.

**Signatories** — registrations that verify. Costs nothing to obtain, so it is
a measure of agreement rather than commitment, and it must never be presented
as a financial figure.

**Committed members** — distinct members holding at least one lock in state
"locked" at or above the minimum. This is the figure to quote alongside the
committed total, because the two describe the same group of people.

Where only one figure is given, it must be the committed one, and it must be
labelled.

## Vote tallies

Weight is committed money, measured at a **block height declared when the vote
opens** and published with the proposal.

```
weight(member) = Σ (balance of their locks in state "locked" at that height)
```

Fixing the height in advance is what makes a result reproducible: two people
counting independently reach the same answer, because they are counting the
same chain state rather than whatever the chain happened to look like when each
of them looked.

- A lock that lapses after the declared height still carries its weight for
  that vote. The snapshot is the snapshot.
- A lock created after the declared height carries no weight in that vote.
- The full tally — every vote, every weight, every total — is published so that
  anybody can recount it from public data alone.

Influence cannot be rented under this rule, because committed money cannot be
borrowed for an afternoon. That is why no decay curve, holding-period formula
or anti-gaming measure appears anywhere in this document: the lock already does
that work.

## Figures that must not be published

- **Holdings.** Bitcoin a supporter merely owns, however much of it there is.
- **Intentions.** Pledges, promises or expressions of support not backed by a
  lock.
- **A peak or record figure.** Only the present matters. A record flatters and
  is not load-bearing.
- **Any pound figure presented as authoritative** rather than as an indicative
  conversion at a stated moment.

## Amendments

This document is versioned and may change. The declaration cannot. If the two
ever appear to conflict, the declaration governs and this document is wrong.
