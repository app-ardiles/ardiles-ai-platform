import { authorize, badRequest, ok, serverError } from "@/lib/http";
import { searchStockItem } from "@/lib/stock";

export async function GET(request) {
  const denied = authorize(request);
  if (denied) return denied;

  const q = new URL(request.url).searchParams.get("q")?.trim();

  if (!q) return badRequest("Query parameter 'q' is required.");

  try {
    return ok(await searchStockItem(q));
  } catch (error) {
    return serverError(error);
  }
}
