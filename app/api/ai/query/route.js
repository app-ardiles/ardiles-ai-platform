import { NextResponse } from "next/server";

import {
  badRequest,
  serverError,
} from "@/lib/http";

import {
  runAiReadQuery,
} from "@/lib/ai-read-query";


// =========================================================
// Dedicated AI Query API
//
// IMPORTANT:
// Unlike older endpoints, this endpoint MUST NOT become
// public when ARDILES_API_KEY is missing.
// =========================================================

function authorizeAiQuery(request) {
  const required =
    String(
      process.env.ARDILES_API_KEY ?? ""
    ).trim();

  if (!required) {
    return NextResponse.json(
      {
        success: false,
        error: "ai_query_not_configured",
        message:
          "ARDILES_API_KEY must be configured before AI query access can be used.",
      },
      {
        status: 503,
      }
    );
  }

  const supplied =
    String(
      request.headers.get(
        "x-ardiles-api-key"
      ) ?? ""
    ).trim();

  if (supplied !== required) {
    return NextResponse.json(
      {
        success: false,
        error: "unauthorized",
      },
      {
        status: 401,
      }
    );
  }

  return null;
}


// =========================================================
// POST /api/ai/query
//
// Body:
// {
//   "sql": "SELECT ...",
//   "params": [],
//   "limit": 1000
// }
// =========================================================

export async function POST(request) {
  const denied =
    authorizeAiQuery(request);

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


  const sql =
    String(
      body?.sql ?? ""
    ).trim();


  if (!sql) {
    return badRequest(
      "sql is required."
    );
  }


  const params =
    body?.params ?? [];

  if (!Array.isArray(params)) {
    return badRequest(
      "params must be an array."
    );
  }


  try {
    const result =
      await runAiReadQuery({
        sql,
        params,
        limit:
          body?.limit ?? 1000,
      });


    return NextResponse.json(
      {
        success: true,

        access_mode:
          "read_only",

        ...result,
      }
    );
  }
  catch (error) {

    if (
      error instanceof Error &&
      (
        error.message.includes(
          "Only SELECT"
        ) ||
        error.message.includes(
          "Only one SQL statement"
        ) ||
        error.message.includes(
          "not allowed"
        ) ||
        error.message.includes(
          "SQL query is required"
        ) ||
        error.message.includes(
          "params must be an array"
        )
      )
    ) {
      return badRequest(
        error.message
      );
    }


    return serverError(
      error
    );
  }
}