import { config } from './config';
import { safeGetRequest, FETCH_FAILED, type FetchFailed } from './httpClient';
export { FETCH_FAILED, type FetchFailed } from './httpClient';
import type { RequestCache } from './scrape';
import type { WarframeItem, ItemDetails, OrderEntry } from './types';

interface StatisticsClosedWindow {
  volume: number;
  avg_price?: number;
  [key: string]: unknown;
}

interface StatisticsPayload {
  statistics_closed?: { '48hours'?: StatisticsClosedWindow[] };
  [key: string]: unknown;
}

export interface StatisticsSummary {
  volume: number;
  // Volume-weighted average price across the 48h closed-trade windows.
  // Null when the statistics call failed or returned no closed trades.
  avg_price: number | null;
}

interface ItemListPayload {
  data?: WarframeItem[];
  [key: string]: unknown;
}

interface ItemDetailsPayload {
  data?: ItemDetails;
  [key: string]: unknown;
}

interface OrdersPayload {
  data?: OrderEntry[];
  [key: string]: unknown;
}

interface SetManifestPayload {
  data?: { setParts?: string[] };
  [key: string]: unknown;
}

interface StatisticsResponse {
  payload?: StatisticsPayload;
  [key: string]: unknown;
}

// Fetch with cache if one is provided, otherwise a plain request. Both paths
// return the parsed JSON (or null on a permanent-absence / parse failure), or
// FETCH_FAILED if every retry attempt blew past the backoff cap - distinct
// from a 404 so callers can choose to keep an existing row instead of
// wiping good data on a transient outage.
async function cachedJson<T>(
  url: string,
  cache?: RequestCache
): Promise<T | FetchFailed | null> {
  if (cache) return cache.jsonOf<T>(url);
  const res = await safeGetRequest(url);
  if (res === FETCH_FAILED) return FETCH_FAILED;
  if (!res) return null;
  return res.json().catch(() => null) as Promise<T | null>;
}

// Called once per catalog rebuild by lib/catalog.ts (cold path). Not
// itself cached since each build mints its own RequestCache.
export async function fetchAllItems(): Promise<WarframeItem[] | null> {
  const json = await cachedJson<ItemListPayload>(`${config.apiBase}/items`);
  if (json === FETCH_FAILED) return null;
  return json?.data ?? null;
}

// 48h closed-trade volume + volume-weighted average price for a set slug, from
// the v1 statistics endpoint. Returns null on a missing/failed lookup so the
// caller can keep the row and let minVolume reject it (rather than dropping it
// as if unprofitable). A transient 429/network failure maps to null too -
// safe: the caller's "null means don't filter" rule preserves the row until
// the next cycle.
export async function fetchStatistics(
  itemSlug: string,
  cache?: RequestCache
): Promise<StatisticsSummary | null> {
  const json = await cachedJson<StatisticsResponse>(
    `${config.v1ApiBase}/items/${itemSlug}/statistics`,
    cache
  );
  if (json === FETCH_FAILED) return null;
  const hours = json?.payload?.statistics_closed?.['48hours'] ?? [];
  if (hours.length === 0) return null;
  let volume = 0;
  let weighted = 0;
  for (const h of hours) {
    volume += h.volume;
    if (typeof h.avg_price === 'number') weighted += h.avg_price * h.volume;
  }
  const avg_price = weighted > 0 ? weighted / volume : null;
  return { volume, avg_price };
}

export interface LowestSell {
  platinum: number;
  // Copies offered in the cheapest in-game sell order. From the same
  // /v2/orders/item payload as the price.
  quantity: number;
}

// One live, in-game sell order for a slug, as consumed by the greedy
// quantity fill in lib/arbitrage.ts (consumePartOrders) and reported back
// in the Parts cost tooltip.
export interface SellOrder {
  username: string;
  platinum: number;
  quantity: number;
}

