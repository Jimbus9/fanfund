// The chain, as seen through an Esplora-style block explorer API (the kind
// mempool.space and Blockstream run). Network code only: nothing here sees a
// key. The key module asks its questions through the object this returns, so
// it can be pointed at any explorer — including one the fan runs themselves.

// A request the explorer never answers would leave the app spinning forever,
// so every request gives up after this long and says why.
export const TIMEOUT_MS = 20000;

function withTimeout(fetchImpl, ms) {
  return async (url, init = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fetchImpl(url, { ...init, signal: ctrl.signal }); }
    catch (e) {
      if (ctrl.signal.aborted) {
        throw new Error(`the block explorer didn't answer within ${ms / 1000} seconds — check your connection, or turn off any VPN, and try again`);
      }
      throw new Error("couldn't reach the block explorer — check your connection, or turn off any VPN, and try again");
    } finally { clearTimeout(timer); }
  };
}

// Free explorers turn away anyone who asks too much too fast (HTTP 429). A
// Crowdlock page asks a lot at once, so three things keep the app under the
// limit: the same question asked within a short while gets the answer already
// in hand (and one already on its way is waited for, not asked twice); a
// "too many" is waited out and tried again; and if it still fails, the fan is
// told plainly what's going on.
export const REMEMBER_MS = 20000;
export const RETRIES = 2;
export const BUSY = "the block explorer is busy — wait a minute and tap Refresh";
// One memory per way of fetching, so every screen shares it but tests don't.
const memories = new WeakMap();
const busy = (status) => status === 429 || status === 503;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function esploraChain(baseUrl, rawFetch = globalThis.fetch, timeoutMs = TIMEOUT_MS,
  { rememberMs = REMEMBER_MS, retries = RETRIES, wait = pause } = {}) {
  const fetchImpl = withTimeout(rawFetch, timeoutMs);
  if (!memories.has(rawFetch)) memories.set(rawFetch, new Map());
  const memory = memories.get(rawFetch);
  const ask = async (url, as) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url);
      if (res.ok) return as === "json" ? res.json() : res.text();
      if (!busy(res.status)) throw new Error(`the block explorer answered ${res.status}`);
      if (attempt >= retries) throw new Error(BUSY);
      // Honour the explorer's own "try again in N seconds", within reason.
      const said = Number(res.headers?.get?.("retry-after"));
      await wait(Number.isFinite(said) && said > 0 ? Math.min(said, 10) * 1000 : 2000 * (attempt + 1));
    }
  };
  const get = (path, as = "json") => {
    const url = `${baseUrl}${path}`;
    const key = `${as} ${url}`;
    const held = memory.get(key);
    if (held && Date.now() - held.at < rememberMs) return held.answer;
    const answer = ask(url, as);
    memory.set(key, { at: Date.now(), answer });
    answer.catch(() => { if (memory.get(key)?.answer === answer) memory.delete(key); });
    return answer;
  };
  // Anything sent changes what the chain will say, so forget what it said.
  const forget = () => { for (const k of [...memory.keys()]) if (k.includes(baseUrl)) memory.delete(k); };
  return {
    async utxos(address) {
      const list = await get(`/address/${address}/utxo`);
      return list.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
    },
    txHex: (txid) => get(`/tx/${txid}/hex`, "text"),
    /** The address's transactions, newest first, with each input's witness. */
    txs: (address) => get(`/address/${address}/txs`),
    /** Has anything ever been sent to this address, confirmed or not? */
    async everFunded(address) {
      const a = await get(`/address/${address}`);
      return (a.chain_stats?.funded_txo_count ?? 0) + (a.mempool_stats?.funded_txo_count ?? 0) > 0;
    },
    /**
     * The chain's own clock: the median time of the last eleven blocks. A
     * lock's date is judged against this, not against any phone's clock, and
     * it runs about an hour behind real time.
     */
    async medianTime() {
      const hash = await get("/blocks/tip/hash", "text");
      return (await get(`/block/${hash.trim()}`)).mediantime;
    },
    /** A fee rate likely to confirm within about half an hour, sats/vbyte. */
    async feeRate() {
      try { const f = await get("/v1/fees/recommended"); return Math.max(1, Math.ceil(f.halfHourFee)); }
      catch { return 2; }
    },
    async broadcast(hex) {
      const res = await fetchImpl(`${baseUrl}/tx`, { method: "POST", body: hex });
      forget();
      const text = await res.text();
      if (busy(res.status)) throw new Error(`${BUSY} — nothing was sent`);
      if (!res.ok) throw new Error(`the network refused it: ${text.slice(0, 160)}`);
      return text.trim(); // the txid
    },
  };
}

/** Public explorers by network. A fan can swap in their own. */
export const EXPLORERS = {
  mainnet: "https://mempool.space/api",
  testnet4: "https://mempool.space/testnet4/api",
  signet: "https://mempool.space/signet/api",
};
