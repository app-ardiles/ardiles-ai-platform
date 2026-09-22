import { ok, serverError } from "@/lib/http";
import { query } from "@/lib/db";

export async function GET() {
  try {
    await query("SELECT 1");
    return ok({ status: "ok" });
  } catch (error) {
    return serverError(error);
  }
}
