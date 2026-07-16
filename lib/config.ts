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

  // Delay after each successful request, seconds (matches old REQUEST_DELAY)
  requestDelayMs: num(process.env.REQUEST_DELAY, 0.35) * 1000,

  // Wait time after a 429, seconds (matches old RATE_LIMIT_DELAY)
  rateLimitDelayMs: num(process.env.RATE_LIMIT_DELAY, 10) * 1000,

  // Time between full scrape cycles, seconds (matches old RETRY_INTERVAL)
  retryIntervalMs: num(process.env.RETRY_INTERVAL, 600) * 1000,

  minArbitrageValue: num(process.env.MIN_ARBITRAGE_VALUE, 10),
  minDucatPerPlatinum: num(process.env.MIN_DUCAT_PER_PLATINUM, 0),
  minDucats: num(process.env.MIN_DUCATS, 0),

  // Arbitrage: minimum 48h closed-trade volume for a set to clear the bar.
  // Stops the table from surfacing Sets whose "profit" is just a stale offer
  // on an item nobody actually trades.
  minVolume: num(process.env.MIN_VOLUME, 2),

  // How old an entry can be before it's hidden from the API response
  maxDataAgeMs: num(process.env.MAX_DATA_AGE_SECONDS, 1800) * 1000,
};
