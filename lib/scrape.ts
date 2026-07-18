import { config } from './config';
import { store } from './store';
import { runArbitrageCycle, getArbitrageData } from './arbitrage';
import { runDucatCycle, getDucatData } from './ducats';
import { loadCatalog } from './catalog';
import { safeGetRequest, FETCH_FAILED, type FetchFailed } from './httpClient';
import { broadcast } from './subscriptions';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Time until the soonest row in the catalog crosses the staleness budget.
// Returns 0 if any row is unpriced (no last_updated) - those are always
// picked up immediately by the oldest-first sort, so the loop should
// re-tick right away. Returns the budget itself if the catalog is empty
// (handled by the isEmpty branch in runPipelineLoop, but this is a safe
// fallback). Used by the hot engines to sleep until real work exists
// rather than busy-spinning over a fully-fresh catalog.
export function msUntilNextStale<T>(
  entries: Iterable<T>,
  getLastUpdated: (item: T) => string | undefined
): number {
  if (config.hotRetryIntervalMs <= 0) return 0;
  let earliest: number | null = null;
  for (const entry of entries) {
    const ts = getLastUpdated(entry);
    if (!ts) return 0;
    const age = Date.now() - new Date(ts).getTime();
    earliest = earliest === null ? age : Math.min(earliest, age);
  }
  if (earliest === null) return config.hotRetryIntervalMs;
  const remaining = config.hotRetryIntervalMs - earliest;
  return remaining <= 0 ? 0 : remaining;
}

export class RequestCache {
  private readonly pending = new Map<string, Promise<Response | FetchFailed | null>>();
  private readonly json = new Map<string, Promise<unknown>>();

  response(url: string): Promise<Response | FetchFailed | null> {
    let p = this.pending.get(url);
    if (!p) {
      p = safeGetRequest(url);
      this.pending.set(url, p);
    }
    return p;
  }

  async jsonOf<T>(url: string): Promise<T | FetchFailed | null> {
    let p = this.json.get(url);
    if (!p) {
      p = this.response(url).then((res) =>
        res === FETCH_FAILED || res === null ? res : res.json().catch(() => null)
      );
      this.json.set(url, p);
    }
    return (await p) as T | FetchFailed | null;
  }

}
// Worker pool pulling from a shared queue. concurrency caps peak in-flight
// requests per sweep; the per-request throttle in httpClient stays the sole
// rate-limit guard. A worker that throws is expected to .catch() inside the
// worker closure so the pool keeps draining.
export async function mapWithConcurrency<T>(
  items: Iterable<T>,
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
// Each pipeline runs as a continuous, stale-driven engine. The cycle body
// (runArbitrageCycle / runDucatCycle) snapshots the catalog sorted by
// last_updated ASC and feeds a worker pool. The staleness budget
// hotRetryIntervalMs is enforced two ways: rows fresher than the budget
// are SKIP-skipped by the worker (no fetch, no broadcast, no write), and
// when a cycle completes without doing any work, the cycle returns the
// ms-until the soonest row crosses the budget - the tick sleeps that long
// rather than busy-spinning over a fully-fresh catalog. Rows we've never
// priced yet sort ahead of everything (no last_updated => -Infinity) so
// newly-streamed catalog entries always get their first price pass.
//
// `isEmpty` is pipeline-specific: arbitrage waits on store.catalog.sets,
// ducats on store.catalog.primes. When the catalog-mapping it cares about
// is still empty (cold build hasn't streamed its first entry), tick sleeps
// coldRetryMs so we don't CPU-spin on a no-op cycle.
//
// The tick chain is cancellation-aware: it checks the token before each
// scheduling step. `startScrapeLoop` cancels any prior token for the same
// pipeline before minting a new one, so old tick chains from a hot-reloaded
// module instance stop touching the store instead of stacking up.
function runPipelineLoop(
  name: 'arbitrage' | 'ducats',
  run: (cache: RequestCache) => Promise<number>,
  markReady: () => void,
  isEmpty: () => boolean
): void {
  const token = { cancelled: false };
  store.loopTokens.set(name, token);

  const tick = async (): Promise<void> => {
    if (token.cancelled) return;
    try {
      if (isEmpty()) {
        // Cold build hasn't streamed the first catalog entry for this
        // pipeline yet. Sleep coldRetryMs and re-tick - bounded wait so
        // we don't busy-spin on an empty cycle while the catalog streams.
        setTimeout(tick, config.coldRetryMs);
        return;
      }
      console.log(`[${name}] Cycle started: ${new Date().toISOString()}`);
      const cache = new RequestCache();
      const delay = await run(cache);
      if (token.cancelled) return;
      markReady();
      console.log(`[${name}] Cycle complete.`);
      // delay = 0: cycle did real work (at least one fetch), re-tick
      // immediately - more stale rows may be queued. delay > 0: every
      // row is fresher than the staleness budget; sleep until the
      // soonest one would go stale rather than busy-spinning. Sleeping
      // here keeps the CPU idle and the SSE stream quiet while the data
      // is still fresh; the semaphore + requestDelayMs still bound the
      // rate whenever work flows.
      setTimeout(tick, delay);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[${name}] Loop error: ${message}`);
      // A thrown cycle is treated as "did work, schedule now" so a
      // transient error doesn't stall the loop until the staleness timer.
      if (!token.cancelled) setTimeout(tick, 0);
    }
  };

  tick();
}

// Cold loop: rebuilds the static catalog (sets + primes) on its own slow
// timer, separate from the continuous hot price-refresh engines. Its own
// RequestCache per build dedupes the one-time manifest/details fetches
// within that build. The hot engines sleep coldRetryMs while their catalog
// mapping is empty, so kicking this first in startScrapeLoop doesn't race
// the catalog against a hot tick.
function runCatalogLoop(): void {
  const token = { cancelled: false };
  store.catalogToken = token;

  const tick = async (): Promise<void> => {
    if (token.cancelled) return;
    try {
      const cache = new RequestCache();
      await loadCatalog(cache);
      if (token.cancelled) return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[catalog] Loop error: ${message}`);
    }
    if (token.cancelled) return;
    // Cold loop distinguishes "never built" from "already built": while the
    // first build hasn't landed, retry on a short timer so a transient API
    // failure self-corrects in seconds instead of waiting the full
    // catalogRefreshMs (which defaults to 6h). Once a catalog exists, the
    // steady-state catalogRefreshMs interval takes over.
    setTimeout(tick, store.catalog.builtAt ? config.catalogRefreshMs : config.coldRetryMs);
  };

  tick();
}

