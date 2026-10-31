// Keeping a Crowdlock's relays alive. Pure: no network, no clock.
//
// Each pass of the inbox reports which relays answered. This records, per
// relay, the day it last answered and the day it went silent, changing only
// when one of those changes, so the repository gets at most a commit a day
// from it. A relay silent for SILENT_DAYS is swapped for the first spare the
// Crowdlock file published in advance. Every swap is a commit saying which
// relay went, since when, and what replaced it.
//
// A pass in which NO relay answered says nothing about the relays — it is far
// more likely the job's own connection — so it changes nothing.

export const SILENT_DAYS = 7;

const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/**
 * Record one pass.
 *   health   { [relay]: { lastAnswered, silentSince } } — dates "YYYY-MM-DD"
 *   report   [{ relay, ok }] from the pass
 * Returns the new health record (the same object if nothing changed).
 */
export function recordPass(health, report, today) {
  if (!report.some((r) => r.ok)) return health;
  let changed = false;
  const next = { ...health };
  for (const { relay, ok } of report) {
    const was = health[relay] ?? { lastAnswered: null, silentSince: null };
    const now = ok
      ? { lastAnswered: today, silentSince: null }
      : { lastAnswered: was.lastAnswered, silentSince: was.silentSince ?? today };
    if (now.lastAnswered !== was.lastAnswered || now.silentSince !== was.silentSince || !health[relay]) {
      next[relay] = now; changed = true;
    }
  }
  return changed ? next : health;
}

/**
 * Swap out relays silent for SILENT_DAYS or more, in the order listed, each for
 * the next unused spare. Returns { crowdlock, health, swaps, stuck } — stuck
 * lists silent relays with no spare left to replace them.
 */
export function planSwaps(crowdlock, health, today) {
  const relays = [...(crowdlock.relays ?? [])];
  const spares = [...(crowdlock.spare_relays ?? [])];
  const swaps = [], stuck = [];
  const nextHealth = { ...health };
  relays.forEach((relay, i) => {
    const h = health[relay];
    if (!h?.silentSince || daysBetween(h.silentSince, today) < SILENT_DAYS) return;
    const replacement = spares.shift();
    if (!replacement) { stuck.push(relay); return; }
    relays[i] = replacement;
    delete nextHealth[relay];
    swaps.push({ out: relay, in: replacement, silentSince: h.silentSince });
  });
  if (swaps.length === 0) return { crowdlock, health, swaps, stuck };
  const next = { ...crowdlock, relays };
  if (crowdlock.spare_relays) next.spare_relays = spares;
  return { crowdlock: next, health: nextHealth, swaps, stuck };
}
