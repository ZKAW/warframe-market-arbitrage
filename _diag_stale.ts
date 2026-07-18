import http from 'node:http';
import { loadCatalog } from './lib/catalog';
import { runArbitrageCycle } from './lib/arbitrage';
import { store } from './lib/store';
import { RequestCache } from './lib/scrape';
import { config } from './lib/config';

// Regression test for the "hot reload re-fetches fresh rows" bug. Boots an
// inline stub warframe.market, builds a 2-set catalog, pre-seeds one set as
// freshly priced, leaves the other unpriced, and runs runArbitrageCycle.
// Asserts: the fresh set is NOT re-fetched, the unpriced set IS fetched, and
// the cycle returns a positive delay (ms until the freshly-priced row would
// go stale). A second cycle should fetch nothing and return another positive
// delay - proving the loop can idle without busy-spinning.

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('ASSERT FAIL:', msg);
    process.exit(1);
  }
}

// Two minimal sets: FRESH_SET (pre-seeded) and COLD_SET (never priced).
// Each set has its own slug as the only component so processSingleSet
// issues exactly one orders fetch per set (set-price path) plus one
// statistics fetch per set.
const FRESH = 'fresh_prime_set';
const COLD = 'cold_prime_set';

// Count orders-fetch hits per slug.
const ordersHits: Record<string, number> = {};

// A profitable price so the row survives minArbitrageValue/minVolume gates.
const ORDERS = {
  [FRESH]: [{ type: 'sell', visible: true, user: { status: 'ingame' }, platinum: 100 }],
  [COLD]:  [{ type: 'sell', visible: true, user: { status: 'ingame' }, platinum: 100 }],
};

const ITEMS = [
  { id: 'fresh-set', slug: FRESH, tags: ['prime'], ducats: 0 },
  { id: 'cold-set', slug: COLD, tags: ['prime'], ducats: 0 },
];

