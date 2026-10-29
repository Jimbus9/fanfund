// The key module. The only part of the app that touches keys or money.
//
// THE RULE, with no exceptions: we never write key handling, signing or
// transaction building ourselves. Every one of those is a library call here:
//
//   backup words      @scure/bip39            generate and check 12 words
//   keys              BIP32 (via descriptors)  derive the key from the words
//   addresses         @bitcoinerlab/descriptors  wpkh(...) and addr(...)
//   transactions      descriptors' Psbt + Output  inputs, outputs, weights
//   signing           descriptors' signers     sign every input
//   signing a message @bitcoinerlab/secp256k1  signRecoverable, over the
//                                              register's own message hash
//
// What is ours is only the arithmetic around them (how much fee to leave) and
// the refusals that stop a transaction destroying somebody's money. This file
// should stay small enough to read in one sitting: it is the one part worth
// paying somebody outside the project to review.
//
// ONE KEY DOES EVERY JOB. The key derived here owns the waiting balance, signs
// the declaration, and will own the fan's locks. That is the project's settled
// design (spec/registration-format.md): the member's address is simply the
// address of this key, so there is nothing extra to register or back up.
//
// Nothing in here reads the network directly. Every blockchain question goes
// through a `chain` object handed in by the caller, so the same code runs
// against a public block explorer on the phone and a private test chain in the
// tests.

import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { BIP32, Output, Psbt, signers, networks, keyExpressionBIP32 } from "@bitcoinerlab/descriptors";
import * as ecc from "@bitcoinerlab/secp256k1";
// The register's own verifier, shared with the website: the message hash a
// signature is made over is computed by exactly the code that later checks it.
import { messageHash } from "../../../js/verify.mjs";

/** Networks the wallet knows, and the coin type each uses in its key path. */
export const NETWORKS = {
  mainnet:  { network: networks.bitcoin, coin: 0 },
  testnet4: { network: networks.testnet, coin: 1 },
  signet:   { network: networks.testnet, coin: 1 },
  regtest:  { network: networks.regtest, coin: 1 },
};

// Below this a native-segwit output is "dust": nodes will not relay a
// transaction creating one, so it would be stuck. Bitcoin Core's figure.
export const DUST_SATS = 294n;

// ---------------------------------------------------------------------------
// Backup words
// ---------------------------------------------------------------------------

/** Twelve new backup words, from the phone's secure random source. */
export function newWords() {
  return generateMnemonic(wordlist, 128);
}

/** Tidy what a person typed: lower case, single spaces, nothing either side. */
export function tidyWords(text) {
  return String(text ?? "").trim().toLowerCase().split(/\s+/).join(" ");
}

