export async function register(): Promise<void> {
  // Only run in the Node.js runtime (not Edge) - these loops use plain
  // fetch/setTimeout but there's no reason to load them into an edge
  // bundle that will never call register in that environment anyway.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Dynamic import keeps the scrape loop's transitive graph out of the
    // edge bundle entirely; a static import would pull it in despite the
    // runtime guard at runtime. This is the platform-specific-module
    // exception to the static-import rule.
    const { startScrapeLoop } = await import('./lib/scrape');

    // Fire-and-forget: register() must resolve quickly since Next.js won't
    // start serving requests until it does. The loop keeps running in the
    // background for the lifetime of the process.
    startScrapeLoop();
  }
}