// Each set's manifest points to a single part uid, and that uid's `slug`
// equals the set itself - so processSingleSet's "if (slug === setSlug)"
// branch handles it as a set-price fetch (one orders call) rather than
// splitting into per-part fetches. Keeps the test minimal.
const PARTS_BY_SET: Record<string, { uid: string; slug: string; quantityInSet: number; ducats: number }[]> = {
  [FRESH]: [{ uid: 'fresh-set', slug: FRESH, quantityInSet: 1, ducats: 0 }],
  [COLD]:  [{ uid: 'cold-set', slug: COLD, quantityInSet: 1, ducats: 0 }],
};

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = req.url ?? '';

  if (url === '/v2/items') {
    res.end(JSON.stringify({ apiVersion: '0.25.0', data: ITEMS }));
    return;
  }
  let m = url.match(/^\/v2\/items\/(.+)$/);
  if (m) {
    const setSlug = m[1];
    const parts = PARTS_BY_SET[setSlug];
    if (parts) {
      res.end(JSON.stringify({ data: { setParts: parts.map((p) => p.uid) } }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
    return;
  }
  m = url.match(/^\/v2\/item\/(.+)$/);
  if (m) {
    const uid = m[1];
    const part = Object.values(PARTS_BY_SET).flat().find((p) => p.uid === uid);
    if (part) res.end(JSON.stringify({ data: part }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
    return;
  }
  m = url.match(/^\/v2\/orders\/item\/(.+)$/);
  if (m) {
    const slug = m[1];
    ordersHits[slug] = (ordersHits[slug] ?? 0) + 1;
    res.end(JSON.stringify({ data: ORDERS[slug as keyof typeof ORDERS] ?? [] }));
    return;
  }
  m = url.match(/^\/v1\/items\/(.+)\/statistics$/);
  if (m) {
    res.end(JSON.stringify({ payload: { statistics_closed: { '48hours': [{ volume: 99 }] } } }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

(async () => {
  const port = Number(process.env.STUB_PORT) || 46555;
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  process.env.WARFRAME_API_BASE = `http://127.0.0.1:${port}/v2`;

  // We imported config above with the production apiBase already captured,
  // so override the live fields to point at our stub.
  (config as { apiBase: string }).apiBase = `http://127.0.0.1:${port}/v2`;
  (config as { v1ApiBase: string }).v1ApiBase = `http://127.0.0.1:${port}/v1`;
  config.minArbitrageValue = 0;
  config.minVolume = 0;
  config.minDucatPerPlatinum = 0;
  config.minDucats = 0;
  // Use a short staleness budget so the second cycle's delay is bounded in
  // the test. The arbitrage cycle reads this at call time.
  config.hotRetryIntervalMs = 2000;
  config.hotConcurrency = 2;
  config.maxConcurrentRequests = 2;
  config.requestDelayMs = 5;

  await loadCatalog(new RequestCache());
  assert(store.catalog.sets.size === 2, `catalog has 2 sets, got ${store.catalog.sets.size}`);

  // Pre-seed FRESH as just-priced now: skip gate must fire next cycle.
  store.arbitrage.set(FRESH, {
    set: FRESH,
    arbitrage_value: 999,
    set_price: 100,
    total_part_price: 0,
    volume: 99,
    market_url: `https://warframe.market/items/${FRESH}`,
    last_updated: new Date().toISOString(),
    tags: [],
  });

  // Cycle 1: COLD must get fetched, FRESH skipped.
  const delay1 = await runArbitrageCycle(new RequestCache());
  assert(ordersHits[FRESH] === undefined, `fresh set was NOT re-fetched, got ${ordersHits[FRESH] ?? 0} hits`);
  assert((ordersHits[COLD] ?? 0) >= 1, `cold set WAS fetched, got ${ordersHits[COLD] ?? 0} hits`);
  assert(
    store.arbitrage.get(FRESH)?.arbitrage_value === 999,
    'fresh row preserved unchanged (skip did not overwrite)'
  );
  assert(
    store.arbitrage.get(COLD)?.set_price === 100,
    'cold row newly priced'
  );
  // Cycle 1 did work (COLD fetched) => delay is 0 so the loop re-ticks.
  assert(delay1 === 0, `cycle 1 did work so delay is 0, got ${delay1}`);

  // Force both rows' last_updated to now so cycle 2 sees a fully fresh catalog.
  const freshTs = new Date().toISOString();
  if (store.arbitrage.get(FRESH)) store.arbitrage.get(FRESH)!.last_updated = freshTs;
  if (store.arbitrage.get(COLD))  store.arbitrage.get(COLD)!.last_updated = freshTs;
  const beforeCycle2 = { ...ordersHits };

  // Cycle 2: both rows fresh => no fetches, delay > 0.
  const delay2 = await runArbitrageCycle(new RequestCache());
  assert(
    (ordersHits[FRESH] ?? 0) === (beforeCycle2[FRESH] ?? 0),
    `cycle 2 did not re-fetch FRESH, got ${ordersHits[FRESH] ?? 0} (was ${beforeCycle2[FRESH] ?? 0})`
  );
  assert(
    (ordersHits[COLD] ?? 0) === (beforeCycle2[COLD] ?? 0),
    `cycle 2 did not re-fetch COLD, got ${ordersHits[COLD] ?? 0} (was ${beforeCycle2[COLD] ?? 0})`
  );
  assert(delay2 > 0, `cycle 2 fully fresh => positive delay, got ${delay2}`);
  assert(
    delay2 <= config.hotRetryIntervalMs,
    `delay is bounded by staleness budget, got ${delay2} > ${config.hotRetryIntervalMs}`
  );

  // Cycle 3: advance a row past the budget => should fetch only that one.
  // Push COLD's last_updated far into the past.
  if (store.arbitrage.get(COLD)) {
    store.arbitrage.get(COLD)!.last_updated = new Date(Date.now() - config.hotRetryIntervalMs * 3).toISOString();
  }
  const beforeCycle3 = { ...ordersHits };
  const delay3 = await runArbitrageCycle(new RequestCache());
  assert(
    (ordersHits[COLD] ?? 0) > (beforeCycle3[COLD] ?? 0),
    `cycle 3 re-fetched stale COLD, got ${ordersHits[COLD] ?? 0} (was ${beforeCycle3[COLD] ?? 0})`
  );
  assert(
    (ordersHits[FRESH] ?? 0) === (beforeCycle3[FRESH] ?? 0),
    `cycle 3 did NOT re-fetch still-fresh FRESH, got ${ordersHits[FRESH] ?? 0} (was ${beforeCycle3[FRESH] ?? 0})`
  );
  assert(delay3 === 0, `cycle 3 did work => delay 0, got ${delay3}`);

  server.close();
  console.log('[diag_stale] STALE-SKIP + DELAY ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('DIAG_STALE FAIL', e);
  process.exit(1);
});