/** Are these valid backup words? Checks the words and their built-in checksum. */
export function wordsAreValid(text) {
  return validateMnemonic(tidyWords(text), wordlist);
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/**
 * The fan's one key and address, from their backup words.
 *
 * Standard native-segwit path (BIP84), first address: m/84'/coin'/0'/0/0, so
 * the same words open the same address in Sparrow, Electrum or any wallet
 * that follows the standard — the manual path the project promises.
 *
 * `network` may be a name from NETWORKS or { network, coin } directly, which
 * the tests use for a chain with its own address prefix.
 */
export function accountFromWords(text, network = "mainnet") {
  const words = tidyWords(text);
  if (!wordsAreValid(words)) throw new Error("those are not valid backup words");
  const { network: net, coin } = typeof network === "string" ? NETWORKS[network] : network;
  if (!net) throw new Error(`unknown network: ${network}`);

  const root = BIP32.fromSeed(mnemonicToSeedSync(words), net);
  const originPath = `/84'/${coin}'/0'`;
  const keyPath = "/0/0";
  // The key expression carries the key's origin (fingerprint and path), so
  // every transaction records which key signs it — what a Ledger needs later.
  const keyExpression = keyExpressionBIP32({ masterNode: root, originPath, keyPath });
  const output = new Output({ descriptor: `wpkh(${keyExpression})`, network: net });

  return {
    network: net,
    path: `m${originPath}${keyPath}`,
    publicKey: toHex(root.derivePath(`m${originPath}${keyPath}`).publicKey),
    address: output.getAddress(),
    keyExpression,
    /** For signing. The library finds the right key from the path above. */
    signer: () => root,
    output,
  };
}

// ---------------------------------------------------------------------------
// What the chain says
// ---------------------------------------------------------------------------

/**
 * The waiting balance: confirmed coins, and coins still arriving.
 * Returns { confirmed, arriving, total } in sats, as BigInt.
 */
export async function waitingBalance(chain, address) {
  const coins = await chain.utxos(address);
  let confirmed = 0n, arriving = 0n;
  for (const c of coins) {
    if (c.confirmed) confirmed += BigInt(c.value);
    else arriving += BigInt(c.value);
  }
  return { confirmed, arriving, total: confirmed + arriving };
}

// ---------------------------------------------------------------------------
// Sending waiting money out
// ---------------------------------------------------------------------------

/**
 * Build and sign a transaction sending waiting money to another address.
 *
 *   account   from accountFromWords
 *   chain     the chain object (utxos, txHex)
 *   to        destination address
 *   amount    sats as BigInt, or "all" to send everything (no change)
 *   feeRate   sats per vbyte
 *
 * Spends confirmed coins only. Returns { hex, txid, fee, sent, change }.
 *
 * @param {{ account: any, chain: any, to: string, amount: bigint | "all", feeRate: number }} args
 * @returns {Promise<{ hex: string, txid: string, fee: bigint, sent: bigint, change: bigint }>}
 * Refuses rather than build anything that would lose money to fees, strand
 * money as dust, or send to an address on the wrong network.
 */
export async function buildSend({ account, chain, to, amount, feeRate }) {
  const net = account.network;
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 1000) {
    throw new Error("fee rate must be between 1 and 1000 sats per vbyte");
  }

  let dest;
  try { dest = new Output({ descriptor: `addr(${String(to).trim()})`, network: net }); }
  catch { throw new Error("that is not an address on this network"); }

  const coins = (await chain.utxos(account.address)).filter((c) => c.confirmed);
  if (coins.length === 0) throw new Error("there is no confirmed money to send yet");
  const inputTotal = coins.reduce((s, c) => s + BigInt(c.value), 0n);

  const sendAll = amount === "all";
  if (!sendAll && (typeof amount !== "bigint" || amount <= 0n)) throw new Error("amount must be a positive number of sats");

  // Fee from the library's own weights, never a guessed constant: every input,
  // the destination, and change if there is any.
  const inWeight = account.output.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES");
  const weightOf = (withChange) =>
    44 /* version, locktime, counts and the segwit marker, in weight units */
    + coins.length * inWeight + dest.outputWeight() + (withChange ? account.output.outputWeight() : 0);
  const feeFor = (withChange) => BigInt(Math.ceil((weightOf(withChange) / 4) * feeRate));

  let sent, change, fee;
  if (sendAll) {
    fee = feeFor(false);
    sent = inputTotal - fee;
    change = 0n;
  } else {
    fee = feeFor(true);
    sent = amount;
    change = inputTotal - amount - fee;
    if (change >= 0n && change < DUST_SATS) {
      // Change too small to keep: give it to the fee rather than strand it, but
      // only if that does not make the fee unreasonable (checked below).
      fee = inputTotal - amount;
      change = 0n;
    }
  }

  if (sent < DUST_SATS) throw new Error("that is too little to send — it would be stuck as dust");
  if (change < 0n) throw new Error("there is not enough money for that amount plus the fee");
  // The guard that matters most: never let the fee eat a large share of what
  // is being sent. Ten per cent is generous for a real payment.
  if (fee * 10n > sent) throw new Error("the fee would be more than a tenth of the amount — refusing");

  const psbt = new Psbt({ network: net });
  const finalizers = [];
  for (const c of coins) {
    const txHex = await chain.txHex(c.txid);
    finalizers.push(account.output.updatePsbtAsInput({ psbt, txHex, vout: c.vout }));
  }
  dest.updatePsbtAsOutput({ psbt, value: sent });
  if (change > 0n) account.output.updatePsbtAsOutput({ psbt, value: change });

  signers.signBIP32({ psbt, masterNode: account.signer() });
  for (const finalize of finalizers) finalize({ psbt });

  const tx = psbt.extractTransaction();
  return { hex: tx.toHex(), txid: tx.getId(), fee, sent, change };
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------
//
// A lock is the standard miniscript of spec/lock-format.md, written as a
// descriptor and handed to the library, which makes the script and address:
//
//   wsh(and_v(v:pk(owner),or_i(after(date),pk(cosigner))))
//
// The library check (lock/library-check) proved this gives byte-for-byte the
// testnet-proven script, and the app's tests prove it matches the address the
// register rebuilds (js/lockrecord.mjs). Locking is an ordinary send to that
// address. Going home is the library's own spend of the owner-alone branch,
// which sets the transaction's date itself; the network refuses it until the
// date has passed, whatever this code says.

const YEAR = 365.25 * 86400;
const DAY = 86400;
const PUBKEY = /^0[23][0-9a-f]{64}$/;

/**
 * The date a lock of `years` made now unlocks, as unix seconds. Rounded up to
 * the next midnight (UTC) so a lock reads as a plain date. Test Crowdlocks may
 * offer lengths under a day; those are not rounded.
 */
export function lockDate(years, nowSeconds = Math.floor(Date.now() / 1000)) {
  const t = Math.ceil(nowSeconds + years * YEAR);
  return years * YEAR < DAY ? t : Math.ceil(t / DAY) * DAY;
}

function lockDescriptor(account, cosignerPubkey, locktime) {
  return `wsh(and_v(v:pk(${account.keyExpression}),or_i(after(${locktime}),pk(${cosignerPubkey}))))`;
}

/**
 * The lock for this account, co-signer and date: its address and terms.
 * Refuses a co-signer that is the fan's own key (one person could then move
 * the coins any time) and anything that is not a date.
 */
export function lockFor({ account, cosignerPubkey, locktime }) {
  const cosigner = String(cosignerPubkey ?? "").toLowerCase();
  if (!PUBKEY.test(cosigner)) throw new Error("that co-signer key is not a compressed public key");
  if (cosigner.slice(2) === account.publicKey.slice(2)) {
    throw new Error("the co-signer key is your own key — that would not be a lock");
  }
  if (!Number.isInteger(locktime) || locktime < 500000000) throw new Error("a lock's date must be a date");
  const output = new Output({ descriptor: lockDescriptor(account, cosigner, locktime), network: account.network });
  return { address: output.getAddress(), ownerPubkey: account.publicKey, cosignerPubkey: cosigner, locktime };
}

/**
 * Lock everything waiting: one send of all confirmed waiting money to the
 * lock's address. Same refusals as any send.
 */
export async function buildLock({ account, chain, lock, feeRate }) {
  const check = lockFor({ account, cosignerPubkey: lock.cosignerPubkey, locktime: lock.locktime });
  if (check.address !== lock.address) throw new Error("those lock terms do not make that address — refusing");
  return buildSend({ account, chain, to: lock.address, amount: "all", feeRate });
}

/**
 * What state a lock is in, from the chain alone (spec/counting-rule.md):
 *   "empty"      nothing has ever been sent to it
 *   "arriving"   money is on its way, not yet confirmed
 *   "locked"     confirmed money, date still ahead
 *   "lapsed"     confirmed money, date passed — the owner may take it home
 *   "withdrawn"  it held money once and is empty now
 * `medianTime` is the chain's own clock, the one its date is judged by.
 */
export async function lockState({ chain, lock, medianTime }) {
  const coins = await chain.utxos(lock.address);
  const confirmed = coins.filter((c) => c.confirmed).reduce((s, c) => s + BigInt(c.value), 0n);
  const arriving = coins.filter((c) => !c.confirmed).reduce((s, c) => s + BigInt(c.value), 0n);
  let state;
  if (confirmed > 0n) state = lock.locktime > medianTime ? "locked" : "lapsed";
  else if (arriving > 0n) state = "arriving";
  else state = (await chain.everFunded(lock.address)) ? "withdrawn" : "empty";
  return { state, confirmed, arriving };
}

/**
 * Take a lapsed lock home: the owner alone spends every confirmed coin in it
 * back to their own address (or `to`), through the going-home branch.
 *
 * Refuses before the chain's clock has passed the date — the network would
 * refuse it anyway, but there is no reason to send something that must fail.
 * `ignoreDate` exists only so the tests can prove the network refuses it too.
 *
 * @param {{ account: any, chain: any, lock: any, feeRate: number, medianTime: number, to?: string, ignoreDate?: boolean }} args
 * @returns {Promise<{ hex: string, txid: string, fee: bigint, sent: bigint }>}
 */
export async function takeHome({ account, chain, lock, feeRate, medianTime, to, ignoreDate = false }) {
  const net = account.network;
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 1000) {
    throw new Error("fee rate must be between 1 and 1000 sats per vbyte");
  }
  if (!ignoreDate && !(medianTime > lock.locktime)) {
    throw new Error("this lock's date has not passed yet on the network's clock");
  }
  const check = lockFor({ account, cosignerPubkey: lock.cosignerPubkey, locktime: lock.locktime });
  if (check.address !== lock.address) throw new Error("those lock terms do not make that address — refusing");

  // signersPubKeys tells the library only the owner will sign, so it takes
  // the going-home branch and sets the transaction's date itself.
  const out = new Output({
    descriptor: lockDescriptor(account, check.cosignerPubkey, lock.locktime),
    network: net,
    signersPubKeys: [fromHex(account.publicKey)],
  });
  let dest;
  try { dest = new Output({ descriptor: `addr(${String(to ?? account.address).trim()})`, network: net }); }
  catch { throw new Error("that is not an address on this network"); }

  const coins = (await chain.utxos(lock.address)).filter((c) => c.confirmed);
  if (coins.length === 0) throw new Error("there is no confirmed money in this lock");
  const total = coins.reduce((s, c) => s + BigInt(c.value), 0n);

  const weight = 44 + coins.length * out.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES") + dest.outputWeight();
  const fee = BigInt(Math.ceil((weight / 4) * feeRate));
  const sent = total - fee;
  if (sent < DUST_SATS) throw new Error("the fee would take almost all of it — too little to bring home");
  // Half, not a tenth: bringing a small lock home is still worth doing.
  if (fee * 2n > total) throw new Error("the fee would be more than half of the lock — refusing");

  const psbt = new Psbt({ network: net });
  const finalizers = [];
  for (const c of coins) {
    finalizers.push(out.updatePsbtAsInput({ psbt, txHex: await chain.txHex(c.txid), vout: c.vout }));
  }
  dest.updatePsbtAsOutput({ psbt, value: sent });
  signers.signBIP32({ psbt, masterNode: account.signer() });
  for (const finalize of finalizers) finalize({ psbt });
  const tx = psbt.extractTransaction();
  return { hex: tx.toHex(), txid: tx.getId(), fee, sent };
}

// ---------------------------------------------------------------------------
// Signing a Crowdlock's declaration
// ---------------------------------------------------------------------------

/**
 * Sign a membership statement with the account's key, as a standard Bitcoin
 * Signed Message — the same kind Sparrow and Electrum produce, and the kind
 * member 1's Ledger signature is. Returns the base64 signature.
 *
 * The signing itself is the library's (deterministic, low-S, with the recovery
 * number a signed message carries). Ours is only the standard first byte:
 * 31 + recovery number, meaning "compressed key".
 */
export function signStatement(account, statement) {
  const node = account.signer().derivePath(account.path);
  const { signature, recoveryId } = ecc.signRecoverable(messageHash(statement), node.privateKey);
  const out = new Uint8Array(65);
  out[0] = 31 + recoveryId;
  out.set(signature, 1);
  return toBase64(out);
}

// ---------------------------------------------------------------------------

function toBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromHex(hex) {
  return Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
}

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
