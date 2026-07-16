import { config } from './config';
import { store, isFresh } from './store';
import { fetchPriceData, getItemDetails } from './warframeApi';
import type { RequestCache } from './scrape';
import type { WarframeItem, DucatEntry } from './types';

async function getItemDucats(
  item: WarframeItem,
  bulkHasDucats: boolean,
  cache: RequestCache
): Promise<number | null> {
  const ducats = item.ducats;
  if (ducats) return ducats;

  if (bulkHasDucats) return null; // field exists in bulk payload, item just has none

  if (!item.tags?.includes('prime')) return null;

  const details = await getItemDetails(item.slug, cache);
  if (!details) return null;
  return details.ducats ?? null;
}

async function processSingleItem(
  item: WarframeItem,
  bulkHasDucats: boolean,
  cache: RequestCache
): Promise<void> {
  const slug = item.slug;

  const ducats = await getItemDucats(item, bulkHasDucats, cache);
  if (!ducats) {
    store.ducats.delete(slug);
    return;
  }

  const price = await fetchPriceData(slug, cache);
  if (!price || price <= 0) {
    store.ducats.delete(slug);
    return;
  }

  const ratio = ducats / price;

  if (ratio < config.minDucatPerPlatinum || ducats < config.minDucats) {
    store.ducats.delete(slug);
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
    tags: item.tags ?? [],
  });
  console.log(`[ducats] Good deal: ${slug} (${ducats} ducats for ${price}p, ratio ${ratio.toFixed(2)})`);
}

function pruneIneligibleItems(currentSlugs: Set<string>): void {
  for (const slug of store.ducats.keys()) {
    if (!currentSlugs.has(slug)) {
      store.ducats.delete(slug);
      console.log(`[ducats] Removed no-longer-eligible/delisted item: ${slug}`);
    }
  }
}

export async function runDucatCycle(
  items: WarframeItem[] | null,
  cache: RequestCache
): Promise<void> {
  console.log(`[ducats] Cycle started: ${new Date().toISOString()}`);

  if (!items) {
    console.log('[ducats] No items (transient failure); keeping existing data.');
    return;
  }

  const bulkHasDucats = items.some((i) => i.ducats);
  const candidates = items.filter((i) => i.ducats || i.tags?.includes('prime'));
  console.log(`[ducats] Checking ${candidates.length} ducat-eligible candidates`);

  const currentSlugs = new Set(candidates.map((c) => c.slug));
  pruneIneligibleItems(currentSlugs);

  for (const item of candidates) {
    try {
      await processSingleItem(item, bulkHasDucats, cache);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[ducats] Error processing ${item?.slug ?? '?'}: ${message}`);
    }
  }

  console.log('[ducats] Cycle complete.');
}

export function getDucatData(): { data: DucatEntry[]; ready: boolean } {
  const rows = [...store.ducats.values()]
    .filter((entry) => isFresh(entry, config.maxDataAgeMs))
    .sort((a, b) => b.ducat_per_platinum - a.ducat_per_platinum);

  return { data: rows, ready: store.ready.ducats };
}
