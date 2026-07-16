import { config } from './config';
import { store, isFresh } from './store';
import {
  fetchPriceData,
  fetchSetManifest,
  fetchStatisticsVolume,
  getItemDetails,
} from './warframeApi';
import type { RequestCache } from './scrape';
import type { ArbitrageEntry, WarframeItem } from './types';

interface ComponentSpec {
  slug: string;
  quantity: number;
}

async function getItemSpecs(
  itemSlug: string,
  cache: RequestCache
): Promise<ComponentSpec | null> {
  const details = await getItemDetails(itemSlug, cache);
  if (!details) return null;
  return {
    slug: details.slug,
    quantity: details.quantityInSet ?? 1,
  };
}

async function getComponents(
  manifest: { setParts?: string[] } | undefined,
  cache: RequestCache
): Promise<ComponentSpec[] | null> {
  const setParts = manifest?.setParts ?? [];
  const components: ComponentSpec[] = [];

  for (const uid of setParts) {
    const specs = await getItemSpecs(uid, cache);
    // Hard fail on any missing part instead of returning a partial list -
    // a partial parts list would silently undercount total cost and
    // produce false-positive arbitrage.
    if (!specs) return null;
    components.push(specs);
  }

  return components;
}

async function processSingleSet(
  setItem: WarframeItem,
  cache: RequestCache
): Promise<void> {
  const setSlug = setItem.slug;
  const manifest = await fetchSetManifest(setSlug, cache);
  if (!manifest) {
    store.arbitrage.delete(setSlug);
    return;
  }

  const components = await getComponents(manifest, cache);

  if (!components || components.length === 0) {
    store.arbitrage.delete(setSlug);
    return;
  }

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
    store.arbitrage.delete(setSlug);
    return;
  }

  const arbitrageValue = setPrice - totalPartsCost;

  if (arbitrageValue < config.minArbitrageValue) {
    if (store.arbitrage.delete(setSlug)) {
      console.log(`[arbitrage] No longer profitable, removed: ${setSlug}`);
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
    tags: setItem.tags ?? [],
  });
  console.log(
    `[arbitrage] Profit found: ${setSlug} (+${arbitrageValue}p, 48h vol ${volume ?? '?'})`
  );
}

function pruneDelistedSets(currentSlugs: Set<string>): void {
  for (const slug of store.arbitrage.keys()) {
    if (!currentSlugs.has(slug)) {
      store.arbitrage.delete(slug);
      console.log(`[arbitrage] Removed delisted/renamed set: ${slug}`);
    }
  }
}

export async function runArbitrageCycle(
  items: WarframeItem[] | null,
  cache: RequestCache
): Promise<void> {
  console.log(`[arbitrage] Cycle started: ${new Date().toISOString()}`);

  if (!items) {
    console.log('[arbitrage] No items (transient failure); keeping existing data.');
    return;
  }

  const sets = items.filter((i) => i?.slug?.endsWith('_set'));
  const currentSlugs = new Set(sets.map((s) => s.slug));

  // Only prune "no longer exists" entries when we got a fresh, live
  // listing - a transient fetch failure must not wipe existing data.
  pruneDelistedSets(currentSlugs);

  for (const setItem of sets) {
    try {
      await processSingleSet(setItem, cache);
    } catch (err) {
      // One bad set shouldn't abort the whole cycle.
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[arbitrage] Error processing ${setItem?.slug ?? '?'}: ${message}`);
    }
  }

  console.log('[arbitrage] Cycle complete.');
}


export function getArbitrageData(): { data: ArbitrageEntry[]; ready: boolean } {
  const rows = [...store.arbitrage.values()]
    .filter((entry) => isFresh(entry, config.maxDataAgeMs))
    .sort((a, b) => b.arbitrage_value - a.arbitrage_value);

  return { data: rows, ready: store.ready.arbitrage };
}
