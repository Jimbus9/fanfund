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

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
