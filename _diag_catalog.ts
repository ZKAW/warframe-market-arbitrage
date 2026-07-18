import { loadCatalog } from './lib/catalog';
import { runArbitrageCycle, getArbitrageData } from './lib/arbitrage';
import { runDucatCycle, getDucatData } from './lib/ducats';
import { store } from './lib/store';
import { RequestCache } from './lib/scrape';

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('ASSERT FAIL:', msg);
    process.exit(1);
  }
}

(async () => {
  // 1) runArbitrageCycle when catalog not built: should be called but do nothing
  //    (skipped-guard has moved to the tick, so the cycle body would actually
  //    run pruneDelistedSets against an empty map and the map over an empty
  //    store.catalog.sets.values()). Verify it doesn't error.
  await runArbitrageCycle(new RequestCache());
  await runDucatCycle(new RequestCache());

  // 2) loadCatalog builds sets + primes
  await loadCatalog(new RequestCache());
  assert(store.catalog.builtAt, 'catalog builtAt set');
  assert(store.catalog.sets.size === 1, `sets size 1, got ${store.catalog.sets.size}`);
  const setEntry = store.catalog.sets.get('frost_prime_set');
  assert(setEntry, 'frost_prime_set in catalog');
  assert(setEntry!.components.length === 5, `5 parts, got ${setEntry!.components.length}`);
  assert(store.catalog.primes.size === 3, `primes size 3, got ${store.catalog.primes.size}`);
  const primeEntry = store.catalog.primes.get('frost_prime_blueprint');
  assert(primeEntry, 'frost_prime_blueprint prime in catalog');
  assert(primeEntry!.ducats === 45, `prime ducats 45, got ${primeEntry!.ducats}`);

  // 3) hot cycle now runs against catalog and computes arbitrage.
  //    The tick's guard has been removed from the runX. We test the run-cycle
  //    function directly: with catalog built, it sweeps.
  await runArbitrageCycle(new RequestCache());
  const arb = getArbitrageData();
  console.log('[diag] arb.data.length=', arb.data.length);
  assert(arb.data.length === 1, `1 arb row, got ${arb.data.length}`);
  const row = arb.data[0];
  assert(row.arbitrage_value === 25, `arbitrage 25, got ${row.arbitrage_value}`);
  assert(row.total_part_price === 15, `parts cost 15, got ${row.total_part_price}`);

  // 4) ducats hot cycle against catalog
  await runDucatCycle(new RequestCache());
  const duc = getDucatData();
  assert(duc.data.length === 2, `2 ducat rows, got ${duc.data.length}`);

  console.log('[diag] ALL ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('DIAG FAIL', e);
  process.exit(1);
});
