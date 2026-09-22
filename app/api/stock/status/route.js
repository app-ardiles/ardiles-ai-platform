import { authorize, ok, serverError } from "@/lib/http";
import { getStockDataStatus } from "@/lib/stock";

export async function GET(request) {
  const denied = authorize(request);
  if (denied) return denied;

  try {
    return ok(await getStockDataStatus());
  } catch (error) {
    return serverError(error);
  }
}
