// Server-Sent Events fan-out. Each connected SSE client registers a
// dispatcher; the scrape loops broadcast snapshot events to all of them
// the instant a cycle finishes, replacing the old client-pull timer.
//
// Dispatchers are plain functions so the subscription layer never imports
// `Response` or streams - the Route Handler owns the HTTP surface, this
// module owns the in-process pub/sub.
//
// `subscribers` is hoisted to globalThis for the same reason `store` is:
// Next.js dev (Turbopack) can hold multiple module instances of this file
// at once (the scrape loops retain an old instance via their setTimeout
// closures across HMR; an SSE request may import a fresh instance). A
// module-local Set would leave broadcasts and subscribes talking to
// different sets and never crossing. The global survives across module
// re-evaluations, so every instance shares one subscriber pool.

export type StreamEvent = 'snapshot' | 'arbitrage' | 'ducats';
export type Dispatcher = (event: StreamEvent, payload: unknown) => void;

type GlobalWithSubs = typeof globalThis & {
  __warframeMarketSubs__?: Set<Dispatcher>;
};

const g = globalThis as GlobalWithSubs;

function subs(): Set<Dispatcher> {
  if (!g.__warframeMarketSubs__) g.__warframeMarketSubs__ = new Set();
  return g.__warframeMarketSubs__;
}

export function subscribe(dispatcher: Dispatcher): () => void {
  const set = subs();
  set.add(dispatcher);
  return () => set.delete(dispatcher);
}

export function broadcast(event: StreamEvent, payload: unknown): void {
  const set = subs();
  // A throwing dispatcher means the underlying socket is gone; drop it
  // so dead clients don't accumulate and keep paying enqueue cost.
  for (const dispatcher of [...set]) {
    try {
      dispatcher(event, payload);
    } catch {
      set.delete(dispatcher);
    }
  }
}
