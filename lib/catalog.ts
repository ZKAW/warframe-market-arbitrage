import {
  fetchAllItems,
  fetchSetManifest,
  getItemDetails,
  FETCH_FAILED,
  type FetchFailed,
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
//
// Returns FETCH_FAILED (not null) on a transient failure so callers can
// distinguish "couldn't check right now" from "this part is genuinely
// gone" - conflating the two used to make a single rate-limit hiccup look
// identical to a real delisting, which fed straight into loadCatalog's
// prune pass and could wipe a perfectly good, currently-live deal off the
// board over nothing more than a 429.
async function resolveComponent(
  uid: string,
  cache: RequestCache
): Promise<SetComponent | FetchFailed | null> {
  const details = await getItemDetails(uid, cache);
  if (details === FETCH_FAILED) return FETCH_FAILED;
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
  // loop can start sweeping the moment the first set lands, instead of
  // waiting for the whole ~240-set catalog to build. The hot loop (see
  // runStaleDrivenLoop in scrape.ts) has no build-completion gate and
  // reads store.catalog.sets directly, so a set added mid-build is picked
  // up on its very next pass - including during the very first cold
  // start, not just steady-state rebuilds. Same rate-limit footprint as
  // before (catalogConcurrency workers, requestDelayMs gate);
  // warframe.market 429s are handled by the per-request retry+backoff in
  // httpClient.ts, not by widening the pool.
  await mapWithConcurrency(setItems, config.catalogConcurrency, async (setItem) => {
    const manifest = await fetchSetManifest(setItem.slug, cache);

    if (manifest === FETCH_FAILED) {
      // Transient (429 past backoff / network blip) - NOT a delisting
      // signal. Carry over whatever this slug's catalog entry looked
      // like before this rebuild started (store.catalog.sets still holds
      // it untouched) so the end-of-build prune pass doesn't treat
      // "couldn't check this cycle" as "gone" and rip out a currently-
      // live, perfectly good deal. It gets a fresh shot next rebuild.
      const prior = store.catalog.sets.get(setItem.slug);
      if (prior) sets.set(setItem.slug, prior);
      console.log(
        `[catalog] Skipping ${setItem.slug}: manifest fetch failed (transient)${
          prior ? ', keeping existing entry' : ''
        }`
      );
      resolved++;
      return;
    }
    if (!manifest) {
      // Real absence (404 / no manifest) - genuinely gone. Don't carry
      // over a prior entry; let the prune pass below drop it.
      resolved++;
      return;
    }

    const components: SetComponent[] = [];
    let incomplete = false;
    let transientFailure = false;
    for (const uid of manifest.setParts ?? []) {
      const comp = await resolveComponent(uid, cache);
      if (comp === FETCH_FAILED) {
        transientFailure = true;
        break;
      }
      // Hard-fail this set on any missing part: a partial parts list would
      // silently undercount total cost and produce false-positive arbitrage.
      if (!comp) {
        incomplete = true;
        break;
      }
      components.push(comp);
    }

    if (transientFailure) {
      // Same "don't punish a hiccup" reasoning as the manifest fetch
      // above - preserve the prior entry rather than dropping the set.
      const prior = store.catalog.sets.get(setItem.slug);
      if (prior) sets.set(setItem.slug, prior);
      console.log(
        `[catalog] Skipping ${setItem.slug}: part fetch failed (transient)${
          prior ? ', keeping existing entry' : ''
        }`
      );
    } else if (!incomplete && components.length > 0) {
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
  // loop can start sweeping the moment the first prime lands, mirroring
  // buildSets - including during the very first cold start. When the bulk
  // /v2/items payload carries ducats (the common case) this loop is
  // cheap: zero extra fetches, just a walk over the item list writing
  // entries. The per-item fallback (only when the bulk field is absent
  // entirely) stays sequential - shelling out per item is already the
  // rare path and widening it here would multiply 429 risk.
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
      if (details === FETCH_FAILED) {
        // Transient - preserve whatever this slug had before rather than
        // treating a network hiccup as "not a ducat-worthy prime after
        // all" and letting the prune pass wipe a live deal over it.
        const prior = store.catalog.primes.get(item.slug);
        if (prior) primes.set(item.slug, prior);
        console.log(
          `[catalog] Skipping ${item.slug}: item details fetch failed (transient)${
            prior ? ', keeping existing entry' : ''
          }`
        );
        continue;
      }
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
  // newSets/newPrimes carry over prior entries for slugs that only hit a
  // transient failure this cycle (see buildSets/buildPrimes above), so
  // this pass only ever drops genuinely-gone slugs, never a hiccup.
  for (const slug of [...store.catalog.sets.keys()]) {
    if (!newSets.has(slug)) store.catalog.sets.delete(slug);
  }
  store.catalog.primes = newPrimes;
  // Also drop any arbitrage/ducats rows whose backing catalog entry was
  // pruned; otherwise the table would keep showing rows for delisted sets
  // the next hot worker no longer knows about. Clean up the deadline Map
  // too so the stale-driven worker pool doesn't carry entries for slugs
  // that no longer have a catalog row (no functional harm - pickDueSlug
  // only looks up deadlines for slugs from catalogIterator - but it'd
  // leak memory across many rebuilds).
  const arbDeadlines = store.pipelineState.arbitrage.deadlines;
  for (const slug of [...store.arbitrage.keys()]) {
    if (!newSets.has(slug)) {
      store.arbitrage.delete(slug);
      arbDeadlines.delete(slug);
    }
  }
  const ducDeadlines = store.pipelineState.ducats.deadlines;
  for (const slug of [...store.ducats.keys()]) {
    if (!newPrimes.has(slug)) {
      store.ducats.delete(slug);
      ducDeadlines.delete(slug);
    }
  }

  store.catalog.builtAt = new Date().toISOString();
  console.log(
    `[catalog] Build complete: ${store.catalog.builtAt} (${newSets.size} sets, ${newPrimes.size} primes)`
  );
}
