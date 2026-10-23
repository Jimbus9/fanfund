# Published destinations format

**Version 1 · 23 October 2026**

The only addresses committed money may ever be sent to.

Bitcoin cannot restrict where a coin goes without covenants, which the network
does not have. The lock's purchase exit therefore permits any destination, and
what actually constrains it is this document: **the co-signer completes a
commitment only where the destination appears on this list.**

That makes this list the whole defence against a forged proposal, and the most
attractive thing in the project to attack. Draining locks would require
corrupting this list as well as putting up a convincing proposal — not merely
the second.

## This document is a starting point, not a settled answer

Nothing can be attested until there is something to buy and a body to receive
it, which is a long way off. What is written here is a workable first design
recorded so that the problem is not discovered late — not a claim to have solved
it.

By the time it matters there should be a great many more people involved, several
of whom will know more about securing a list like this than anybody who has
worked on it so far. Their ideas should replace these if they are better. The one
part worth defending is the separation below: **the keys that attest a
destination must never be the key that spends to it.**

## The list is `destinations.json`

It lives in the project repository and it is **append-only**. Nothing is ever
edited or deleted; a mistake is corrected by appending a revocation.

Every entry is signed, and every entry commits to the one before it, so the list
cannot be rewritten without the signing keys and without the break being visible.

## The signed line

The container is JSON for convenience. **The thing that is signed is a single
canonical line of text**, which any language can reproduce exactly:

```
index|op|address|text|added|prev
```

| Field | |
| --- | --- |
| `index` | Decimal, starting at 1, never reused, never skipped |
| `op` | `add` or `revoke` |
| `address` | The destination, or for a revocation the address being revoked |
| `text` | What it is for, or for a revocation why. No `|` and no newlines |
| `added` | RFC 3339 UTC, e.g. `2026-11-01T12:00:00Z` |
| `prev` | SHA-256 of the previous entry's line, hex. 64 zeros for entry 1 |

Canonicalisation, as for the declaration: UTF-8, NFC normalised, no leading or
trailing whitespace, no trailing newline on the line itself.

An example first entry:

```
1|add|bc1qexampleaddressgoeshere|Society receiving address for the stake purchase|2026-11-01T12:00:00Z|0000000000000000000000000000000000000000000000000000000000000000
```

## Attestation

An entry is attested by signing this statement with the Bitcoin Signed Message
convention, exactly as a registration signs the declaration:

```
I attest Fan Fund destination entry 1 (sha256:<hash of the line>).
```

Deliberately the same mechanism as a registration, so the verifier already
written for the register verifies these too. No new cryptography enters the
project to protect its most sensitive list.

### Attestor keys must never be the co-signing key

This is the point of the whole arrangement. If the key that attests destinations
were the key that completes commitments, one compromise would deliver both halves
and the list would protect nothing.

The attestor keys are published in the list's own `attestors` field, are
separate from the co-signing key, and should be held on different hardware. A
co-signing key must never appear as an attestor.

### How many signatures

Day one: **one attestor, one signature**, held by a single person who also
happens to hold the co-signing key — on a different key, on different hardware.
That is stated plainly rather than dressed up. One person attesting is weak, and
what actually does the work at this stage is the waiting period below.

The required count rises with the number of attestors. The rule is a simple
majority of published attestors, and it is recorded in the list's `threshold`
field so that a verifier never has to guess.

## The waiting period

**An entry must be publicly visible for fourteen days before a proposal naming
it may open.**

This is the real protection while there is one attestor. A fraudulent addition
has to survive a fortnight in public, in a file people watch, followed by up to
four weeks of a proposal gathering — six weeks in which anyone can notice it
before a penny moves.

**Age is measured from the entry's first public appearance in the repository, not
from its `added` field.** The `added` field is written by the attestor and could
be backdated. The repository's own history, its mirrors, and the time a change
became publicly visible are not in the attestor's gift.

Fourteen days is a floor. A proposal may require longer and should, for a large
purchase.

## Revocation

```
7|revoke|bc1qexampleaddressgoeshere|Superseded by entry 6; this address is no longer in use|2027-02-14T09:00:00Z|<hash of entry 6>
```

A revoked address may not receive new commitments from the moment the revocation
appears — **no waiting period applies to a revocation**, because the safe
direction needs no delay.

Existing commitments already signed for a revoked address are a different matter.
They remain cryptographically valid, and the co-signer must not complete them.
This is one of the places where the co-signer's refusal is doing real work.

## What the co-signer checks

Before completing any commitment, for the destination named in its proposal:

1. The hash chain is intact from entry 1 to the head of the list.
2. There is an `add` entry for the destination.
3. Its attestations meet the threshold and every one verifies.
4. The entry first appeared publicly at least fourteen days before the proposal
   opened.
5. There is no later `revoke` entry for that address.

Any check failing means the commitment is not completed. All five are mechanical;
none is a judgement call.

## Verifying the list yourself

Anybody, with no permission and nothing but the repository:

1. Rebuild each entry's canonical line from the fields.
2. Hash it, and confirm the next entry's `prev` matches.
3. Verify each attestation against the published attestor addresses, using the
   same verifier the register uses.
4. Compare `added` against the commit history and against a mirror, to catch a
   backdated entry.

A list whose chain breaks, or whose attestations do not verify, is not to be
relied on and no commitment should be completed against it.

## What this does not protect against

**A legitimate destination that is the wrong one.** If an address is genuinely
attested and genuinely waited out its fourteen days, this document is satisfied
even if the purchase behind it is a bad idea. Nothing here judges whether a
purchase is worth making. That is what the absence of commitments is for.

**Routine small spends are the worse target, not the purchase.** Nobody is going
to wave through a forged proposal for forty million pounds. A plausible invoice
for a few thousand, arriving when everybody is used to approving such things, is
the realistic attack — which is why small operating costs are met from a separate
transparent fund with published receipts, and never from locked money.

## Amendments

This document is versioned and may change. The declaration cannot. If the two
ever appear to conflict, the declaration governs and this document is wrong.
