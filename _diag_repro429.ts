import { loadCatalog } from './lib/catalog';
import { runArbitrageCycle, getArbitrageData } from './lib/arbitrage';
import { store } from './lib/store';
import { RequestCache } from './lib/scrape';
import { config } from './lib/config';

config.minArbitrageValue = 0;
config.minVolume = 0;
config.minDucatPerPlatinum = 0;
config.minDucats = 0;

(async () => {
  await loadCatalog(new RequestCache());
  console.log('--- catalog built, sets=', store.catalog.sets.size);
  // Pre-seed an arbitrage row so we can observe whether it survives 429 chaos.
  store.arbitrage.set('frost_prime_set', {
    set: 'frost_prime_set',
    arbitrage_value: 999,
    set_price: 999,
    total_part_price: 0,
    volume: 999,
    market_url: 'https://warframe.market/items/frost_prime_set',
    last_updated: new Date(Date.now() - 60_000).toISOString(),
    tags: [],
  });
  console.log('--- seeded row, arb.size=', store.arbitrage.size);

  // Run a cycle. Orders endpoint will 429 forever - fetchPriceData should
  // return FETCH_FAILED (or today: null and silently delete our seeded row).
  await runArbitrageCycle(new RequestCache());
  const d = getArbitrageData();
  console.log('--- after cycle, arb.size=', d.data.length);
  for (const row of d.data) console.log('  row:', row.set, '=', row.arbitrage_value);
  if (d.data.length !== 1) {
    console.error('REGRESSION: seeded row was wiped by 429 cascade.');
    process.exit(1);
  }
  if (d.data[0].arbitrage_value !== 999) {
    console.error('REGRESSION: seeded row was overwritten with bad data.');
    process.exit(1);
  }
  console.log('PASS: row survived 429 cascade');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
