// Shared data shapes used across lib/ and the API routes/UI that consume them.

export interface ArbitrageEntry {
  set: string;
  arbitrage_value: number;
  set_price: number;
  total_part_price: number;
  market_url: string;
  last_updated: string;
}

export interface DucatEntry {
  item: string;
  ducats: number;
  platinum_price: number;
  ducat_per_platinum: number;
  platinum_per_ducat: number;
  market_url: string;
  last_updated: string;
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
  user?: { status?: string };
  [key: string]: unknown;
}
