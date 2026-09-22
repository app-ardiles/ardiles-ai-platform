import { authorize, badRequest, ok, serverError } from "@/lib/http";
import { getStockDetail } from "@/lib/stock";

export async function GET(request) {
  const denied = authorize(request);
  if (denied) return denied;

  const barang = new URL(request.url).searchParams.get("barang")?.trim();

  if (!barang) return badRequest("Query parameter 'barang' is required.");

  try {
    return ok(await getStockDetail(barang));
  } catch (error) {
    return serverError(error);
  }
}
