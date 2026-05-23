import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";
import { getFlags } from "@/core/feature-flags";
import { buildIntelligenceContext } from "@/core/context/intelligence-context-builder";
import { serializeContext } from "@/core/primitives/intelligence-context";

/**
 * GET /api/admin/intelligence-context
 *
 * Diagnostic endpoint — assembles and returns the IntelligenceContext that
 * would be injected into an AI prompt for this user right now.
 * No AI call is made. Useful for verifying context quality before enabling
 * dispatch_active.
 *
 * Admin-only.
 *
 * Query params:
 *   serialized — "1" to include the serialized prompt string (what the AI sees)
 *
 * Response:
 * {
 *   context: IntelligenceContext,
 *   serialized?: string,         // prompt-ready string (when ?serialized=1)
 *   flagsActive: { ... }
 * }
 */

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!isAdminUser(username)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = req.nextUrl;
  const includeSerialized = searchParams.get("serialized") === "1";

  const flags = await getFlags(username);

  const context = await buildIntelligenceContext({
    username,
    currentSignal: null,
    flags,
  });

  const response: Record<string, unknown> = {
    context,
    flagsActive: {
      signalEvent_active:       flags.signalEvent_active,
      canonicalIdentity_active: flags.canonicalIdentity_active,
      ranking_active:           flags.ranking_active,
      dispatch_shadow:          flags.dispatch_shadow,
      dispatch_active:          flags.dispatch_active,
    },
    assembledInMs: Date.now() - t0,
  };

  if (includeSerialized) {
    response.serialized = serializeContext(context);
  }

  console.info(
    `[admin/intelligence-context] ${username} ` +
    `tokens=${context.estimatedTokens}/${context.tokenBudget} ` +
    `signals=${context.recentSignals.length} ` +
    `ranked=${context.topRankedPending.length} ` +
    `${Date.now() - t0}ms`
  );

  return NextResponse.json(response);
}
