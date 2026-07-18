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
// Each pipeline gets its own independent tick. Arbitrage walks every "_set"
// plus every component (price + volume per item, after the cold catalog
// build pre-resolved manifests+part UIDs), which takes far longer than one
// hot retry interval on a big catalog. Ducats only touches prime items
// directly and finishes much faster. Separate timers mean ducats refreshes
// on its own steady cadence no matter how long arbitrage's tail takes,
// and the hot tick starts sweeping the moment the cold build streams the
// first set into store.catalog.sets (no builtAt gate; size==0 only).
//
// The tick chain is cancellation-aware: it checks a token before scheduling
// the next cycle and before broadcasting. `startScrapeLoop` cancels any prior
// token for the same pipeline before minting a new one, so old tick chains
// left over from a hot-reloaded module instance stop touching the store
// instead of stacking up as duplicates.
function runPipelineLoop(
  name: 'arbitrage' | 'ducats',
  run: (cache: RequestCache) => Promise<void>,
  markReady: () => void
): void {
  const token = { cancelled: false };
  store.loopTokens.set(name, token);

  const tick = async (): Promise<void> => {
    if (token.cancelled) return;
    try {
      console.log(`[${name}] Cycle started: ${new Date().toISOString()}`);
      if (store.catalog.sets.size === 0) {
        // Catalog hasn't streamed its first set yet. The cold build adds
        // sets to store.catalog.sets as they resolve, so the moment one
        // lands the next tick starts sweeping - no waiting on a full
        // 240-set build to finish.
        console.log(`[${name}] No catalog sets yet; hot cycle skipped.`);
      } else {
        const cache = new RequestCache();
        await run(cache);
        if (token.cancelled) return;
        markReady();
        console.log(`[${name}] Cycle complete.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[${name}] Loop error: ${message}`);
    }
    if (token.cancelled) return;
    setTimeout(tick, config.hotRetryIntervalMs);
  };

  tick();
}

// Cold loop: rebuilds the static catalog (sets + primes) on its own slow
// timer, separate from the hot price-refresh loops. Its own RequestCache per
// build dedupes the one-time manifest/details fetches within that build. The
// hot loops no-op while store.catalog.builtAt is null, so kicking this first
// in startScrapeLoop doesn't race the catalog against a hot tick.
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
  });
  runPipelineLoop('ducats', runDucatCycle, () => {
    store.ready.ducats = true;
    store.lastCycleCompletedAt.ducats = new Date().toISOString();
    broadcast('ducats', getDucatData());
  });
}
