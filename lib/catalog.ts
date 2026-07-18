import {
  fetchAllItems,
  fetchSetManifest,
  getItemDetails,
} from './warframeApi';
import { store } from './store';
import { mapWithConcurrency } from './scrape';
import type { RequestCache } from './scrape';
import type { PrimeEntry, SetComponent, SetEntry } from './store';
import type { WarframeItem } from './types';
import { config } from './config';

// setParts on a set manifest is an array of bare Mongo UIDs, not slugs.
// /v2/item/{uid} resolves a UID to { slug, quantityInSet }. This is the same
// getItemSpecs shape that arbitrage.ts used to call per part on every hot
// cycle; it now runs once per catalog rebuild (cold path) only.
async function resolveComponent(
  uid: string,
  cache: RequestCache
): Promise<SetComponent | null> {
  const details = await getItemDetails(uid, cache);
  if (!details) return null;
  return { slug: details.slug, quantity: details.quantityInSet ?? 1 };
}

async function buildSets(
  items: WarframeItem[],
  cache: RequestCache
): Promise<Map<string, SetEntry>> {
  const setItems = items.filter((i) => i?.slug?.endsWith('_set'));
  const sets = new Map<string, SetEntry>();
  let resolved = 0;
  const total = setItems.length;

  // Stream each resolved set straight into the live store map so the hot
  // tick can start sweeping the moment the first set lands, instead of
  // waiting for the whole ~240-set catalog to build. The hot tick reads
  // store.catalog.sets.values() and snapshots the keys at tick start, so
  // concurrent map writes during a build are safe - a set added mid-tick
  // is just picked up on the next tick. Same rate-limit footprint as
  // before (catalogConcurrency workers, requestDelayMs gate);
  // warframe.market 429s are handled by the per-request retry+backoff in
  // httpClient.ts, not by widening the pool.
  await mapWithConcurrency(setItems, config.catalogConcurrency, async (setItem) => {
    const manifest = await fetchSetManifest(setItem.slug, cache);
    if (!manifest) {
      resolved++;
      return;
    }

    const components: SetComponent[] = [];
    let incomplete = false;
    for (const uid of manifest.setParts ?? []) {
      const comp = await resolveComponent(uid, cache);
      // Hard-fail this set on any missing part: a partial parts list would
      // silently undercount total cost and produce false-positive arbitrage.
      if (!comp) {
        incomplete = true;
        break;
      }
      components.push(comp);
    }
    if (!incomplete && components.length > 0) {
      const entry: SetEntry = { setItem, components };
      sets.set(setItem.slug, entry);
      store.catalog.sets.set(setItem.slug, entry);
    }

    resolved++;
    // Progress log so a slow build is visibly alive instead of looking hung.
    if (resolved % 25 === 0 || resolved === total) {
      console.log(`[catalog] resolved ${resolved}/${total} sets`);
    }
  });

  return sets;
}

async function buildPrimes(
  items: WarframeItem[],
  bulkHasDucats: boolean,
  cache: RequestCache
): Promise<Map<string, PrimeEntry>> {
  const primes = new Map<string, PrimeEntry>();

  // Stream each resolved prime into the live store map so the ducats hot
  // tick can start sweeping the moment the first prime lands, mirroring
  // buildSets. When the bulk /v2/items payload carries ducats (the common
  // case) this loop is cheap: zero extra fetches, just a walk over the
  // item list writing entries. The per-item fallback (only when the bulk
  // field is absent entirely) stays sequential - shelling out per item is
  // already the rare path and widening it here would multiply 429 risk.
  for (const item of items) {
    if (!item?.slug) continue;
    const isPrimeCandidate = item.ducats || item.tags?.includes('prime');
    if (!isPrimeCandidate) continue;

    // Prefer the bulk ducats field when the payload carries it; only shell
    // out to per-item details when the bulk field is absent. Mirrors the
    // old getItemDucats heuristic so we don't regress ducats coverage.
    let ducats = item.ducats ?? null;
    if (ducats === null && !bulkHasDucats) {
      const details = await getItemDetails(item.slug, cache);
      ducats = details?.ducats ?? null;
    }
    if (ducats == null) continue;

    const entry: PrimeEntry = { item, ducats };
    primes.set(item.slug, entry);
    store.catalog.primes.set(item.slug, entry);
  }
  return primes;
}

export async function loadCatalog(cache: RequestCache): Promise<void> {
  console.log(`[catalog] Build started: ${new Date().toISOString()}`);
  const items = await fetchAllItems();
  if (!items) {
    console.log('[catalog] item list fetch failed; keeping previous catalog.');
    return;
  }

  const bulkHasDucats = items.some((i) => i.ducats);
  // Run set and prime resolution concurrently: they touch disjoint slugs
  // and share the per-cycle RequestCache (dedupes any URL both happen to
  // hit). Running them in parallel means primes also stream into the live
  // store while sets are still resolving - otherwise the ducats hot tick
  // sits idle for the whole multi-minute set build waiting for primes it
  // never needs anything from sets for. This is the lazy-streaming the
  // refactor promised: both pipelines can start sweeping as soon as their
  // first catalog entry lands.
  const [newSets, newPrimes] = await Promise.all([
    buildSets(items, cache),
    buildPrimes(items, bulkHasDucats, cache),
  ]);
  if (store.catalogToken?.cancelled) return;

  // Prune live maps to the freshly-built world: drop sets that this build
  // didn't reproduce (delisted/renamed) so stale entries can't linger past
  // the rebuild. We streamed sets in during buildSets, so this is the
  // single prune pass that converges the live map onto the new build.
  for (const slug of [...store.catalog.sets.keys()]) {
    if (!newSets.has(slug)) store.catalog.sets.delete(slug);
  }
  store.catalog.primes = newPrimes;
  // Also drop any arbitrage/ducats rows whose backing catalog entry was
  // pruned; otherwise the table would keep showing rows for delisted sets
  // the next arbitrage cycle no longer knows about.
  for (const slug of [...store.arbitrage.keys()]) {
    if (!newSets.has(slug)) store.arbitrage.delete(slug);
  }
  for (const slug of [...store.ducats.keys()]) {
    if (!newPrimes.has(slug)) store.ducats.delete(slug);
  }

  store.catalog.builtAt = new Date().toISOString();
  console.log(
    `[catalog] Build complete: ${store.catalog.builtAt} (${newSets.size} sets, ${newPrimes.size} primes)`
  );
}
