function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  apiBase: process.env.WARFRAME_API_BASE || 'https://api.warframe.market/v2',
  // v1 hosts the per-item statistics endpoint (48h/90d closed-trade volume)
  // that v2 doesn't expose. Derived from apiBase so WARFRAME_API_BASE still
  // redirects both versions together.
  v1ApiBase:
    (process.env.WARFRAME_API_BASE || 'https://api.warframe.market/v2').replace(
      /\/v\d+\/?$/,
      '/v1'
    ),

  // Process-wide cap on simultaneous in-flight warframe.market fetches.
  // All loops (catalog build + arbitrage + ducats sweeps) funnel through one
  // semaphore in httpClient.ts sized to this, so their HOT_CONCURRENCY /
  // CATALOG_CONCURRENCY worker pools can never stack beyond this many
  // concurrent downstream requests. Default 2 stays under warframe.market's
  // measured ~3 req/s ceiling; requestDelayMs is the sustained-rate gate,
  // this is just the burst cap. Raise cautiously.
  maxConcurrentRequests: num(process.env.MAX_CONCURRENT_REQUESTS, 2),
  // Delay after each successful request, seconds (matches old REQUEST_DELAY)
  requestDelayMs: num(process.env.REQUEST_DELAY, 0.35) * 1000,

  // Wait time after a 429, seconds (matches old RATE_LIMIT_DELAY)
  rateLimitDelayMs: num(process.env.RATE_LIMIT_DELAY, 10) * 1000,

  // Time between full scrape cycles, seconds (matches old RETRY_INTERVAL)
  retryIntervalMs: num(process.env.RETRY_INTERVAL, 600) * 1000,
  // Hot-loop: time between price/volume sweeps, seconds.
  hotRetryIntervalMs: num(process.env.HOT_RETRY_INTERVAL, 120) * 1000,
  // Hot-loop: max sets/prime entries processed in parallel within one sweep.
  // warframe.market rate-limits aggressively - measured tolerable sustained
  // rate is below ~3 req/s. Default 2 keeps the hot sweep parallel without
  // 429-storming; the per-request requestDelayMs is the primary rate gate,
  // this just bounds the burst. Tune up cautiously.
  hotConcurrency: num(process.env.HOT_CONCURRENCY, 2),
  // Catalog: max sets/prime entries built in parallel during a cold build.
  // Same rate-limit ceiling as the hot loop applies here - the cold build
  // runs concurrently with the hot sweep, so the two pools' worker counts
  // stack against the same downstream limit. Default 2 keeps the cold build
  // parallel enough to finish in single-digit minutes without 429-storming.
  catalogConcurrency: num(process.env.CATALOG_CONCURRENCY, 2),
  // Catalog: time between full catalog rebuilds, seconds.
  catalogRefreshMs: num(process.env.CATALOG_REFRESH_SECONDS, 6 * 60 * 60) * 1000,
  // Cold loop: retry interval while no catalog has ever been built. Once a
  // build has produced a catalog, the full catalogRefreshMs kicks in. Keeping
  // this short means a flaky first build self-corrects in seconds instead of
  // sitting idle for hours showing nothing.
  coldRetryMs: num(process.env.COLD_RETRY_SECONDS, 30) * 1000,

  minArbitrageValue: num(process.env.MIN_ARBITRAGE_VALUE, 10),
  minDucatPerPlatinum: num(process.env.MIN_DUCAT_PER_PLATINUM, 0),
  minDucats: num(process.env.MIN_DUCATS, 0),

  // Arbitrage: minimum 48h closed-trade volume for a set to clear the bar.
  // Stops the table from surfacing Sets whose "profit" is just a stale offer
  // on an item nobody actually trades.
  minVolume: num(process.env.MIN_VOLUME, 2),
};
