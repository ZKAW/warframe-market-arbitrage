import { store } from './store';
import { broadcast } from './subscriptions';
import type { RefreshPipeline, RefreshSnapshot, RefreshStatusEntry } from './types';

// How long a completed manual-refresh request stays visible before being
// pruned. Long enough for a client that reconnects a few seconds late to
// still see "done"; short enough that a long-running process doesn't
// accumulate dead entries from a user who spent an afternoon clicking around.
const DONE_TTL_MS = 60_000;

function catalogHas(pipeline: RefreshPipeline, slug: string): boolean {
  return pipeline === 'arbitrage' ? store.catalog.sets.has(slug) : store.catalog.primes.has(slug);
}

// Lazy housekeeping instead of its own timer loop - this app has no other
// background sweep for bookkeeping, and a manual refresh is a rare,
// user-triggered event, so pruning on every read/write is plenty.
function pruneDone(pipeline: RefreshPipeline): void {
  const { refreshRequests } = store.pipelineState[pipeline];
  const now = Date.now();
  for (const [slug, req] of refreshRequests) {
    if (req.status === 'done' && req.completedAt !== null && now - req.completedAt > DONE_TTL_MS) {
      refreshRequests.delete(slug);
    }
  }
}

export type RequestRefreshResult =
  | { ok: true; status: RefreshStatusEntry['status'] }
  | { ok: false; reason: 'unknown-slug' };

// Called by POST /api/refresh when the user clicks "refresh now" on a row.
// Registers a priority request; the stale-driven worker pool in scrape.ts
// checks this map ahead of its normal soonest-deadline pick, so the next
// worker in this pipeline that frees up takes this slug regardless of
// where it sits in the staleness queue or how recently it was fetched.
export function requestRefresh(pipeline: RefreshPipeline, slug: string): RequestRefreshResult {
  pruneDone(pipeline);
  if (!catalogHas(pipeline, slug)) return { ok: false, reason: 'unknown-slug' };

  const { refreshRequests } = store.pipelineState[pipeline];
  const existing = refreshRequests.get(slug);
  // Already queued or being worked on - don't reset requestedAt (would push
  // it behind other queued priority requests) and don't reopen one that
  // just finished; a fresh click always starts a fresh request.
  if (existing && existing.status !== 'done') {
    return { ok: true, status: existing.status };
  }

  refreshRequests.set(slug, { status: 'queued', requestedAt: Date.now(), completedAt: null });
  broadcast('refresh', getRefreshSnapshot());
  return { ok: true, status: 'queued' };
}

export function getRefreshSnapshot(): RefreshSnapshot {
  pruneDone('arbitrage');
  pruneDone('ducats');
  const toEntries = (pipeline: RefreshPipeline): RefreshStatusEntry[] =>
    [...store.pipelineState[pipeline].refreshRequests.entries()].map(([slug, r]) => ({ slug, ...r }));
  return { arbitrage: toEntries('arbitrage'), ducats: toEntries('ducats') };
}
