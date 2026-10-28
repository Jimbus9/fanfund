// Milestone 1 runs on testnet4: free test money, the same rules as the real
// network. It is labelled on every screen so nobody mistakes it for real
// bitcoin. Switching to mainnet is one line here, and happens only after the
// outside review at milestone 7.
// @ts-ignore — plain module shared with the chain tests
import { esploraChain, EXPLORERS } from "./wallet/esplora.mjs";

export const NETWORK = "testnet4" as const;
export const IS_TEST_MONEY = true;
export const chain = esploraChain(EXPLORERS[NETWORK]);
export const EXPLORER_WEB = "https://mempool.space/testnet4";
