import {
  authorize,
  ok,
  serverError,
} from "@/lib/http";

import {
  getStockSnapshots,
} from "@/lib/stock-snapshots";


export async function GET(request) {
  const denied = authorize(request);

  if (denied) {
    return denied;
  }


  try {
    return ok(
      await getStockSnapshots()
    );
  }
  catch (error) {
    return serverError(error);
  }
}