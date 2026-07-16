import type { ArbitrageEntry, DucatEntry } from './types';

interface Store {
  arbitrage: Map<string, ArbitrageEntry>;
  ducats: Map<string, DucatEntry>;
  // Guards so instrumentation's register() can be called more than
  // once (Next.js docs recommend not assuming exactly-once) without
  // stacking up duplicate polling loops.
  loopsStarted: { arbitrage: boolean; ducats: boolean };
  // Lets the frontend distinguish "no matches yet" from
  // "first scrape hasn't finished yet".
  ready: { arbitrage: boolean; ducats: boolean };
}

type GlobalWithStore = typeof globalThis & {
  __warframeMarketStore__?: Store;
};

const g = globalThis as GlobalWithStore;

function initStore(): Store {
  if (!g.__warframeMarketStore__) {
    g.__warframeMarketStore__ = {
      arbitrage: new Map(),
      ducats: new Map(),
      loopsStarted: { arbitrage: false, ducats: false },
      ready: { arbitrage: false, ducats: false },
    };
  }
  return g.__warframeMarketStore__;
}

export const store = initStore();

export function isFresh(
  entry: { last_updated?: string } | undefined,
  maxAgeMs: number
): boolean {
  if (!entry?.last_updated) return false;
  const updatedAt = new Date(entry.last_updated).getTime();
  if (Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt <= maxAgeMs;
}
