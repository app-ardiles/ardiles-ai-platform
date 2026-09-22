import { authorize, badRequest, ok, serverError } from "@/lib/http";
import { getStockByLocation } from "@/lib/stock";

export async function GET(request) {
  const denied = authorize(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const barang = url.searchParams.get("barang")?.trim();
  const lokasi = url.searchParams.get("lokasi")?.trim();

  if (!barang || !lokasi) {
    return badRequest("Query parameters 'barang' and 'lokasi' are required.");
  }

  try {
    return ok(await getStockByLocation(barang, lokasi));
  } catch (error) {
    return serverError(error);
  }
}
