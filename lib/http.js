import { NextResponse } from "next/server";

export function authorize(request) {
  const required = process.env.ARDILES_API_KEY;

  if (!required) return null;

  const supplied = request.headers.get("x-ardiles-api-key");

  if (supplied !== required) {
    return NextResponse.json(
      {
        success: false,
        error: "unauthorized",
      },
      { status: 401 }
    );
  }

  return null;
}

export function ok(data, init = {}) {
  return NextResponse.json(
    {
      success: true,
      ...data,
    },
    init
  );
}

export function badRequest(message) {
  return NextResponse.json(
    {
      success: false,
      error: "bad_request",
      message,
    },
    { status: 400 }
  );
}

export function serverError(error) {
  console.error(error);

  return NextResponse.json(
    {
      success: false,
      error: "internal_error",
      message: "Internal server error.",
    },
    { status: 500 }
  );
}
