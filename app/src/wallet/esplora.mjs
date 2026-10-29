// The chain, as seen through an Esplora-style block explorer API (the kind
// mempool.space and Blockstream run). Network code only: nothing here sees a
// key. The key module asks its questions through the object this returns, so
// it can be pointed at any explorer — including one the fan runs themselves.

export function esploraChain(baseUrl, fetchImpl = globalThis.fetch) {
  const get = async (path, as = "json") => {
    const res = await fetchImpl(`${baseUrl}${path}`);
    if (!res.ok) throw new Error(`the block explorer answered ${res.status}`);
    return as === "json" ? res.json() : res.text();
  };
  return {
    async utxos(address) {
      const list = await get(`/address/${address}/utxo`);
      return list.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
    },
    txHex: (txid) => get(`/tx/${txid}/hex`, "text"),
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
      const text = await res.text();
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
