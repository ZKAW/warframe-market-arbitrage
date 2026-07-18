import { config } from './config';
import { store } from './store';
import { processArbitrageSlug, getArbitrageData } from './arbitrage';
import { processDucatSlug, getDucatData } from './ducats';
import { loadCatalog } from './catalog';
import { safeGetRequest, FETCH_FAILED, type FetchFailed } from './httpClient';
import { broadcast } from './subscriptions';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Iterable over the live catalog slugs for `pipeline`. Hot loops must not
// see slugs the catalog no longer knows about: rows whose backing entry
// was pruned by a rebuild are gone from the map before we iterate, so a
// deadline-only-known slug is naturally excluded here.
function catalogIterator(pipeline: 'arbitrage' | 'ducats'): Iterable<string> {
  return pipeline === 'arbitrage'
    ? store.catalog.sets.keys()
    : store.catalog.primes.keys();
}

// Pick the soonest-due slug that's currently claimable for `pipeline`:
// a slug with no recorded deadline (never fetched) is immediately due.
// Returns slug, or null if nothing is due right now. Concurrent workers
// share the deadlines Map; the inFlight Set prevents two workers from
// racing on the same slug when many become due simultaneously.
function pickDueSlug(
  pipeline: 'arbitrage' | 'ducats',
  now: number
): string | null {
  const { deadlines, inFlight } = store.pipelineState[pipeline];
  let due: string | null = null;
  let dueDeadline = Number.POSITIVE_INFINITY;
  for (const slug of catalogIterator(pipeline)) {
    if (inFlight.has(slug)) continue;
    const d = deadlines.get(slug) ?? Number.NEGATIVE_INFINITY;
    if (d <= now && d <= dueDeadline) {
      due = slug;
      dueDeadline = d;
    }
  }
  return due;
}

// Time until the soonest slug crosses the staleness budget. Only called
// when pickDueSlug found nothing due now - so every catalog slug is
// fresh-within-budget. Returns the budget as a safe floor if the catalog
// is empty (the caller already gated on builtAt, but a defensive bound
// beats a forever-sleep on a transient empty window).
function msUntilNextDue(pipeline: 'arbitrage' | 'ducats'): number {
  if (config.hotRetryIntervalMs <= 0) return 0;
  const { deadlines, inFlight } = store.pipelineState[pipeline];
  let earliest: number | null = null;
  for (const slug of catalogIterator(pipeline)) {
    if (inFlight.has(slug)) continue;
    const d = deadlines.get(slug) ?? Number.NEGATIVE_INFINITY;
    if (d === Number.NEGATIVE_INFINITY) return 0;
    earliest = earliest === null ? d : Math.min(earliest, d);
  }
  if (earliest === null) return config.hotRetryIntervalMs;
  return Math.max(0, earliest - Date.now());
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
// Each hot pipeline runs as a persistent stale-driven worker pool. N long-
// lived workers perpetually pull the SINGLE soonest-due slug from the live
// catalog, claim it, fetch it, and stamp a fresh deadline = now + budget.
// This removes the cycle boundary: a slug that crosses staleness right now
// is fetched within seconds, not at the next tick's snapshot. It also
// makes hotRetryIntervalMs actually drive the queue for ALL catalog rows:
// unprofitable rows previously had no last_updated so they sorted first on
// every cycle and got re-evaluated forever; now every slug gets a deadline
// and respects the budget.
//
// The process-wide semaphore in httpClient.ts (maxConcurrentRequests) is
// still the sole rate gate across all three pipelines (catalog + arb +
// ducats); hotConcurrency here just bounds the per-pipeline worker count.
//
// Workers are cancellation-aware: they check the token before each claim
// and before sleeping. startScrapeLoop cancels any prior token for the
// same pipeline before minting a fresh one, so workers from a hot-reloaded
// module instance stop touching the store instead of stacking up.
function runStaleDrivenLoop(
  name: 'arbitrage' | 'ducats',
  processSlug: (slug: string, cache: RequestCache) => Promise<void>,
  markReady: () => void
): void {
  const token = { cancelled: false };
  store.loopTokens.set(name, token);
  const { deadlines, inFlight } = store.pipelineState[name];

  const worker = async (workerId: number): Promise<void> => {
    while (!token.cancelled) {
      // Cold-build gate: don't sweep until the first COMPLETED catalog
      // build has landed. Mid-build streaming otherwise steals the
      // shared rate-limit budget from the build and produces misleading
      // partial-catalog sweeps. Steady-state rebuilds keep working
      // (builtAt is always set past the first build); pruned slugs are
      // naturally excluded because pickDueSlug only sees live catalog
      // slugs, and the catalog-rebuild prune pass clears their deadlines.
      if (store.catalog.builtAt === null) {
        await sleep(config.coldRetryMs);
        continue;
      }

      const slug = pickDueSlug(name, Date.now());
      if (slug) {
        inFlight.add(slug);
        try {
          const cache = new RequestCache();
          await processSlug(slug, cache);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`[${name}:${workerId}] Worker error on ${slug}: ${message}`);
        } finally {
          inFlight.delete(slug);
        }
        if (token.cancelled) return;
        // Stamp a fresh deadline regardless of outcome (profitable,
        // pruned, transient-fail). This is the key behavior that makes
        // the budget drive the queue for unprofitable slugs too - the
        // old cycle model would re-evaluate pruned rows on every pass
        // because they had no last_updated. A subsequent catalog rebuild
        // that drops this slug cleans up its deadline via the prune pass.
        deadlines.set(slug, Date.now() + config.hotRetryIntervalMs);
        markReady();
        continue;
      }

      // Nothing due: sleep until the soonest deadline, then re-pick.
      // Cap the sleep at coldRetryMs so a cancelled token is observed
      // promptly and so newly-stale rows (catalog grew, deadline moved)
      // are picked up without a full-budget wait.
      const wait = msUntilNextDue(name);
      if (wait <= 0) continue;
      await sleep(Math.min(wait, config.coldRetryMs));
    }
  };

  // Spin up the worker pool. Each worker is an independent loop; we never
  // await Promise.all because runStaleDrivenLoop must return synchronously
  // to startScrapeLoop. Workers run until token.cancelled.
  for (let i = 0; i < config.hotConcurrency; i++) {
    void worker(i);
  }
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
  // Each hot pipeline runs a persistent stale-driven worker pool (see
  // runStaleDrivenLoop). The builtAt gate inside the workers keeps them
  // dormant until the first complete catalog build - mid-build streaming
  // otherwise steals rate-limit budget from the build. After the first
  // build, workers pull stalest-due slugs continuously and stamp fresh
  // deadlines, so hotRetryIntervalMs actually drives the queue for every
  // catalog row including unprofitable ones, instead of being aspirational
  // documentation over a 240-row sweep wall-clock.
  runStaleDrivenLoop('arbitrage', processArbitrageSlug, () => {
    store.ready.arbitrage = true;
    store.lastCycleCompletedAt.arbitrage = new Date().toISOString();
    broadcast('arbitrage', getArbitrageData());
  });
  runStaleDrivenLoop('ducats', processDucatSlug, () => {
    store.ready.ducats = true;
    store.lastCycleCompletedAt.ducats = new Date().toISOString();
    broadcast('ducats', getDucatData());
  });
}
