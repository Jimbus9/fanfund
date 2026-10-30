// Posting a signed registration or lock to a Crowdlock's Nostr relays, for its
// own repository to collect (js/inbox.mjs). Network code only: the record is
// already signed by the key module, or is pure facts about the chain. Signing
// the wrapping Nostr event and the relay protocol are nostr-tools', with a
// throwaway Nostr key each time — the Nostr signature is transport only.

import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { recordEventTemplate } from "../../js/inbox.mjs";

const TIMEOUT = 12000;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("no answer")), ms))]);

/**
 * Post one record to every relay the Crowdlock names.
 * Returns { ok, accepted, total, failures } — ok if at least one relay took it.
 */
export async function postToRelays(crowdlock, record) {
  const relays = crowdlock.relays ?? [];
  const event = finalizeEvent(
    recordEventTemplate(record, crowdlock.declaration.sha256, Math.floor(Date.now() / 1000)),
    generateSecretKey(),
  );
  const results = await Promise.all(relays.map(async (url) => {
    let relay;
    try {
      relay = await withTimeout(Relay.connect(url), TIMEOUT);
      await withTimeout(relay.publish(event), TIMEOUT);
      return { url, ok: true };
    } catch (e) { return { url, ok: false, reason: String(e?.message ?? e) }; }
    finally { try { relay?.close(); } catch {} }
  }));
  const accepted = results.filter((r) => r.ok).length;
  return { ok: accepted > 0, accepted, total: relays.length, failures: results.filter((r) => !r.ok) };
}
