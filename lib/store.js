const GLOBAL_KEY = '__warframeMarketStore__';

function initStore() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = {
      arbitrage: new Map(),
      ducats: new Map(),
      // Guards so instrumentation's register() can be called more than
      // once (Next.js docs recommend not assuming exactly-once) without
      // stacking up duplicate polling loops.
      loopsStarted: { arbitrage: false, ducats: false },
      // Lets the frontend distinguish "no matches yet" from
      // "first scrape hasn't finished yet".
      ready: { arbitrage: false, ducats: false },
    };
  }
  return globalThis[GLOBAL_KEY];
}

export const store = initStore();

export function isFresh(entry, maxAgeMs) {
  if (!entry?.last_updated) return false;
  const updatedAt = new Date(entry.last_updated).getTime();
  if (Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt <= maxAgeMs;
}
