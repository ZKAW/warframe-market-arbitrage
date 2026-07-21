import { getArbitrageData } from "@/lib/arbitrage";

export async function GET(): Promise<Response> {
  return Response.json(getArbitrageData());
}
