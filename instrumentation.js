export async function register() {
  // Only run in the Node.js runtime (not Edge) - these loops use plain
  // fetch/setTimeout but there's no reason to load them into an edge
  // bundle that will never call register in that environment anyway.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startArbitrageLoop } = await import('./lib/arbitrage');
    const { startDucatLoop } = await import('./lib/ducats');

    // Both are fire-and-forget: register() must resolve quickly since
    // Next.js won't start serving requests until it does. The loops keep
    // running in the background for the lifetime of the process.
    startArbitrageLoop();
    startDucatLoop();
  }
}
