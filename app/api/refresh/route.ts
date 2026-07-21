import { requestRefresh } from "@/lib/refresh";
import type { RefreshPipeline } from "@/lib/types";

function isPipeline(v: unknown): v is RefreshPipeline {
  return v === 'arbitrage' || v === 'ducats';
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, reason: 'invalid-body' }, { status: 400 });
  }

  const { pipeline, slug } = (body ?? {}) as { pipeline?: unknown; slug?: unknown };
  if (!isPipeline(pipeline) || typeof slug !== 'string' || !slug) {
    return Response.json({ ok: false, reason: 'invalid-body' }, { status: 400 });
  }

  const result = requestRefresh(pipeline, slug);
  return Response.json(result, { status: result.ok ? 200 : 404 });
}
