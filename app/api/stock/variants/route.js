import { authorize, badRequest, ok, serverError } from "@/lib/http";
import { getModelVariants } from "@/lib/stock";

export async function GET(request) {
  const denied = authorize(request);
  if (denied) return denied;

  const baseModel = new URL(request.url).searchParams.get("base_model")?.trim();

  if (!baseModel) {
    return badRequest("Query parameter 'base_model' is required.");
  }

  try {
    return ok(await getModelVariants(baseModel));
  } catch (error) {
    return serverError(error);
  }
}
