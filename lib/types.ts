// Shared data shapes used across lib/ and the API routes/UI that consume them.

export interface ArbitrageEntry {
  set: string;
  arbitrage_value: number;
  set_price: number;
  total_part_price: number;
  // Copies offered in the cheapest in-game sell order for the set itself.
  quantity: number | null;
  // 48h closed-trade volume from the v1 statistics endpoint; null when the
  // statistics call failed (the row is then kept but never passes minVolume).
  volume: number | null;
  // Volume-weighted average price across the 48h closed-trade windows from
  // the v1 statistics endpoint; null when the call failed or returned no
  // windows with an avg_price.
  avg_price: number | null;
  market_url: string;
  last_updated: string;
  tags: string[];
}

export interface DucatEntry {
  item: string;
  ducats: number;
  platinum_price: number;
  // Copies offered in the cheapest in-game sell order backing this row.
  quantity: number;
  ducat_per_platinum: number;
  platinum_per_ducat: number;
  market_url: string;
  last_updated: string;
  tags: string[];
}

// warframe.market's v2 API responses - only the fields this app reads are
// modeled; `[key: string]: unknown` lets the rest pass through untyped
// rather than forcing a full schema.

export interface WarframeItem {
  slug: string;
  ducats?: number | null;
  tags?: string[];
  [key: string]: unknown;
}

export interface ItemDetails {
  slug: string;
  ducats?: number | null;
  quantityInSet?: number;
  setParts?: string[];
  [key: string]: unknown;
}

export interface OrderEntry {
  type: 'sell' | 'buy';
  visible: boolean;
  platinum: number;
  quantity: number;
  user?: { status?: string };
  [key: string]: unknown;
}
