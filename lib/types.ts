// Shared data shapes used across lib/ and the API routes/UI that consume them.

export interface PartFill {
  // Slug of the set component this fill was drawn from (e.g. a blueprint
  // or barrel needed by the set). One part can appear more than once here
  // when the set needs more copies of it than a single seller had in
  // stock - see consumePartOrders in lib/arbitrage.ts.
  slug: string;
  username: string;
  platinum: number;
  // Copies bought from this specific order to help satisfy the part's
  // required quantity. Sums to the component's `quantity` across all
  // fills sharing the same slug.
  quantity: number;
}

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
  // Order-by-order breakdown of how total_part_price was assembled: which
  // seller(s) and at what price each part's required quantity was drawn
  // from. A part needing more copies than one seller had in stock shows up
  // as multiple entries sharing the same slug. Powers the Parts cost hover
  // tooltip in the UI.
  part_breakdown: PartFill[];
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
  // Both field spellings show up in the wild depending on API version;
  // fetchSellOrders (warframeApi.ts) checks both when labelling a fill for
  // the Parts cost tooltip, falling back to a placeholder if neither is
  // present rather than breaking the tooltip.
  user?: { status?: string; ingameName?: string; ingame_name?: string };
  [key: string]: unknown;
}

export type RefreshLifecycleStatus = 'queued' | 'in-progress' | 'done';

export interface RefreshStatusEntry {
  slug: string;
  status: RefreshLifecycleStatus;
  requestedAt: number;
  completedAt: number | null;
}

export type RefreshPipeline = 'arbitrage' | 'ducats';
export type RefreshSnapshot = Record<RefreshPipeline, RefreshStatusEntry[]>;
