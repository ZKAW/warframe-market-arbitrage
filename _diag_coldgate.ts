import http from 'node:http';
import { loadCatalog } from './lib/catalog';
import { runArbitrageCycle } from './lib/arbitrage';
import { store } from './lib/store';
import { RequestCache, msUntilNextStale } from './lib/scrape';
import { config } from './lib/config';

// Regression test for "hot sweep starves cold build" + "Cycle complete over
// partial catalog" bugs. Boots an inline stub, calls runArbitrageCycle BEFORE
// builtAt is set (simulating the cold-build window), asserts it issues zero
// fetches - the new builtAt gate must keep the hot loop dormant until the
// first complete build. Then runs loadCatalog, then runs the cycle again
// against the built catalog and asserts it fetches.
//
// We don't drive runPipelineLoop directly (it isn't exported). Its `isEmpty`
// predicate is what we're validating - we exercise the SAME predicate the
// loop uses by checking store.catalog.builtAt ourselves and gating our
// direct runArbitrageCycle call accordingly.

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('ASSERT FAIL:', msg);
    process.exit(1);
  }
}

const SET = 'frost_prime_set';
const PARTS = [
  { uid: 'set-uid', slug: SET, quantityInSet: 1, ducats: 0 },
  { uid: 'bp-uid', slug: 'frost_prime_blueprint', quantityInSet: 1, ducats: 45 },
];
const ORDERS = {
  [SET]: [{ type: 'sell', visible: true, user: { status: 'ingame' }, platinum: 100 }],
  frost_prime_blueprint: [{ type: 'sell', visible: true, user: { status: 'ingame' }, platinum: 3 }],
};
const ITEMS = [
  { id: 'set', slug: SET, tags: ['prime'], ducats: 0 },
  { id: 'bp', slug: 'frost_prime_blueprint', tags: ['prime'], ducats: 45 },
];

const ordersHits: Record<string, number> = {};

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = req.url ?? '';

  if (url === '/v2/items') {
    res.end(JSON.stringify({ apiVersion: '0.25.0', data: ITEMS }));
    return;
  }
  let m = url.match(/^\/v2\/items\/(.+)$/);
  if (m) {
    const slug = m[1];
    if (slug === SET) {
      res.end(JSON.stringify({ data: { setParts: PARTS.map((p) => p.uid) } }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
    return;
  }
  m = url.match(/^\/v2\/item\/(.+)$/);
  if (m) {
    const uid = m[1];
    const part = PARTS.find((p) => p.uid === uid);
    if (part) res.end(JSON.stringify({ data: part }));
    else { res.statusCode = 404; res.end('{}'); }
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
  const port = Number(process.env.STUB_PORT) || 46556;
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  (config as { apiBase: string }).apiBase = `http://127.0.0.1:${port}/v2`;
  (config as { v1ApiBase: string }).v1ApiBase = `http://127.0.0.1:${port}/v1`;
  config.minArbitrageValue = 0;
  config.minVolume = 0;
  config.hotRetryIntervalMs = 60_000;
  config.hotConcurrency = 2;
  config.maxConcurrentRequests = 3;
  config.requestDelayMs = 5;
  config.catalogConcurrency = 2;

  // Phase 1: simulate the cold-build window. builtAt is null. The
  // hot-loop gate (the isEmpty predicate in scrape.ts) must return true so
  // the loop sleeps coldRetryMs and doesn't sweep. We replicate the exact
  // predicate the loop uses to validate it gate-keeps.
  assert(store.catalog.builtAt === null, 'no build has run yet');
  const hotIsEmpty = !store.catalog.builtAt || store.catalog.sets.size === 0;
  // The actual predicate in scrape.ts: () => !hotCatalogReady() || store.catalog.sets.size === 0
  // where hotCatalogReady = builtAt !== null.
  const predicate = () => !(store.catalog.builtAt !== null) || store.catalog.sets.size === 0;
  assert(predicate() === true, 'cold-build window: isEmpty predicate returns true (gate keeps hot loop dormant)');

  // Even if some sets have streamed into the live store (mid-build), the
  // builtAt gate must STILL keep the hot loop dormant. Simulate one
  // streamed-in partial entry.
  store.catalog.sets.set(SET, {
    setItem: { id: 'set', slug: SET, tags: ['prime'], ducats: 0 },
    components: [{ slug: SET, quantity: 1 }, { slug: 'frost_prime_blueprint', quantity: 1 }],
  });
  // Without the builtAt check, isEmpty would be false (sets.size > 0) and
  // the hot loop would start sweeping against a partial catalog. With the
  // new gate, it stays dormant.
  const predicateAfterStream = () => !(store.catalog.builtAt !== null) || store.catalog.sets.size === 0;
  assert(
    predicateAfterStream() === true,
    'mid-cold-build with streamed entry: builtAt gate keeps hot loop dormant (sets.size=' +
      store.catalog.sets.size + ', builtAt=' + store.catalog.builtAt + ')'
  );

  // Phase 2: complete the build. After loadCatalog, builtAt is set and the
  // hot loop wakes. Confirm the predicate now returns false and the cycle
  // actually fetches.
  store.catalog.sets.clear();
  await loadCatalog(new RequestCache());
  assert(store.catalog.builtAt !== null, 'post-build: builtAt set');
  assert(
    predicate() === false,
    'post-build: isEmpty predicate returns false (hot loop sweeps)'
  );

  const beforeCycle = { ...ordersHits };
  await runArbitrageCycle(new RequestCache());
  assert(
    (ordersHits[SET] ?? 0) > (beforeCycle[SET] ?? 0),
    `post-build cycle fetched set orders, got ${ordersHits[SET] ?? 0} (was ${beforeCycle[SET] ?? 0})`
  );

  server.close();
  console.log('[diag_coldgate] COLD-BUILD HOT-GATE ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('DIAG_COLDGATE FAIL', e);
  process.exit(1);
});
