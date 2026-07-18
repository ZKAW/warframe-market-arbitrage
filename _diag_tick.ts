import { loadCatalog } from './lib/catalog';
import { runArbitrageCycle } from './lib/arbitrage';
import { store } from './lib/store';
import { RequestCache } from './lib/scrape';
import { config } from './lib/config';

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('ASSERT FAIL:', msg);
    process.exit(1);
  }
}

// Minimal test-only twin of runPipelineLoop's tick guard contract:
//   skip markReady() + "Cycle complete." while store.catalog.sets is empty.
async function runTick(
  name: 'arbitrage' | 'ducats',
  run: (cache: RequestCache) => Promise<void>,
  markReady: () => void
): Promise<void> {
  console.log(`[${name}] Cycle started: ${new Date().toISOString()}`);
  if (store.catalog.sets.size === 0) {
    console.log(`[${name}] No catalog sets yet; hot cycle skipped.`);
  } else {
    const cache = new RequestCache();
    await run(cache);
    markReady();
    console.log(`[${name}] Cycle complete.`);
  }
}

// Read `store.ready.arbitrage` through Boolean() so the `=== false` assertion
// here doesn't narrow the shared field and trip TS2367 on the later `=== true`
// assertion - the field is mutated inside a closure TS can't track through.
(async () => {
  // Pre-build cycle: catalog is empty, must skip and NOT markReady.
  store.ready.arbitrage = false;
  await runTick('arbitrage', runArbitrageCycle, () => {
    store.ready.arbitrage = true;
  });
  assert(Boolean(store.ready.arbitrage) === false, 'arbitrage NOT marked ready during skip');

  // Build catalog: streams its first set in, sets builtAt on completion.
  await loadCatalog(new RequestCache());
  assert(store.catalog.builtAt, 'catalog built');

  // Post-build cycle: catalog non-empty, must markReady + print "Cycle complete."
  await runTick('arbitrage', runArbitrageCycle, () => {
    store.ready.arbitrage = true;
  });
  assert(Boolean(store.ready.arbitrage) === true, 'arbitrage marked ready after real sweep');

  console.log('[diag2] TICK GUARD ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('DIAG2 FAIL', e);
  process.exit(1);
});
void config;
