import type { ArbitrageEntry, DucatEntry, WarframeItem } from './types';

export interface SetComponent {
  slug: string;
  quantity: number;
}

export interface SetEntry {
  setItem: WarframeItem;
  components: SetComponent[];
}

export interface PrimeEntry {
  item: WarframeItem;
  ducats: number;
}

export interface Catalog {
  // setSlug -> { setItem, components[] }. Built once per catalog refresh
  // from /v2/items/{set} manifests + /v2/item/{uid} per part. Survives HMR.
  sets: Map<string, SetEntry>;
  // prime-or-ducated slug -> { item, ducats }. Built from the bulk /v2/items
  // ducats field, falling back to /v2/item/{slug} when the bulk field is
  // absent. Survives HMR.
  primes: Map<string, PrimeEntry>;
  // ISO ts of the last successful catalog build. Null until the first
  // loadCatalog completes. Hot loops no-op while null.
  builtAt: string | null;
}

interface Store {
  arbitrage: Map<string, ArbitrageEntry>;
  ducats: Map<string, DucatEntry>;
  // Active scrape-loop cancellation tokens, one per pipeline ('arbitrage'
  // / 'ducats'). A token is cancelled whenever a new scrape loop supersedes
  // it; the tick loop checks `cancelled` before scheduling the next cycle
  // and before broadcasting, so a defunct tick chain from a hot-reloaded
  // old module instance stops touching the store or the SSE stream.
  // Namespaced by pipeline so two pipelines can be tracked independently.
  loopTokens: Map<'arbitrage' | 'ducats', { cancelled: boolean }>;
  // Cancellation token for the catalog-rebuild loop. Cancelled in
  // startScrapeLoop before minting a fresh one, same pattern as loopTokens.
  catalogToken: { cancelled: boolean } | null;
  // Guard so instrumentation's register() can be called more than once
  // (Next.js docs recommend not assuming exactly-once) without stacking
  // up a duplicate scrape loop.
  loopsStarted: boolean;
  // Lets the frontend distinguish "no matches yet" from
  // "first scrape hasn't finished yet".
  ready: { arbitrage: boolean; ducats: boolean };
  // ISO timestamp of the most recent completed cycle per pipeline, set
  // by markReady. Null until the first full cycle has landed. Used by the
  // UI to show "last cycle finished X ago". Lives in the store (not as a
  // cycle-local var) so it survives HMR alongside the data it describes.
  lastCycleCompletedAt: { arbitrage: string | null; ducats: string | null };
  // Static catalog: set->components map and prime->ducats map. Rebuilt on
  // a slow timer separately from the hot price-refresh loop. Lives in the
  // store (same HMR reason as lastCycleCompletedAt). The hot loops read
  // this instead of re-deriving manifests/details every cycle.
  catalog: Catalog;
}

type GlobalWithStore = typeof globalThis & {
  __warframeMarketStore__?: Store;
};

const g = globalThis as GlobalWithStore;

function initStore(): Store {
  if (!g.__warframeMarketStore__) {
    g.__warframeMarketStore__ = {
      arbitrage: new Map(),
      ducats: new Map(),
      loopTokens: new Map(),
      catalogToken: null,
      loopsStarted: false,
      ready: { arbitrage: false, ducats: false },
      lastCycleCompletedAt: { arbitrage: null, ducats: null },
      catalog: { sets: new Map(), primes: new Map(), builtAt: null },
    };
  }
  return g.__warframeMarketStore__;
}

export const store = initStore();

