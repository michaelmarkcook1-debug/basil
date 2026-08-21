import { NextResponse } from "next/server";
import { getStigRequestUser } from "@/lib/stig/auth";
import { runStigAsk } from "@/lib/stig/engine";
import { SpendCapError, spendCapResponse } from "@/lib/ai/spend-guard";
import { mapProviderError } from "@/lib/stig/error-mapper";
import { checkRateLimitDurable } from "@/lib/rate-limit";
import type { StigAskRequest } from "@/lib/stig/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BODY_BYTES = 100_000;
const MAX_QUESTION_CHARS = 4_000; // ~1 000 tokens; prevents prompt-stuffing
const STIG_RATE_LIMIT = 20; // AI calls per minute per IP

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, "Bearer ***");
}

export async function POST(req: Request) {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const user = await getStigRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  // Durable (cross-instance) limiter keyed on the AUTHENTICATED principal — this
  // is an AI-spend guardrail, so a per-instance in-memory Map (ceiling ×N warm
  // instances) and an IP key (spoofable, shared behind NAT) are both wrong here.
  const rl = await checkRateLimitDurable(`stig:ask:${user.username.toLowerCase()}`, STIG_RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests — slow down" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  let body: StigAskRequest;
  try {
    body = await req.json() as StigAskRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.question === "string" && body.question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: `Question too long (max ${MAX_QUESTION_CHARS} characters)` },
      { status: 400 }
    );
  }

  try {
    const result = await runStigAsk(user.username, body, user.authMode);
    return NextResponse.json(result);
  } catch (err) {
    // AI spend cap — return 429 with Retry-After.
    if (err instanceof SpendCapError) {
      return spendCapResponse(err);
    }

    // Check if this is an already-mapped engine error (has a .code property)
    const errWithCode = err as Error & { code?: string; narrowingOptions?: string[] };
    if (errWithCode.code && errWithCode.message && !errWithCode.message.includes("question is required")) {
      console.error("[api/stig/ask] failed:", safeError(err));
      return NextResponse.json(
        {
          error: errWithCode.message,
          code: errWithCode.code,
          ...(errWithCode.narrowingOptions ? { narrowingOptions: errWithCode.narrowingOptions } : {}),
        },
        { status: 500 }
      );
    }

    // For question validation errors, return 400 with safe message
    const message = safeError(err);
    if (message.includes("question is required")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // For any other unhandled error, map it
    const mapped = mapProviderError(err);
    console.error("[api/stig/ask] failed:", safeError(err));
    return NextResponse.json(
      {
        error: mapped.userMessage,
        code: mapped.code,
        ...(mapped.narrowingOptions ? { narrowingOptions: mapped.narrowingOptions } : {}),
      },
      { status: 500 }
    );
  }
}