function toSellOrder(o: OrderEntry): SellOrder {
  return {
    // The API has used both spellings across versions; fall back to a
    // placeholder rather than let a missing field break the tooltip.
    username: o.user?.ingameName ?? o.user?.ingame_name ?? 'Unknown seller',
    platinum: o.platinum,
    quantity: o.quantity,
  };
}

// Every currently-live, in-game sell order for a slug, cheapest first (or
// null if there are none). A single seller's `quantity` in stock can be
// less than what a set needs of that part, so callers that need N copies
// should walk this list order-by-order (see consumePartOrders in
// arbitrage.ts) instead of assuming the cheapest order alone can supply N.
export async function fetchSellOrders(
  itemSlug: string,
  cache?: RequestCache
): Promise<SellOrder[] | FetchFailed | null> {
  const json = await cachedJson<OrdersPayload>(
    `${config.apiBase}/orders/item/${itemSlug}`,
    cache
  );
  if (json === FETCH_FAILED) return FETCH_FAILED;
  const orders: OrderEntry[] = json?.data ?? [];
  const sell = orders
    .filter((o) => o?.type === 'sell' && o?.visible === true && o?.user?.status === 'ingame')
    .map(toSellOrder)
    .sort((a, b) => a.platinum - b.platinum);
  return sell.length > 0 ? sell : null;
}

// Picks the cheapest visible in-game sell order for a slug. Returns null
// when no qualifying order exists (delisted / no live sellers), or
// FETCH_FAILED when every retry attempt blew past the backoff cap - the
// latter is a transient signal callers preserve-existing-row on.
export async function fetchLowestSell(
  itemSlug: string,
  cache?: RequestCache
): Promise<LowestSell | FetchFailed | null> {
  const orders = await fetchSellOrders(itemSlug, cache);
  if (orders === FETCH_FAILED) return FETCH_FAILED;
  if (!orders) return null;
  const best = orders[0];
  return { platinum: best.platinum, quantity: best.quantity };
}

export async function fetchPriceData(
  itemSlug: string,
  cache?: RequestCache
): Promise<number | FetchFailed | null> {
  const best = await fetchLowestSell(itemSlug, cache);
  if (best === FETCH_FAILED) return FETCH_FAILED;
  if (best === null) return null;
  return best.platinum;
}

// Per-{slug} item details (ducats, quantityInSet, setParts fallback for
// resolveComponent). Returns FETCH_FAILED - not null - on a transient
// failure (429 past backoff / network blip) so callers in catalog.ts can
// distinguish "couldn't check this cycle" from "this item is genuinely
// gone". Collapsing the two used to feed straight into loadCatalog's
// prune pass and could wipe a perfectly good, currently-live deal off the
// board over nothing more than a rate limit.
export async function getItemDetails(
  itemSlug: string,
  cache?: RequestCache
): Promise<ItemDetails | FetchFailed | null> {
  const json = await cachedJson<ItemDetailsPayload>(
    `${config.apiBase}/item/${itemSlug}`,
    cache
  );
  if (json === FETCH_FAILED) return FETCH_FAILED;
  return json?.data ?? null;
}

// Per-/items/{slug} payload (plural "items"): the set manifest carrying
// setParts. arbitrage hit this directly; centralizing it lets the cache
// dedupe any other lookup against the same URL within a cycle.
//
// Returns FETCH_FAILED - not null - on a transient failure, for the same
// reason as getItemDetails above: catalog.ts needs to tell "couldn't
// check the manifest this cycle" apart from "this set no longer has one",
// since only the latter should cause the set (and any live deal row for
// it) to be dropped.
export async function fetchSetManifest(
  setSlug: string,
  cache?: RequestCache
): Promise<{ setParts?: string[] } | FetchFailed | null> {
  const json = await cachedJson<SetManifestPayload>(
    `${config.apiBase}/items/${setSlug}`,
    cache
  );
  if (json === FETCH_FAILED) return FETCH_FAILED;
  return json?.data ?? null;
}
