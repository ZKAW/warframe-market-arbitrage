import { getArbitrageData } from '../../../lib/arbitrage';

export async function GET() {
  return Response.json(getArbitrageData());
}
