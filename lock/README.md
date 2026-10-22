# Stage 1 — prove the lock

Everything in the fan fund rests on one sentence:

> Your money comes home on its date, and nobody can take it in the meantime.

That is a claim about how Bitcoin behaves. This proves it.

## What a lock is

A locked coin can leave in exactly two directions and no others.

| | Who signs | When | 
| --- | --- | --- |
| **Going home** | The fan, alone | Only on or after the date they chose |
| **Into a purchase** | The fan **and** the co-signer | Any time |

Both live in one script. The spender picks a branch:

```
OP_IF
  <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
  <fan> OP_CHECKSIG                       <- going home
OP_ELSE
  <fan> OP_CHECKSIGVERIFY
  <cosigner> OP_CHECKSIG                  <- into a purchase
OP_ENDIF
```

The line that matters most is `OP_CHECKSIGVERIFY` followed by `OP_CHECKSIG`. It
means the purchase branch needs **both** signatures. The co-signer can never
move a coin alone — not with a court order, not with the fan's password, not
ever. That is what makes them a check rather than a custodian.

And the co-signer does not appear in the going-home branch at all. They cannot
refuse to let a fan out, delay it, or be asked to approve it. On the date, one
signature is enough and nobody else is involved.

## Two files, two different kinds of proof

**`selftest.mjs`** — runs anywhere, needs no internet. Proves we *built* the
lock correctly: the script says what we think it says, the address derives from
it, every signature is valid over the right sighash, and the attempts that are
supposed to lack a signature really do lack one.

```
node selftest.mjs
```

**`run-testnet.mjs`** — needs internet. Proves *Bitcoin enforces* it, which no
local test ever can, because only a node can refuse a transaction.

```
node run-testnet.mjs
```

The distinction is the point. One proves our work; the other proves the
network's.

## Running the testnet proof

It uses two locks so there is nothing to wait for:

- **Lock A** — date years away. Proves the fan cannot get out early, proves the
  co-signer cannot act alone, proves fan + co-signer can reach a purchase.
- **Lock B** — date already passed. Proves the fan alone can go home.

1. `node run-testnet.mjs` — it prints two addresses and stops.
2. Search for a **testnet4 faucet** and send a small amount to each. These are
   test coins. They are free and they are not money.
3. `node run-testnet.mjs` again. It makes all four attempts and reports what
   the network did with each.

It saves its keys to `lock-state.json` so you can close the terminal and come
back. Those are testnet keys and worthless.

If the default API is down:

```
FANFUND_API=https://blockstream.info/testnet/api node run-testnet.mjs
```

## What you should see

```
PASS  Fan alone tries to go home BEFORE the date      -> network REFUSED
PASS  Co-signer alone tries to move the coin          -> network REFUSED
PASS  Fan + co-signer move it into a purchase         -> network ACCEPTED
PASS  Fan alone goes home AFTER the date              -> network ACCEPTED
```

If any line says FAIL, stop. Nothing else in this project should be built until
it is understood, because the register, the voting and the app all assume this
lock behaves exactly this way.

## Decisions baked in

Settled on 22 October 2026:

- **Lock lengths are fixed options** — one, three or five years. Not free
  choice, which would scatter expiry dates across a register nobody could read.
- **A top-up is a new lock**, not an extension. Simpler to build and verify; a
  fan may hold several, and the register adds them up.
- **The co-signer only signs spends to an address on the published list.**
  Bitcoin cannot enforce a destination without covenants, so this is policy
  rather than script — and it is the whole phishing defence. Draining locks
  would need the published list corrupted too, not just a convincing proposal.
- **The minimum lock that counts towards the total is 200,000 sats.** Set in
  sats rather than pounds so it does not drift with the price. Signing the
  declaration is still free and still makes you a member; this is only about
  the money figure.

## Why P2WSH rather than taproot

Behaviour is what matters at this stage, and P2WSH has the most mature tooling
and the widest wallet support — less of our own cryptography sitting between
the design and the proof.

Taproot is a later optimisation: smaller witnesses, and the branch you did not
use stays private. It changes nothing about the two exits. Worth doing before
real money is involved, not before the behaviour is established.

## What this does not cover

- **Real money.** Testnet only. Nothing here has touched a satoshi of value.
- **Key safety.** How a fan backs up the key holding their lock is the app's
  problem, and it is a serious one.
- **Who the co-signer is.** Still open. See the build plan — sortition is a
  placeholder, not a decision.
- **Outside review.** Nobody but Claude has read this code. Before it holds a
  penny of anyone's money, somebody who is not us needs to.
