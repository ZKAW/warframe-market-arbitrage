import { config } from './config';
import { store } from './store';
import { broadcast } from './subscriptions';
import { fetchPriceData, fetchStatisticsVolume, FETCH_FAILED } from './warframeApi';
import type { RequestCache } from './scrape';
import type { ArbitrageEntry } from './types';
import type { SetEntry } from './store';
import type { FetchFailed } from './httpClient';


// Delete + broadcast. Pruning an arbitrage row only matters if the slug
// actually existed in the store; broadcasting on a no-op delete would spam
// subscribers with unchanged snapshots.
function removeArbitrageRow(slug: string): void {
  if (store.arbitrage.delete(slug)) broadcast('arbitrage', getArbitrageData());
}

// Fetch + evaluate ONE set. Called by the persistent-stale-driven worker
// pool in scrape.ts the moment this slug crosses hotRetryIntervalMs (or on
// first-ever fetch - absent deadlines sort first). Every code path that
// exits returns either a fresh live row, no row (delisted / unprofitable
// / low-volume), or preserves the prior row on transient failure - in all
// cases the caller bumps the slug's deadline so the budget drives the
// queue even for rows we decided to drop, instead of re-evaluating them
// every tick.
async function processSingleSet(
  entry: SetEntry,
  cache: RequestCache
): Promise<void> {
  const setSlug = entry.setItem.slug;
  const components = entry.components;
  let setPrice: number | FetchFailed | null = null;
  let totalPartsCost = 0;
  let incomplete = false;
  // True only on a real "this part has no sell orders / was delisted" null
  // (404 or zero live orders) - we trust that signal and drop the row. A
  // transient FETCH_FAILED (429 past backoff, network blip) is NOT a
  // removal signal: keep the existing row untouched, skip this cycle's
  // update, and let the next pass try again with fresh rate budget.
  let transientFailure = false;

  for (const { slug, quantity = 1 } of components) {
    if (slug === setSlug) {
      setPrice = await fetchPriceData(slug, cache);
      if (setPrice === FETCH_FAILED) transientFailure = true;
    } else {
      const price = await fetchPriceData(slug, cache);
      if (price === FETCH_FAILED) {
        transientFailure = true;
        break;
      }
      if (price == null) {
        incomplete = true;
        break;
      }
      totalPartsCost += price * quantity;
    }
  }

  if (transientFailure) {
    // Don't write, don't delete - preserve whatever the previous cycle
    // already had. The arbiter only mutates on a confident signal.
    console.log(`[arbitrage] Skipping ${setSlug}: price fetch failed (transient), keeping existing row`);
    return;
  }
  if (setPrice === FETCH_FAILED || incomplete || !setPrice) {
    removeArbitrageRow(setSlug);
    return;
  }

  const arbitrageValue = setPrice - totalPartsCost;

  if (arbitrageValue < config.minArbitrageValue) {
    if (store.arbitrage.delete(setSlug)) {
      console.log(`[arbitrage] No longer profitable, removed: ${setSlug}`);
      broadcast('arbitrage', getArbitrageData());
    }
    return;
  }

  // 48h closed-trade volume gates illiquid sets whose "profit" is really a
  // stale ask nobody buys. A null lookup (v1 down/429) is treated as "unknown,
  // don't filter" so a flaky statistics call can't wipe a known-good row.
  const volume = await fetchStatisticsVolume(setSlug, cache);
  if (volume !== null && volume < config.minVolume) {
    if (store.arbitrage.delete(setSlug)) {
      console.log(
        `[arbitrage] Removed low-volume set: ${setSlug} (48h vol ${volume} < ${config.minVolume})`
      );
      broadcast('arbitrage', getArbitrageData());
    }
    return;
  }

  store.arbitrage.set(setSlug, {
    set: setSlug,
    arbitrage_value: arbitrageValue,
    set_price: setPrice,
    total_part_price: totalPartsCost,
    volume,
    market_url: `https://warframe.market/items/${setSlug}`,
    last_updated: new Date().toISOString(),
    tags: entry.setItem.tags ?? [],
  });
  console.log(
    `[arbitrage] Profit found: ${setSlug} (+${arbitrageValue}p, 48h vol ${volume ?? '?'})`
  );
  broadcast('arbitrage', getArbitrageData());
}

// Worker-pool entry point: fetch + evaluate one set by slug. The caller
// (runStaleDrivenLoop in scrape.ts) is responsible for claim tracking and
// deadline bumping - this fn just does the row lifecycle. Looks the entry
// up from the live catalog; if the catalog was rebuilt and the slug no
// longer exists, this is a no-op (the prune pass in catalog.ts already
// cleaned up).
export async function processArbitrageSlug(
  slug: string,
  cache: RequestCache
): Promise<void> {
  const entry = store.catalog.sets.get(slug);
  if (!entry) return;
  await processSingleSet(entry, cache).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[arbitrage] Error processing ${slug}: ${message}`);
  });
}


export function getArbitrageData(): {
  data: ArbitrageEntry[];
  ready: boolean;
  lastCycleCompletedAt: string | null;
} {
  // Rows persist in the store until explicitly pruned (delisted,
  // unprofitable, low-volume). We do NOT filter by age at render time:
  // stale data is replaced by the persistent stale-driven worker pool's
  // cadence (each row re-fetched on its hotRetryIntervalMs deadline)
  // rather than hidden behind a freshness filter. Pruning belongs to the
  // row lifecycle here, not to a render-time filter.
  const rows = [...store.arbitrage.values()]
    .sort((a, b) => b.arbitrage_value - a.arbitrage_value);

  return {
    data: rows,
    ready: store.ready.arbitrage,
    lastCycleCompletedAt: store.lastCycleCompletedAt.arbitrage,
  };
}
