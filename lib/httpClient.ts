import { config } from './config';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HEADERS = {
  Language: 'en',
  Platform: 'pc',
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0',
};

// Process-wide semaphore bounding in-flight warframe.market fetches. The
// catalog build, the arbitrage sweep, and the ducats sweep all run on their
// own loops with their own HOT_CONCURRENCY/CATALOG_CONCURRENCY worker pools,
// but those pools all funnel into safeGetRequest - so a single acquire here
// is the one place that caps simultaneous downstream requests. Without this,
// the catalog build and hot sweeps would stack their worker counts against
// the same rate limit and 429-storm within seconds of startup. With it,
// maxConcurrentRequests is the single knob that sizes the burst; the
// per-pipeline concurrency settings just split that budget across workers.
//
// The semaphore is module-global (not per-request) so it survives across
// retries inside safeGetRequest: a held slot is released the moment fetch()
// resolves, long before requestDelayMs throttling or a 429 backoff naps -
// so the actual rate stays bounded by requestDelayMs even while in-flight
// concurrency is at the cap.
let inflight = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (inflight < config.maxConcurrentRequests) {
    inflight++;
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  waiters.push(() => {
    inflight++;
    resolve();
  });
  return promise;
}

export async function safeGetRequest(
  url: string,
  { retries = 5 }: { retries?: number } = {}
): Promise<Response | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await acquire();
    try {
      const res = await fetch(url, { headers: HEADERS });

      if (res.status === 200) {
        await sleep(config.requestDelayMs);
        return res;
      }

      if (res.status === 404) {
        return null;
      }

      if (res.status === 429) {
        console.log(`Rate limited (429). Waiting ${config.rateLimitDelayMs / 1000}s...`);
        await sleep(config.rateLimitDelayMs);
        continue;
      }

      // Unexpected status: don't hot-loop against the API, back off a
      // little then let the retry loop try again.
      await sleep(1000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`Request error: ${message}`);
      await sleep(2000);
    } finally {
      inflight--;
      const next = waiters.shift();
      if (next) next();
    }
  }

  return null;
}