export function startScrapeLoop(): void {
  // Primary guard against duplicate loops across `register()` re-entry
  // (Next.js docs recommend not assuming exactly-once). `loopTokens`
  // additionally cancels any tick chains that survived a hot-reloaded
  // module instance before minting fresh tokens.
  if (store.loopsStarted) return;
  store.loopsStarted = true;

  // Defensive: if any tick chain survived a prior module instance
  // (HMR), cancel it before minting fresh tokens.
  const arbitrageToken = store.loopTokens.get('arbitrage');
  if (arbitrageToken) arbitrageToken.cancelled = true;
  const ducatsToken = store.loopTokens.get('ducats');
  if (ducatsToken) ducatsToken.cancelled = true;
  if (store.catalogToken) store.catalogToken.cancelled = true;
  store.ready.arbitrage = false;
  store.ready.ducats = false;

  runCatalogLoop();
  // The hot pipelines wait for the first COMPLETED catalog build before
  // sweeping. During a cold build, store.catalog.sets/primes stream in
  // progressively (catalog.ts writes the live map mid-build); without this
  // gate the hot loops would wake on the first streamed entry, start
  // fetching prices, and starve the cold build of the shared rate-limit
  // budget - the cold build takes ~10min instead of ~2min, and the hot
  // sweeps run against a partial catalog producing misleading "cycle
  // complete" log lines. Once builtAt is set, steady-state rebuilds keep
  // the streaming behavior: sweeps continue against the union of previous
  // + new catalog entries while the rebuild populates, then the prune
  // pass converges them.
  const hotCatalogReady = () => store.catalog.builtAt !== null;
  runPipelineLoop('arbitrage', runArbitrageCycle, () => {
    store.ready.arbitrage = true;
    store.lastCycleCompletedAt.arbitrage = new Date().toISOString();
    broadcast('arbitrage', getArbitrageData());
  }, () => !hotCatalogReady() || store.catalog.sets.size === 0);
  runPipelineLoop('ducats', runDucatCycle, () => {
    store.ready.ducats = true;
    store.lastCycleCompletedAt.ducats = new Date().toISOString();
    broadcast('ducats', getDucatData());
  }, () => !hotCatalogReady() || store.catalog.primes.size === 0);
}
