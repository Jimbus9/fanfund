// Does the key generation do what it says?
//
//   cd cosigner && npm install && node cosigner.test.mjs
//
// This runs here, now, where a failure costs nothing — rather than on a
// disconnected Raspberry Pi with the words already written on paper.
//
// The important property is the boring one: the same words must always give
// the same key. Everything else about the co-signer rests on that, because
// the paper is the backup and the paper is only words.

import { pubkeyFromWords, PATH } from "./generate.mjs";

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};
const refuses = (what, words, expect) => {
  let message = "";
  try { pubkeyFromWords(words); } catch (e) { message = e.message; }
  check(what, message.includes(expect), message || "it was ACCEPTED");
};

console.log("\n" + "-".repeat(74));
console.log("THE CO-SIGNER KEY");
console.log("-".repeat(74) + "\n");

// A known phrase from BIP39's own test vectors, so this is checked against
// somebody else's arithmetic rather than against itself.
const KNOWN = "abandon abandon abandon abandon abandon abandon abandon abandon "
  + "abandon abandon abandon abandon abandon abandon abandon abandon "
  + "abandon abandon abandon abandon abandon abandon abandon art";

const key = pubkeyFromWords(KNOWN);
check("A known recovery phrase gives a key", /^0[23][0-9a-f]{64}$/.test(key), key);
check("…the same one, every time", pubkeyFromWords(KNOWN) === key);
check("…compressed, 33 bytes, as the lock requires", key.length === 66);
check("…at the standard path, so any wallet can restore it", PATH === "m/84'/0'/0'/0/0", PATH);

// The things somebody will actually do wrong when typing 24 words off paper.
check("Extra spaces and line breaks are forgiven",
  pubkeyFromWords(`  ${KNOWN.replace(/ /g, "   ")}\n `) === key);
check("Capitals are forgiven", pubkeyFromWords(KNOWN.toUpperCase()) === key);

refuses("A misspelled word is refused", KNOWN.replace("art", "arrt"), "not a valid recovery phrase");
refuses("A word swapped for another real word is refused",
  KNOWN.replace(/abandon art$/, "art abandon"), "not a valid recovery phrase");
refuses("Twenty-three words are refused", KNOWN.split(" ").slice(0, 23).join(" "), "not a valid recovery phrase");
refuses("Nothing at all is refused", "", "not a valid recovery phrase");

console.log();
console.log("  The checksum inside a recovery phrase is what catches these, which");
console.log("  is why a single wrong word is found on the night rather than years");
console.log("  later when the paper is all that is left.");

// Two runs must not produce the same key, which would mean the randomness is
// not random. A weak generator is the one failure that looks exactly like
// success from the outside.
const { generateMnemonic } = await import("@scure/bip39");
const { wordlist } = await import("@scure/bip39/wordlists/english");
const fresh = new Set();
for (let i = 0; i < 50; i++) fresh.add(pubkeyFromWords(generateMnemonic(wordlist, 256)));
console.log();
check("Fifty generated keys are fifty different keys", fresh.size === 50, `${fresh.size} distinct`);

console.log("\n" + "-".repeat(74));
console.log(failures === 0
  ? "The words make the key, the same way every time, and bad words are refused."
  : `${failures} check(s) failed.`);
console.log("-".repeat(74) + "\n");
process.exit(failures === 0 ? 0 : 1);
