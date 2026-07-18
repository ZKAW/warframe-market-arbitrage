import { config } from './config';
import { store } from './store';
import { runArbitrageCycle, getArbitrageData } from './arbitrage';
import { runDucatCycle, getDucatData } from './ducats';
import { loadCatalog } from './catalog';
import { safeGetRequest } from './httpClient';
import { broadcast } from './subscriptions';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RequestCache {
  private readonly pending = new Map<string, Promise<Response | null>>();
  private readonly json = new Map<string, Promise<unknown>>();

  response(url: string): Promise<Response | null> {
    let p = this.pending.get(url);
    if (!p) {
      p = safeGetRequest(url);
      this.pending.set(url, p);
    }
    return p;
  }

  async jsonOf<T>(url: string): Promise<T | null> {
    let p = this.json.get(url);
    if (!p) {
      p = this.response(url).then((res) => (res ? res.json() : null));
      this.json.set(url, p);
    }
    return (await p) as T | null;
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
// Each pipeline runs as a continuous, stale-driven engine (no sleep timer)
// instead of the old "sweep everything then sleep hotRetryInterval" tick.
// The cycle body itself (runArbitrageCycle / runDucatCycle) snapshots the
// catalog sorted by last_updated ASC and feeds a worker pool; the cycle
// completes when the pool drains, then immediately ticks again. The oldest
// row is always what the next free worker pulls, so a row that went stale
// during the previous cycle is the first thing re-fetched next cycle - no
// fixed inter-tick wait. The process-wide semaphore in httpClient.ts is the
// lone rate gate; hotRetryIntervalMs now means "staleness budget" (used for
// warning logs and as the implicit priority signal) rather than a sleep.
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
  run: (cache: RequestCache) => Promise<void>,
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
      await run(cache);
      if (token.cancelled) return;
      markReady();
      console.log(`[${name}] Cycle complete.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[${name}] Loop error: ${message}`);
    }
    if (token.cancelled) return;
    // Cycle drained - re-tick immediately. The semaphore + requestDelayMs
    // bound the actual downstream rate; sleeping here would only drive the
    // oldest-row staleness higher with no rate-limit benefit.
    tick();
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
  runPipelineLoop('arbitrage', runArbitrageCycle, () => {
    store.ready.arbitrage = true;
    store.lastCycleCompletedAt.arbitrage = new Date().toISOString();
    broadcast('arbitrage', getArbitrageData());
  }, () => store.catalog.sets.size === 0);
  runPipelineLoop('ducats', runDucatCycle, () => {
    store.ready.ducats = true;
    store.lastCycleCompletedAt.ducats = new Date().toISOString();
    broadcast('ducats', getDucatData());
  }, () => store.catalog.primes.size === 0);
}
