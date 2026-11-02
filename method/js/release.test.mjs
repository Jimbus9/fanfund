// Tests release.mjs against spends built by the lock's own reference code
// (method/lock/lock.mjs), turned into the JSON a block explorer returns. The
// two share no code, so if the detector reads these right it reads the chain
// right.
//
// Run:  node method/js/release.test.mjs      (from the repo root, after npm ci in method/lock)

import { ECPair, lockAddress, buildSpend, networkFor } from "../lock/lock.mjs";
import { isCoSigned, isListedDestination, earlyReleases } from "./release.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failures++;
};

const network = networkFor("mainnet");
const fan = ECPair.makeRandom({ network });
const cos = ECPair.makeRandom({ network });
const locktime = 1893456000; // 1 Jan 2030
const lock = lockAddress({ fanPubkey: Buffer.from(fan.publicKey), cosignerPubkey: Buffer.from(cos.publicKey), locktime, network });
const value = 500000;
const utxo = { txid: "11".repeat(32), vout: 0, value };
const elsewhere = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const shop = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";

// The same coin opened both ways, as an explorer would report each.
const asExplorer = (built, blockTime) => ({
  txid: built.txid,
  status: blockTime ? { confirmed: true, block_time: blockTime } : { confirmed: false },
  vin: [{ prevout: { scriptpubkey_address: lock.address, value }, witness: built.tx.ins[0].witness.map((b) => Buffer.from(b).toString("hex")) }],
  vout: built.tx.outs.map((o) => ({ value: o.value, scriptpubkey_address: o === built.tx.outs[0] ? built.dest : null })),
});
const spend = (route, destination) => {
  const b = buildSpend({ utxo, witnessScript: lock.witnessScript, destination, feeSats: 1000, route, fanKey: fan, cosignerKey: cos, locktime, network });
  return { ...b, dest: destination };
};
const home = spend("home", elsewhere);
const coSignedAway = spend("purchase", elsewhere);
const coSignedToShop = spend("purchase", shop);

check("A spend on its date is not read as co-signed", !isCoSigned(asExplorer(home, locktime + 10).vin[0]));
check("A co-signed spend is read as co-signed", isCoSigned(asExplorer(coSignedAway, 1).vin[0]));

const L = { address: lock.address, locktime, cosigner_pubkey: Buffer.from(cos.publicKey).toString("hex") };
const before = locktime - 86400 * 365;

const early = earlyReleases(L, [asExplorer(coSignedAway, before)]);
check("Co-signed before its date, not to a destination: an early release",
  early.length === 1 && early[0].sats === value && early[0].paidTo === elsewhere && early[0].cosigner === L.cosigner_pubkey);
check("…and one still waiting for a block counts too",
  earlyReleases(L, [asExplorer(coSignedAway, null)], null, before).length === 1);
check("Co-signed after its date isn't one — the owner could have done that alone",
  earlyReleases(L, [asExplorer(coSignedAway, locktime + 60)]).length === 0);
check("Opened by its owner on its date isn't one",
  earlyReleases(L, [asExplorer(home, locktime + 60)]).length === 0);

const list = { entries: [{ index: 1, op: "add", address: shop }] };
check("Co-signed to a listed destination is a purchase, not a release",
  earlyReleases(L, [asExplorer(coSignedToShop, before)], list).length === 0);
check("With the list empty, as it is today, every co-signed early spend is a release",
  earlyReleases(L, [asExplorer(coSignedToShop, before)], { entries: [] }).length === 1);
const revoked = { entries: [{ index: 1, op: "add", address: shop }, { index: 2, op: "revoke", address: shop }] };
check("A revoked destination doesn't count as listed", !isListedDestination(shop, revoked) && isListedDestination(shop, list));
check("Re-added after a revocation, it does", isListedDestination(shop, { entries: [...revoked.entries, { index: 3, op: "add", address: shop }] }));
check("Other addresses' spends in the same history are ignored",
  earlyReleases({ ...L, address: elsewhere }, [asExplorer(coSignedAway, before)]).length === 0);
check("No history, or a broken one, finds nothing rather than failing",
  earlyReleases(L, undefined).length === 0 && earlyReleases(L, [{}]).length === 0);

console.log(failures === 0 ? "\nAn early release by the co-signer is caught; a purchase or a spend on its date is not." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
