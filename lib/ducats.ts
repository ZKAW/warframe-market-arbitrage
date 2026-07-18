import { config } from './config';
import { store } from './store';
import { broadcast } from './subscriptions';
import { fetchLowestSell, FETCH_FAILED } from './warframeApi';
import type { RequestCache } from './scrape';
import type { DucatEntry } from './types';
import type { PrimeEntry } from './store';

// Delete + broadcast. Only matters if the slug actually existed; a no-op
// delete would spam subscribers with unchanged snapshots.
function removeDucatRow(slug: string): void {
  if (store.ducats.delete(slug)) broadcast('ducats', getDucatData());
}

// Fetch + evaluate ONE prime. Called by the persistent-stale-driven worker
// pool in scrape.ts the moment this slug crosses hotRetryIntervalMs (or on
// first-ever fetch). Every code path that exits either writes a fresh live
// row, removes the row (delisted / below thresholds), or preserves the
// prior row on transient failure - in all cases the caller bumps the
// slug's deadline so the budget drives the queue for all catalog primes,
// not just live-priced ones.
async function processSingleItem(
  entry: PrimeEntry,
  cache: RequestCache
): Promise<void> {
  const slug = entry.item.slug;
  const ducats = entry.ducats;
  if (!ducats) {
    removeDucatRow(slug);
    return;
  }

  const sell = await fetchLowestSell(slug, cache);
  if (sell === FETCH_FAILED) {
    // Transient (429 past backoff / network). Preserve whatever the
    // previous cycle had; defer to next pass. Treat like a stale-read.
    console.log(`[ducats] Skipping ${slug}: price fetch failed (transient), keeping existing row`);
    return;
  }
  if (sell === null || !sell.platinum || sell.platinum <= 0) {
    removeDucatRow(slug);
    return;
  }
  const price = sell.platinum;
  const quantity = sell.quantity;

  const ratio = ducats / price;

  if (ratio < config.minDucatPerPlatinum || ducats < config.minDucats) {
    removeDucatRow(slug);
    return;
  }

  store.ducats.set(slug, {
    item: slug,
    ducats,
    platinum_price: price,
    quantity,
    ducat_per_platinum: Math.round(ratio * 1000) / 1000,
    platinum_per_ducat: Math.round((price / ducats) * 1000) / 1000,
    market_url: `https://warframe.market/items/${slug}`,
    last_updated: new Date().toISOString(),
    tags: entry.item.tags ?? [],
  });
  console.log(`[ducats] Good deal: ${slug} (${ducats} ducats for ${price}p, ratio ${ratio.toFixed(2)})`);
  broadcast('ducats', getDucatData());
}

// Worker-pool entry point: fetch + evaluate one prime by slug. Caller
// (runStaleDrivenLoop in scrape.ts) does claim tracking + deadline bumping.
export async function processDucatSlug(
  slug: string,
  cache: RequestCache
): Promise<void> {
  const entry = store.catalog.primes.get(slug);
  if (!entry) return;
  await processSingleItem(entry, cache).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[ducats] Error processing ${slug}: ${message}`);
  });
}

export function getDucatData(): {
  data: DucatEntry[];
  ready: boolean;
  lastCycleCompletedAt: string | null;
} {
  // Rows persist in the store until explicitly pruned (delisted /
  // ineligible / below thresholds). We do NOT filter by age at render
  // time: stale data is replaced by the persistent stale-driven worker
  // pool's cadence (each row re-fetched on its hotRetryIntervalMs
  // deadline) rather than hidden behind a freshness filter.
  const rows = [...store.ducats.values()]
    .sort((a, b) => b.ducat_per_platinum - a.ducat_per_platinum);

  return {
    data: rows,
    ready: store.ready.ducats,
    lastCycleCompletedAt: store.lastCycleCompletedAt.ducats,
  };
}
