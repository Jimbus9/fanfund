# Lock format

**Version 1 · 22 October 2026**

A lock is how a supporter commits money without anyone taking custody of it.
It is an ordinary Bitcoin output with a script that permits exactly two ways
out and no others.

## The two exits

| | Who signs | When |
| --- | --- | --- |
| **Going home** | The owner, alone | Only at or after the locktime |
| **Into a purchase** | The owner **and** the co-signer | Any time |

## The script

P2WSH, with both branches in one witness script:

```
OP_IF
  <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
  <ownerPubkey> OP_CHECKSIG
OP_ELSE
  <ownerPubkey> OP_CHECKSIGVERIFY
  <cosignerPubkey> OP_CHECKSIG
OP_ENDIF
```

The spender selects a branch with the last witness item before the script: `01`
for going home, an empty item for the purchase route.

**`OP_CHECKSIGVERIFY` followed by `OP_CHECKSIG` is the most important line in
this specification.** It makes the purchase branch require *both* signatures.
The co-signer can never move a coin alone.

Note also what is *absent*: the co-signer does not appear in the going-home
branch. They cannot block a withdrawal, delay one, or be asked to approve one.

## Locktime

A unix timestamp (≥ 500,000,000), so a lock expresses a date a supporter can
understand. `OP_CHECKLOCKTIMEVERIFY` compares it against the block's
median-time-past, so a lock becomes spendable at approximately rather than
exactly that moment — typically within an hour. Immaterial for a lock measured
in years.

A block height may be used instead and behaves identically. Heights are used
in testing because they are exact.

A spend down the going-home branch must set the transaction's `nLockTime` to
the lock's locktime, and `nSequence` below `0xffffffff` so that `nLockTime` is
honoured.

## Offered lengths

**One, three or five years**, chosen by the supporter at the moment of locking.

Fixed options rather than free choice: free choice scatters expiry dates across
a register nobody can read at a glance, and the point of the register is that
it can be read.

**Length is a genuine trade, in both directions.** A longer lock counts for more
and signals more. It also extends the period during which an outstanding
commitment to a dead proposal could, by a dishonest co-signer, still be
completed — because the locktime is when an owner regains the ability to kill
such a commitment by moving the coin alone. See the proposal and settlement
format. This must be presented to a supporter at the moment they choose, not
buried.

## Top-ups

A top-up is a **new lock**, not an extension of an existing one.

Simpler to build and simpler to verify. A supporter may hold several locks with
different dates; the counting rule adds them up and a client should present
them as one figure with the individual dates available.

## The published list

The co-signer signs a purchase-route spend **only** where the destination
appears on the published list of approved destinations.

Bitcoin cannot enforce a destination without covenants, which do not exist on
the network today. So this is policy rather than script — and it is the whole
defence against a forged proposal. Stealing committed money would require the
published list to be corrupted as well, not merely a convincing-looking
proposal to be put up.

The list is `destinations.json` in the project repository, and it has its own
specification: **published destinations format**. In short, it is append-only
and hash-chained, each entry is separately signed by keys that are **never** the
co-signing key, and an address must have been publicly visible for fourteen days
before a proposal may name it.

## Expiry

Nothing happens at the locktime. Bitcoin performs no scheduled actions.

The coin remains exactly where it was and simply becomes spendable by its owner
alone. It stays there indefinitely until they sign. For how this affects the
figures, see the counting rule — a lapsed lock is not counted and is published
separately.

Renewal cannot be automatic, since no coin moves without a signature. It is a
new transaction with a new fee. A client should prompt ahead of the date and
pre-build the transaction, but it cannot act for the owner.

## Verifying a lock

Given a lock address, an owner key, a co-signer key and a locktime:

1. Rebuild the witness script exactly as above.
2. Derive the P2WSH address from it.
3. The lock is genuine if and only if the derived address matches.

Changing any single element — either key, the locktime, the order of the keys —
produces a different address. A lock therefore commits to its own terms, and
those terms cannot be altered after coins are sent to it.

## Taproot

A taproot version of this lock is implemented in `lock/taproot.mjs` and gives
smaller witnesses and keeps the unused branch private. It changes nothing about
the two exits.

Each exit lives in its own leaf of a tapscript tree rather than in two branches
of one script, so a spend reveals only the leaf it used. Going home reveals 40
bytes and never shows that a purchase exit existed; a purchase reveals 68 bytes
and never shows the date the lock would have expired. The P2WSH form reveals all
114 bytes of both branches on either spend.

The internal key is BIP-341's suggested unspendable point
(`50929b74c1a0…803ac0`), so there is no key-path shortcut past the two leaves.
Without that, whoever knew the internal key could spend a lock with no script at
all.

P2WSH is specified first because the behaviour is what matters and P2WSH has
the widest tooling and wallet support, leaving less novel cryptography between
the design and the proof. Taproot should be adopted before real money is
committed at scale, and the two forms may coexist — the counting rule treats
them identically.

`lock/taproot.test.mjs` proves the taproot construction and its signatures
offline. Its enforcement has not yet been proven on a live network, which is the
only reason this document still specifies P2WSH first.

## Reference implementation

`lock/` in the repository. `selftest.mjs` proves the construction offline;
`run-testnet.mjs` proves the network's enforcement, which no local test can.

The four behaviours that must hold:

| Attempt | Required result |
| --- | --- |
| Owner alone, before the locktime | Rejected by the network |
| Co-signer alone, ever | Rejected by the network |
| Owner and co-signer, any time | Accepted |
| Owner alone, at or after the locktime | Accepted |

If any of these does not hold, nothing else in this project should be relied
upon.
