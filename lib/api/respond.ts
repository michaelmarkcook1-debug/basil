/**
 * lib/api/respond.ts — one error envelope + validated body parsing.
 *
 * Routes return inconsistent error shapes today ({error}, {ok:false}, plain
 * text) and zero runtime validation, so the client can't have a single error
 * handler. This standardizes both:
 *
 *   const parsed = await parseBody(req, MySchema);
 *   if (!parsed.ok) return parsed.response;   // 400 { error, code:"invalid_body", details }
 *   // parsed.data is typed + validated
 *
 *   return apiError("Not found", "not_found", 404);
 *
 * server-only.
 */

import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";

/** Unified error envelope: { error, code }. */
export function apiError(message: string, code: string, status: number, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, code, ...(extra ?? {}) }, { status });
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/**
 * Parse + validate a JSON request body against a Zod schema. On failure returns
 * a ready-to-return 400 with the unified envelope and field-level details.
 */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: apiError("Request body must be valid JSON", "invalid_json", 400) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.slice(0, 8).map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return {
      ok: false,
      response: apiError("Invalid request body", "invalid_body", 400, { details }),
    };
  }
  return { ok: true, data: result.data };
}
