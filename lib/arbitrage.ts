import { config } from './config';
import { store } from './store';
import { broadcast } from './subscriptions';
import { fetchPriceData, fetchStatisticsVolume } from './warframeApi';
import { mapWithConcurrency } from './scrape';
import type { RequestCache } from './scrape';
import type { ArbitrageEntry } from './types';
import type { SetEntry } from './store';


// Delete + broadcast. Pruning an arbitrage row only matters if the slug
// actually existed in the store; broadcasting on a no-op delete would spam
// subscribers with unchanged snapshots.
function removeArbitrageRow(slug: string): void {
  if (store.arbitrage.delete(slug)) broadcast('arbitrage', getArbitrageData());
}

async function processSingleSet(
  entry: SetEntry,
  cache: RequestCache
): Promise<void> {
  const setSlug = entry.setItem.slug;
  const components = entry.components;
  let setPrice: number | null = null;
  let totalPartsCost = 0;
  let incomplete = false;

  for (const { slug, quantity = 1 } of components) {
    if (slug === setSlug) {
      setPrice = await fetchPriceData(slug, cache);
    } else {
      const price = await fetchPriceData(slug, cache);
      if (price == null) {
        incomplete = true;
        break;
      }
      totalPartsCost += price * quantity;
    }
  }

  if (incomplete || !setPrice) {
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

function pruneDelistedSets(currentSlugs: Set<string>): void {
  for (const slug of store.arbitrage.keys()) {
    if (!currentSlugs.has(slug)) {
      store.arbitrage.delete(slug);
      console.log(`[arbitrage] Removed delisted/renamed set: ${slug}`);
      broadcast('arbitrage', getArbitrageData());
    }
  }
}

export async function runArbitrageCycle(cache: RequestCache): Promise<void> {
  pruneDelistedSets(new Set(store.catalog.sets.keys()));

  // Sweep oldest-arbitrage-row first so stale rows get re-fetched before
  // fresh ones within each cycle. Rows we've never priced yet sort ahead
  // of everything (no last_updated => -Infinity) so newly-streamed
  // catalog sets get their first price pass before any refresh work.
  // Snapshot the catalog entries: the cold build streams sets into
  // store.catalog.sets mid-sweep, and iterating a Map while it's being
  // written from another coroutine is unspecified. The snapshot is the
  // exact set this cycle owes work for; anything added after the snapshot
  // waits for the next tick.
  const work = [...store.catalog.sets.values()].sort((a, b) => {
    const ta = store.arbitrage.get(a.setItem.slug)?.last_updated;
    const tb = store.arbitrage.get(b.setItem.slug)?.last_updated;
    const taMs = ta ? new Date(ta).getTime() : Number.NEGATIVE_INFINITY;
    const tbMs = tb ? new Date(tb).getTime() : Number.NEGATIVE_INFINITY;
    return taMs - tbMs;
  });

  await mapWithConcurrency(work, config.hotConcurrency, (entry) =>
    processSingleSet(entry, cache).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[arbitrage] Error processing ${entry?.setItem?.slug ?? '?'}: ${message}`);
    })
  );
}


export function getArbitrageData(): {
  data: ArbitrageEntry[];
  ready: boolean;
  lastCycleCompletedAt: string | null;
} {
  // Rows persist in the store until explicitly pruned (delisted,
 // unprofitable, low-volume). We deliberately do NOT filter by age here:
 // the hot sweep already prioritizes stale rows (oldest last_updated
 // first), so old data is replaced by fresh data on the cycle's cadence
 // rather than hidden behind a freshness threshold. Pruning belongs to
 // the lifecycle in arbitrage.ts, not to a render-time filter.
  const rows = [...store.arbitrage.values()]
    .sort((a, b) => b.arbitrage_value - a.arbitrage_value);

  return {
    data: rows,
    ready: store.ready.arbitrage,
    lastCycleCompletedAt: store.lastCycleCompletedAt.arbitrage,
  };
}
