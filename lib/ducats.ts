import { config } from './config';
import { store } from './store';
import { broadcast } from './subscriptions';
import { fetchPriceData } from './warframeApi';
import { mapWithConcurrency } from './scrape';
import type { RequestCache } from './scrape';
import type { DucatEntry } from './types';
import type { PrimeEntry } from './store';

// Delete + broadcast. Only matters if the slug actually existed; a no-op
// delete would spam subscribers with unchanged snapshots.
function removeDucatRow(slug: string): void {
  if (store.ducats.delete(slug)) broadcast('ducats', getDucatData());
}

async function processSingleItem(
  entry: PrimeEntry,
  cache: RequestCache
): Promise<void> {
  const slug = entry.item.slug;
  if (config.hotRetryIntervalMs > 0) {
    const prev = store.ducats.get(slug)?.last_updated;
    if (prev) {
      const ageMs = Date.now() - new Date(prev).getTime();
      if (ageMs > config.hotRetryIntervalMs) {
        console.log(`[ducats] Refreshing stale row ${slug} (${Math.round(ageMs / 1000)}s over budget)`);
      }
    }
  }
  const ducats = entry.ducats;
  if (!ducats) {
    removeDucatRow(slug);
    return;
  }

  const price = await fetchPriceData(slug, cache);
  if (!price || price <= 0) {
    removeDucatRow(slug);
    return;
  }

  const ratio = ducats / price;

  if (ratio < config.minDucatPerPlatinum || ducats < config.minDucats) {
    removeDucatRow(slug);
    return;
  }

  store.ducats.set(slug, {
    item: slug,
    ducats,
    platinum_price: price,
    ducat_per_platinum: Math.round(ratio * 1000) / 1000,
    platinum_per_ducat: Math.round((price / ducats) * 1000) / 1000,
    market_url: `https://warframe.market/items/${slug}`,
    last_updated: new Date().toISOString(),
    tags: entry.item.tags ?? [],
  });
  console.log(`[ducats] Good deal: ${slug} (${ducats} ducats for ${price}p, ratio ${ratio.toFixed(2)})`);
  broadcast('ducats', getDucatData());
}

function pruneIneligibleItems(currentSlugs: Set<string>): void {
  for (const slug of store.ducats.keys()) {
    if (!currentSlugs.has(slug)) {
      store.ducats.delete(slug);
      console.log(`[ducats] Removed no-longer-eligible/delisted item: ${slug}`);
      broadcast('ducats', getDucatData());
    }
  }
}

export async function runDucatCycle(cache: RequestCache): Promise<void> {
  pruneIneligibleItems(new Set(store.catalog.primes.keys()));

  // Sweep oldest-ducats-row first so stale rows get re-fetched before
  // fresh ones within each cycle. Rows we've never priced yet sort ahead
  // of everything (no last_updated => -Infinity) so newly-streamed
  // catalog primes get their first price pass before any refresh work.
  // Snapshot the primes: the cold build reassigns store.catalog.primes
  // on completion, and iterating a Map replaced mid-sweep is
  // unspecified. The snapshot is the exact set this cycle owes work for.
  const work = [...store.catalog.primes.values()].sort((a, b) => {
    const ta = store.ducats.get(a.item.slug)?.last_updated;
    const tb = store.ducats.get(b.item.slug)?.last_updated;
    const taMs = ta ? new Date(ta).getTime() : Number.NEGATIVE_INFINITY;
    const tbMs = tb ? new Date(tb).getTime() : Number.NEGATIVE_INFINITY;
    return taMs - tbMs;
  });

  await mapWithConcurrency(work, config.hotConcurrency, (entry) =>
    processSingleItem(entry, cache).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[ducats] Error processing ${entry?.item?.slug ?? '?'}: ${message}`);
    })
  );
}

export function getDucatData(): {
  data: DucatEntry[];
  ready: boolean;
  lastCycleCompletedAt: string | null;
} {
  // Rows persist in the store until explicitly pruned (delisted /
  // ineligible / below thresholds). We deliberately do NOT filter by age
  // here: the hot sweep already prioritizes stale rows (oldest
  // last_updated first), so old data is replaced by fresh data on the
  // cycle's cadence rather than hidden behind a freshness threshold.
  const rows = [...store.ducats.values()]
    .sort((a, b) => b.ducat_per_platinum - a.ducat_per_platinum);

  return {
    data: rows,
    ready: store.ready.ducats,
    lastCycleCompletedAt: store.lastCycleCompletedAt.ducats,
  };
}
