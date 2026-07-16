import { config } from './config';
import { safeGetRequest } from './httpClient';

export async function fetchAllItems() {
  const res = await safeGetRequest(`${config.apiBase}/items`);
  if (!res) return null;
  const json = await res.json();
  return json?.data ?? null;
}

export async function fetchPriceData(itemSlug) {
  const res = await safeGetRequest(`${config.apiBase}/orders/item/${itemSlug}`);
  if (!res) return null;

  const json = await res.json();
  const orders = json?.data ?? [];

  const validPrices = orders
    .filter(
      (o) => o?.type === 'sell' && o?.visible === true && o?.user?.status === 'ingame'
    )
    .map((o) => o.platinum);

  return validPrices.length ? Math.min(...validPrices) : null;
}

export async function getItemDetails(itemSlug) {
  const res = await safeGetRequest(`${config.apiBase}/item/${itemSlug}`);
  if (!res) return null;
  const json = await res.json();
  return json?.data ?? null;
}
