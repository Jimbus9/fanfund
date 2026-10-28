// Prove the paper works. Run this after generating, and again after wiping.
//
//   node cosigner/restore.mjs
//
// A backup nobody has ever restored is not a backup; it is a hope. This is
// the one moment when finding out costs nothing, so it is worth doing twice:
//
//   1. Straight after generating, from the paper you just wrote, to catch a
//      misheard word or a swapped line while the words are still on screen.
//   2. After wiping the machine and rebuilding it from scratch, to prove the
//      whole thing really can be reconstructed from twenty-four words and
//      nothing else. That second run is the one that matters, and it is the
//      step most people skip.
//
// It reads the words from the keyboard, compares the key they produce against
// cosigner-pubkey.txt if that file is there, and says plainly whether they
// match. Nothing is written and nothing leaves this machine.

import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pubkeyFromWords, PATH } from "./generate.mjs";

const line = (s = "") => console.log(s);
const rule = () => line("=".repeat(74));

line();
rule();
line("  RESTORING THE CO-SIGNER KEY FROM THE WORDS");
rule();
line();
line("  Type all twenty-four words, separated by spaces, then press Enter.");
line("  Read them off the paper, not off a screen — the paper is what you");
line("  are testing.");
line();

const rl = createInterface({ input: stdin, output: stdout });
const typed = await rl.question("  Words: ");
rl.close();

let pubkey;
try {
  pubkey = pubkeyFromWords(typed);
} catch (e) {
  line();
  rule();
  line(`  THOSE WORDS DO NOT WORK: ${e.message}`);
  rule();
  line();
  line("  The recovery phrase has a checksum built into it, so a single wrong");
  line("  or misplaced word is caught here rather than silently producing a");
  line("  different key. Check the spelling and the order and try again.");
  line();
  process.exit(1);
}

line();
line(`  Path    ${PATH}`);
line(`  Key     ${pubkey}`);
line();

const expectedPath = new URL("./cosigner-pubkey.txt", import.meta.url);
if (!existsSync(expectedPath)) {
  rule();
  line("  Those words are valid, but there is no cosigner-pubkey.txt here to");
  line("  compare against, so this has only proved the phrase is well formed.");
  line("  Check the key above against the one you published.");
  rule();
  line();
  process.exit(0);
}

const expected = readFileSync(expectedPath, "utf8").trim();

line();
rule();
if (pubkey === expected) {
  line("  MATCH. The paper really does rebuild the key.");
  rule();
  line();
  line("  That is the backup proved rather than assumed. The machine is now");
  line("  disposable: lose it, drop it, let the card rot — the words bring");
  line("  the co-signer back.");
} else {
  line("  NO MATCH. STOP.");
  rule();
  line();
  line(`  Expected  ${expected}`);
  line(`  Got       ${pubkey}`);
  line();
  line("  The words you typed make a valid phrase, but not this key. Either a");
  line("  word is wrong in a way the checksum did not catch, or the paper was");
  line("  written from a different run.");
  line();
  line("  Do not publish anything and do not rely on that paper. Generate");
  line("  again and write it down more carefully.");
}
rule();
line();
process.exit(pubkey === expected ? 0 : 1);
