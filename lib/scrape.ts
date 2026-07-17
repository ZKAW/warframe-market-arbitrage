import { config } from './config';
import { store } from './store';
import { fetchAllItems } from './warframeApi';
import { runArbitrageCycle } from './arbitrage';
import { runDucatCycle } from './ducats';
import { safeGetRequest } from './httpClient';
import type { WarframeItem } from './types';

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

// Each pipeline gets its own independent tick. Arbitrage walks every "_set"
// plus every component (manifest + details + price + volume per item), which
// can take far longer than one retryInterval on a big catalog. Ducats only
// touches prime items directly and finishes much faster. Previously both were
// driven by one loop that waited on Promise.allSettled for *both* before
// scheduling the next run - so ducats entries sat fresh for a few minutes,
// then aged past maxDataAgeMs while still waiting on arbitrage's long tail to
// finish. Running them on separate timers means ducats refreshes on its own
// steady cadence no matter how long arbitrage takes.
function runPipelineLoop(
  name: 'arbitrage' | 'ducats',
  run: (items: WarframeItem[] | null, cache: RequestCache) => Promise<void>,
  markReady: () => void
): void {
  const tick = async (): Promise<void> => {
    try {
      console.log(`[${name}] Cycle started: ${new Date().toISOString()}`);
      const items = await fetchAllItems();
      const cache = new RequestCache();
      await run(items, cache);
      markReady();
      console.log(`[${name}] Cycle complete.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[${name}] Loop error: ${message}`);
    }
    setTimeout(tick, config.retryIntervalMs);
  };

  tick();
}

export function startScrapeLoop(): void {
  if (store.loopsStarted) return;
  store.loopsStarted = true;

  runPipelineLoop('arbitrage', runArbitrageCycle, () => {
    store.ready.arbitrage = true;
  });
  runPipelineLoop('ducats', runDucatCycle, () => {
    store.ready.ducats = true;
  });
}
