// Make the co-signer key. Run this once, on a machine that is already offline.
//
//   node cosigner/generate.mjs
//
// WHAT THIS KEY IS. It is the fund's half of every lock's purchase exit. It
// cannot move a single coin on its own — that is proved in
// lock/library-check/cosigner.mjs against a node enforcing consensus — and it
// cannot send anybody's money anywhere except where that supporter already
// signed for it to go. What it can do is refuse, and what it must never do is
// disappear, because a fund that cannot co-sign can never buy anything.
//
// SO THE PAPER IS THE KEY, NOT THE MACHINE. The twenty-four words below are
// the co-signer. The computer running this is an appliance: it can be dropped
// in a canal and rebuilt from the words in twenty minutes. Protect the paper
// and nothing else about this machine matters.
//
// The words are never written to disk by this script, on purpose. Write them
// down by hand. A file is copied, synced, backed up and recovered by things
// you did not ask; paper is not.
//
// RECOVERABLE WITHOUT US. The key sits at m/84'/0'/0'/0/0 — the first address
// of a standard native segwit account. If this repository, this script and
// everybody involved vanish, the words still restore in Sparrow, Electrum or
// any ordinary wallet, and the key is the first one it shows you. That was
// chosen deliberately over a clever path that only our own code understands.

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";

export const PATH = "m/84'/0'/0'/0/0";

/** The co-signer public key these words produce. Used by restore.mjs too. */
export function pubkeyFromWords(words) {
  const mnemonic = words.trim().toLowerCase().split(/\s+/).join(" ");
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error("those words are not a valid recovery phrase — check the spelling and the order");
  }
  const key = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derive(PATH);
  return Buffer.from(key.publicKey).toString("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const line = (s = "") => console.log(s);
  const rule = () => line("=".repeat(74));

  // 256 bits from the operating system's own source, which is what every
  // wallet uses. Not Math.random, not anything of ours.
  const mnemonic = bip39.generateMnemonic(wordlist, 256);
  const words = mnemonic.split(" ");
  const pubkey = pubkeyFromWords(mnemonic);

  line();
  rule();
  line("  THE CO-SIGNER KEY — WRITE THESE WORDS DOWN NOW, ON PAPER");
  rule();
  line();
  for (let i = 0; i < words.length; i += 4) {
    line("   " + words.slice(i, i + 4)
      .map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(10)}`)
      .join(""));
  }
  line();
  rule();
  line();
  line("  Two copies, by hand. One of them leaves the house.");
  line();
  line("  Label them, or they are useless to whoever finds them in five");
  line("  years, including you:");
  line();
  line("      The Kop Fund co-signer key");
  line(`      ${new Date().toISOString().slice(0, 10)}   path ${PATH}`);
  line();
  line("  These words are not saved anywhere. Close this and they are gone.");
  line();
  rule();
  line();
  line("  THE PUBLIC HALF — this one is safe to share, and goes on the website");
  line();
  line(`      ${pubkey}`);
  line();

  // Only the public half touches the disk. It has to leave on a USB stick,
  // and retyping 66 characters by hand is how a wrong key reaches the site.
  const out = new URL("./cosigner-pubkey.txt", import.meta.url);
  writeFileSync(out, `${pubkey}\n`);
  line(`  Saved to cosigner-pubkey.txt so you can copy it onto a USB stick.`);
  line("  Nothing secret is in that file.");
  line();
  rule();
  line();
  line("  BEFORE YOU TRUST ANY OF THIS, prove the words work:");
  line();
  line("      node cosigner/restore.mjs");
  line();
  line("  Type the words back in. If it shows the same public key, your");
  line("  paper is a real backup. If it does not, you have found that out");
  line("  now rather than on the day the machine dies.");
  line();
  rule();
  line();
}
