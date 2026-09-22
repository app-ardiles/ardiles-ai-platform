import { authorize, badRequest, ok, serverError } from "@/lib/http";
import { getLocationSummary } from "@/lib/stock";

export async function GET(request) {
  const denied = authorize(request);
  if (denied) return denied;

  const lokasi = new URL(request.url).searchParams.get("lokasi")?.trim();

  if (!lokasi) return badRequest("Query parameter 'lokasi' is required.");

  try {
    return ok(await getLocationSummary(lokasi));
  } catch (error) {
    return serverError(error);
  }
}
