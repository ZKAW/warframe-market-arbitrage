import { getArbitrageData } from "@/lib/arbitrage";
import { getDucatData } from "@/lib/ducats";
import { getRefreshSnapshot } from "@/lib/refresh";
import { subscribe, type Dispatcher, type StreamEvent } from "@/lib/subscriptions";

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  // Disable proxy buffering (nginx and others) so bytes flush as written.
  'X-Accel-Buffering': 'no',
} as const;

const encoder = new TextEncoder();

function sseMessage(event: StreamEvent, payload: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
export async function GET(): Promise<Response> {
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Bootstrap: send current state immediately so the client never
      // flashes empty while waiting for the next scrape cycle.
      controller.enqueue(
        sseMessage('snapshot', {
          arbitrage: getArbitrageData(),
          ducats: getDucatData(),
          refresh: getRefreshSnapshot(),
        })
      );

      const dispatcher: Dispatcher = (event, payload) => {
        // enqueue throws once the client has disconnected; the broadcast
        // loop catches and removes the dead subscriber.
        controller.enqueue(sseMessage(event, payload));
      };
      unsubscribe = subscribe(dispatcher);

      // SSE comment line keeps idle connections alive through proxies
      // without surfacing as a real event to onmessage. Self-terminates
      // on enqueue failure (controller closed by client disconnect).
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 15_000);
    },
    cancel() {
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
