import { readFileSync } from 'node:fs';

// All knobs live in config.yaml at the repo root. PORT for the dashboard
// itself is NOT here - Next.js reads it from the process environment before
// any app code runs, so it lives in .env.local. See config.yaml.example for
// docs on every field.
//
// Every field has a baked-in default; a missing or partially-populated
// config.yaml is fine. Units in the YAML are human (seconds); the in-app
// object exposes milliseconds (XxxMs) since every consumer sleeps in ms.

type NumberMap = { [k: string]: number | undefined };

type RawConfig = {
  rateLimit?: NumberMap;
  hot?: NumberMap;
  catalog?: NumberMap;
  filters?: NumberMap;
};

const CONFIG_PATH = new URL('../config.yaml', import.meta.url).pathname;

function loadRaw(): RawConfig {
  try {
    const text = readFileSync(CONFIG_PATH, 'utf8');
    return text.trim() ? (Bun.YAML.parse(text) as RawConfig) : {};
  } catch {
    return {};
  }
}

const raw = loadRaw();
const rateLimit = raw.rateLimit ?? {};
const hot = raw.hot ?? {};
const catalog = raw.catalog ?? {};
const filters = raw.filters ?? {};

const API_BASE = 'https://api.warframe.market/v2';
const V1_API_BASE = API_BASE.replace(/\/v\d+\/?$/, '/v1');

function num(value: number | undefined, fallback: number): number {
  return Number.isFinite(value as number) ? (value as number) : fallback;
}

export const config = {
  apiBase: API_BASE,
  // v1 hosts the per-item statistics endpoint (48h closed-trade volume) that
  // v2 doesn't expose. Derived from API_BASE by swapping /v2 → /v1.
  v1ApiBase: V1_API_BASE,

  // Process-wide cap on simultaneous in-flight warframe.market fetches.
  // All loops (catalog build + arbitrage + ducats sweeps) funnel through one
  // semaphore in httpClient.ts sized to this, so their hotConcurrency /
  // catalogConcurrency worker pools can never stack beyond this many
  // concurrent downstream requests. requestDelayMs is the sustained-rate
  // gate; this is the burst cap. Default 3 keeps a ~240-row sweep under
  // ~3-4 min at 0.35s/req (closer to the hotRetryIntervalMs staleness
  // budget) without storming 429s; measured ceiling on warframe.market is
  // ~3 req/s sustained before backoffs dominate. Raise cautiously.
  maxConcurrentRequests: num(rateLimit.maxConcurrentRequests, 3),
  // Delay after each successful request (ms). Seconds in the YAML.
  requestDelayMs: num(rateLimit.requestDelay, 0.35) * 1000,

  // Wait time after a 429 (ms). Seconds in the YAML.
  rateLimitDelayMs: num(rateLimit.rateLimitDelay, 10) * 1000,

  // Hot-loop staleness budget (ms). Under the continuous hot engine,
  // hotRetryIntervalMs is no longer a sleep timer - the loop pulls the
  // oldest row over and over without sleeping. This value instead defines
  // "how stale is too stale": rows whose last_updated is older than this
  // get re-fetched first (oldest-first queue ordering) and surface a
  // warning log when a worker picks them up PAST the budget. Effective
  // per-row freshness still can't beat the sweep wall-clock divided by
  // maxConcurrentRequests, which is the structural limit.
  hotRetryIntervalMs: num(hot.hotRetryInterval, 120) * 1000,
  // Hot-loop: max sets/prime entries processed in parallel within one sweep.
  // warframe.market rate-limits aggressively - measured tolerable sustained
  // rate is below ~3 req/s. Default 2 keeps the hot sweep parallel without
  // 429-storming; the per-request requestDelayMs is the primary rate gate,
  // this just bounds the burst. Tune up cautiously.
  hotConcurrency: num(hot.hotConcurrency, 2),
  // Catalog: max sets/prime entries built in parallel during a cold build.
  // Same rate-limit ceiling as the hot loop applies here - the cold build
  // runs concurrently with the hot sweep, so the two pools' worker counts
  // stack against the same downstream limit. Default 2 keeps the cold build
  // parallel enough to finish in single-digit minutes without 429-storming.
  catalogConcurrency: num(catalog.catalogConcurrency, 2),
  // Catalog: time between full catalog rebuilds (ms). Seconds in the YAML.
  catalogRefreshMs: num(catalog.catalogRefreshSeconds, 6 * 60 * 60) * 1000,
  // Cold loop: retry interval while no catalog has ever been built (ms).
  // Once a build has produced a catalog, the full catalogRefreshMs kicks
  // in. Keeping this short means a flaky first build self-corrects in
  // seconds instead of sitting idle for hours showing nothing.
  coldRetryMs: num(catalog.coldRetrySeconds, 30) * 1000,

  minArbitrageValue: num(filters.minArbitrageValue, 10),
  minDucatPerPlatinum: num(filters.minDucatPerPlatinum, 0),
  minDucats: num(filters.minDucats, 0),

  // Arbitrage: minimum 48h closed-trade volume for a set to clear the bar.
  // Stops the table from surfacing Sets whose "profit" is just a stale offer
  // on an item nobody actually trades.
  minVolume: num(filters.minVolume, 2),
};
