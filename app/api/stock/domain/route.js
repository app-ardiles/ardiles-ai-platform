import {
  authorize,
  badRequest,
  ok,
  serverError,
} from "@/lib/http";

import {
  runStockDomain,
} from "@/lib/stock-domain";


const OPERATIONS = new Set([
  "query",
  "summary",
  "valuation",
  "rank",
  "compare",
  "changes",
  "data_health",
]);


export async function POST(request) {

  const denied =
    authorize(request);

  if (denied) {
    return denied;
  }


  let body;


  try {

    body =
      await request.json();

  }
  catch {

    return badRequest(
      "Request body must be valid JSON."
    );

  }


  const operation =
    String(
      body?.operation ?? ""
    ).trim();


  if (!OPERATIONS.has(operation)) {

    return badRequest(
      "operation must be one of: " +
      "query, summary, valuation, rank, compare, changes, data_health."
    );

  }


  try {

    return ok(
      await runStockDomain(
        operation,
        body?.args ?? {}
      )
    );

  }
  catch (error) {

    if (
      error instanceof Error &&
      (
        error.message.startsWith("Unsupported") ||
        error.message.startsWith("Invalid pagination") ||
        error.message.includes("requires exactly one") ||
        error.message.includes("requires at least one") ||
        error.message.includes("supports at most three") ||
        error.message.includes("not supported by stock_compare") ||
        error.message.includes("not supported by stock_changes")
      )
    ) {

      return badRequest(
        error.message
      );

    }


    return serverError(error);

  }
}
