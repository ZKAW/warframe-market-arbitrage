import { getDucatData } from "@/lib/ducats";

export async function GET(): Promise<Response> {
  return Response.json(getDucatData());
}
