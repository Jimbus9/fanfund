// The relay inbox job. Run by .github/workflows/relay-inbox.yml every few
// minutes, in the Crowdlock's own repository, with no secrets: it writes only
// to its own register files, and the workflow commits them.
//
// For every Crowdlock file in crowdlocks/ that names relays: collect the
// records posted for it, put each through the endpoints' own judgement
// (js/inbox.mjs), and write the register if anything was added. Prints one
// line per record, so the job's log is a public account of what was taken
// and what was refused, and why.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRecords } from "../js/inbox.mjs";
import { membershipStatement, checkCrowdlock } from "../js/crowdlock.mjs";
import { fetchRecords } from "./nostr.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Records are looked for over the last 90 days and judged afresh each run, so
// a lock posted before it confirmed is added once it has, and a job that was
// asleep for a while catches up.
const WINDOW = 90 * 86400;

const now = Math.floor(Date.now() / 1000);
const today = new Date().toISOString().slice(0, 10);
const messages = [];

for (const file of readdirSync(join(ROOT, "crowdlocks")).filter((f) => f.endsWith(".json") && f !== "index.json")) {
  const crowdlock = JSON.parse(readFileSync(join(ROOT, "crowdlocks", file), "utf8"));
  if (!Array.isArray(crowdlock.relays)) continue;
  const declarationText = readFileSync(join(ROOT, crowdlock.declaration.file), "utf8");
  const ok = checkCrowdlock(crowdlock, { declarationText });
  if (!ok.ok) { console.log(`${file}: skipped, its file does not check out: ${ok.problems.join("; ")}`); continue; }

  const regPath = join(ROOT, crowdlock.register.registrations);
  const register = JSON.parse(readFileSync(regPath, "utf8"));
  const { events, report } = await fetchRecords(crowdlock.relays, crowdlock.declaration.sha256, now - WINDOW);
  for (const r of report) console.log(`${file}: ${r.relay} ${r.ok ? `answered, ${r.count} record(s)` : `did not answer (${r.reason})`}`);
  if (!report.some((r) => r.ok)) { console.log(`${file}: no relay answered — nothing changed`); continue; }

  const confirmedSats = async (address) => {
    const res = await fetch(`${crowdlock.chain_api}/address/${address}`);
    if (!res.ok) throw new Error(String(res.status));
    const s = (await res.json()).chain_stats;
    return s.funded_txo_sum - s.spent_txo_sum;
  };
  const result = await applyRecords(register, events, {
    crowdlock, statement: membershipStatement(crowdlock), now, today, confirmedSats,
  });
  for (const o of result.outcome) {
    console.log(`${file}: ${o.type} ${o.address} — ${o.added ? `ADDED${o.n ? ` (member ${o.n})` : ""}` : `not added: ${o.reason}`}`);
    if (o.added) messages.push(o.type === "join" ? `Member ${o.n} (via relays)` : `Lock for member ${o.n} (via relays)`);
  }
  if (result.register !== register) {
    writeFileSync(regPath, JSON.stringify(result.register, null, 2) + "\n");
  }
}

// The workflow uses this as the commit message, if anything changed.
if (messages.length) writeFileSync(join(ROOT, "relay", ".message"), messages.join(", "));
