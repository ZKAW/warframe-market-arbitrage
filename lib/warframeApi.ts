import { config } from './config';
import { safeGetRequest } from './httpClient';
import type { RequestCache } from './scrape';
import type { WarframeItem, ItemDetails, OrderEntry } from './types';

interface StatisticsClosedWindow {
  volume: number;
  [key: string]: unknown;
}

interface StatisticsPayload {
  statistics_closed?: { '48hours'?: StatisticsClosedWindow[] };
  [key: string]: unknown;
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
// return the parsed JSON (or null on failure) so callers always work against
// the same shape regardless of the cache being wired in.
async function cachedJson<T>(
  url: string,
  cache?: RequestCache
): Promise<T | null> {
  if (cache) return cache.jsonOf<T>(url);
  const res = await safeGetRequest(url);
  if (!res) return null;
  return res.json().catch(() => null) as Promise<T | null>;
}

// The manifest of every tradeable item. Called once per cycle at the top
// of runScrapeCycle; not itself cached since there is exactly one call per
// tick by construction.
export async function fetchAllItems(): Promise<WarframeItem[] | null> {
  const json: ItemListPayload | null = await cachedJson<ItemListPayload>(
    `${config.apiBase}/items`
  );
  return json?.data ?? null;
}

// 48h closed-trade volume for a set slug, from the v1 statistics endpoint.
// Returns null on a missing/failed lookup so the caller can keep the row and
// let minVolume reject it (rather than dropping it as if unprofitable).
export async function fetchStatisticsVolume(
  itemSlug: string,
  cache?: RequestCache
): Promise<number | null> {
  const json = await cachedJson<StatisticsResponse>(
    `${config.v1ApiBase}/items/${itemSlug}/statistics`,
    cache
  );
  const hours = json?.payload?.statistics_closed?.['48hours'] ?? [];
  if (hours.length === 0) return null;
  return hours.reduce((sum, h) => sum + h.volume, 0);
}

export async function fetchPriceData(
  itemSlug: string,
  cache?: RequestCache
): Promise<number | null> {
  const json = await cachedJson<OrdersPayload>(
    `${config.apiBase}/orders/item/${itemSlug}`,
    cache
  );
  const orders: OrderEntry[] = json?.data ?? [];

  const validPrices = orders
    .filter(
      (o) => o?.type === 'sell' && o?.visible === true && o?.user?.status === 'ingame'
    )
    .map((o) => o.platinum);

  return validPrices.length ? Math.min(...validPrices) : null;
}

export async function getItemDetails(
  itemSlug: string,
  cache?: RequestCache
): Promise<ItemDetails | null> {
  const json = await cachedJson<ItemDetailsPayload>(
    `${config.apiBase}/item/${itemSlug}`,
    cache
  );
  return json?.data ?? null;
}

// Per-/items/{slug} payload (plural "items"): the set manifest carrying
// setParts. arbitrage hit this directly; centralizing it lets the cache
// dedupe any other lookup against the same URL within a cycle.
export async function fetchSetManifest(
  setSlug: string,
  cache?: RequestCache
): Promise<{ setParts?: string[] } | null> {
  const json = await cachedJson<SetManifestPayload>(
    `${config.apiBase}/items/${setSlug}`,
    cache
  );
  return json?.data ?? null;
}
