import { config } from './config';
import { store } from './store';
import { fetchAllItems } from './warframeApi';
import { runArbitrageCycle } from './arbitrage';
import { runDucatCycle } from './ducats';
import { safeGetRequest } from './httpClient';

// Per-cycle memoization. A single shared fetch of /items feeds both
// pipelines, and every per-slug request (price, details, statistics, set
// manifest) is deduplicated by URL inside one cycle. The cache lives for
// exactly one tick: a fresh Map is created each cycle so stale data can
// never leak across ticks.
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

  // Caches the parsed JSON body keyed by the same URL. Two callers asking
  // for the same endpoint share one fetch *and* one parse, even if they
  // need different typed shapes of the same payload.
  async jsonOf<T>(url: string): Promise<T | null> {
    let p = this.json.get(url);
    if (!p) {
      p = this.response(url).then((res) => (res ? res.json() : null));
      this.json.set(url, p);
    }
    return (await p) as T | null;
  }
}

export async function runScrapeCycle(): Promise<void> {
  console.log(`[scrape] Cycle started: ${new Date().toISOString()}`);
  const items = await fetchAllItems();
  console.log(`[scrape] Fetched ${items ? items.length : 0} items`);

  const cache = new RequestCache();

  // Fan out both pipelines over the same manifest + shared request cache.
  // Failures in one pipeline must not short-circuit the other: each is
  // fully isolated here at the top level so a throw in arbitrage leaves
  // the ducats run untouched (and vice versa).
  await Promise.allSettled([
    runArbitrageCycle(items, cache).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[scrape] Arbitrage pipeline error: ${message}`);
    }),
    runDucatCycle(items, cache).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[scrape] Ducats pipeline error: ${message}`);
    }),
  ]);

  store.ready.arbitrage = true;
  store.ready.ducats = true;
  console.log('[scrape] Cycle complete.');
}

export function startScrapeLoop(): void {
  if (store.loopsStarted) return;
  store.loopsStarted = true;

  const loop = async (): Promise<void> => {
    try {
      await runScrapeCycle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[scrape] Loop error: ${message}`);
    }
    setTimeout(loop, config.retryIntervalMs);
  };

  // Fire-and-forget: don't await this, or it would block Next.js's
  // instrumentation register() (and therefore server startup) until the
  // very first scrape cycle finishes.
  loop();
}
