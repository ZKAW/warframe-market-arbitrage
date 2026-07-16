import { getDucatData } from '../../../lib/ducats';

export async function GET() {
  return Response.json(getDucatData());
}
