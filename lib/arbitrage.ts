import { config } from './config';
import { store, isFresh } from './store';
import { fetchAllItems, fetchPriceData, getItemDetails } from './warframeApi';
import { safeGetRequest } from './httpClient';
import type { ArbitrageEntry } from './types';

interface ComponentSpec {
  slug: string;
  quantity: number;
}

async function getItemSpecs(itemSlug: string): Promise<ComponentSpec | null> {
  const details = await getItemDetails(itemSlug);
  if (!details) return null;
  return {
    slug: details.slug,
    quantity: details.quantityInSet ?? 1,
  };
}

async function getComponents(
  manifest: { setParts?: string[] } | undefined
): Promise<ComponentSpec[] | null> {
  const setParts = manifest?.setParts ?? [];
  const components: ComponentSpec[] = [];

  for (const uid of setParts) {
    const specs = await getItemSpecs(uid);
    // Hard fail on any missing part instead of returning a partial list -
    // a partial parts list would silently undercount total cost and
    // produce false-positive arbitrage.
    if (!specs) return null;
    components.push(specs);
  }

  return components;
}

async function processSingleSet(setSlug: string): Promise<void> {
  const res = await safeGetRequest(`${config.apiBase}/items/${setSlug}`);
  if (!res) {
    store.arbitrage.delete(setSlug);
    return;
  }

  const json = await res.json();
  const manifest = json?.data ?? {};
  const components = await getComponents(manifest);

  if (!components || components.length === 0) {
    store.arbitrage.delete(setSlug);
    return;
  }

  let setPrice: number | null = null;
  let totalPartsCost = 0;
  let incomplete = false;

  for (const { slug, quantity = 1 } of components) {
    if (slug === setSlug) {
      setPrice = await fetchPriceData(slug);
    } else {
      const price = await fetchPriceData(slug);
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

  if (arbitrageValue >= config.minArbitrageValue) {
    store.arbitrage.set(setSlug, {
      set: setSlug,
      arbitrage_value: arbitrageValue,
      set_price: setPrice,
      total_part_price: totalPartsCost,
      market_url: `https://warframe.market/items/${setSlug}`,
      last_updated: new Date().toISOString(),
    });
    console.log(`[arbitrage] Profit found: ${setSlug} (+${arbitrageValue}p)`);
  } else if (store.arbitrage.delete(setSlug)) {
    console.log(`[arbitrage] No longer profitable, removed: ${setSlug}`);
  }
}

function pruneDelistedSets(currentSlugs: Set<string>): void {
  for (const slug of store.arbitrage.keys()) {
    if (!currentSlugs.has(slug)) {
      store.arbitrage.delete(slug);
      console.log(`[arbitrage] Removed delisted/renamed set: ${slug}`);
    }
  }
}

async function runArbitrageCycle(): Promise<void> {
  console.log(`[arbitrage] Cycle started: ${new Date().toISOString()}`);
  const items = await fetchAllItems();
  console.log(`[arbitrage] Fetched ${items ? items.length : 0} items`);

  if (items) {
    const sets = items.filter((i) => i?.slug?.endsWith('_set'));
    const currentSlugs = new Set(sets.map((s) => s.slug));

    // Only prune "no longer exists" entries when we got a fresh, live
    // listing - a transient fetch failure must not wipe existing data.
    pruneDelistedSets(currentSlugs);

    for (const setItem of sets) {
      try {
        await processSingleSet(setItem.slug);
      } catch (err) {
        // One bad set shouldn't abort the whole cycle.
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[arbitrage] Error processing ${setItem?.slug ?? '?'}: ${message}`);
      }
    }
  } else {
    console.log('[arbitrage] No items fetched (transient failure); keeping existing data.');
  }

  store.ready.arbitrage = true;
  console.log('[arbitrage] Cycle complete.');
}

export function startArbitrageLoop(): void {
  if (store.loopsStarted.arbitrage) return;
  store.loopsStarted.arbitrage = true;

  const loop = async (): Promise<void> => {
    try {
      await runArbitrageCycle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[arbitrage] Loop error: ${message}`);
    }
    setTimeout(loop, config.retryIntervalMs);
  };

  // Fire-and-forget: don't await this, or it would block Next.js's
  // instrumentation register() (and therefore server startup) until the
  // very first scrape cycle finishes.
  loop();
}

export function getArbitrageData(): { data: ArbitrageEntry[]; ready: boolean } {
  const rows = [...store.arbitrage.values()]
    .filter((entry) => isFresh(entry, config.maxDataAgeMs))
    .sort((a, b) => b.arbitrage_value - a.arbitrage_value);

  return { data: rows, ready: store.ready.arbitrage };
}
