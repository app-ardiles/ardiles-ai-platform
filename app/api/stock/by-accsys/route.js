import { authorize, badRequest, ok, serverError } from "@/lib/http";
import { getStockByAccsys } from "@/lib/stock";

export async function GET(request) {
  const denied = authorize(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const barang = url.searchParams.get("barang")?.trim();
  const accsys = url.searchParams.get("accsys")?.trim();

  if (!barang || !accsys) {
    return badRequest("Query parameters 'barang' and 'accsys' are required.");
  }

  try {
    return ok(await getStockByAccsys(barang, accsys));
  } catch (error) {
    return serverError(error);
  }
}
