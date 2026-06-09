import { NextResponse } from "next/server";
import { requireUser, AuthRequiredError } from "@/lib/auth";
import { resolveProvider } from "@/lib/billing/provider";
import type { Plan } from "@/lib/billing/plans";

/**
 * POST /api/billing/checkout
 * Body: { plan: "pro" }
 *
 * Starts a checkout session via the active provider and returns a redirect URL.
 * With the StubProvider (no live keys) this applies a 14-day Pro trial
 * immediately and returns the success URL, so the upgrade flow is exercisable
 * end-to-end locally. With a real provider it returns the hosted checkout URL.
 */
export async function POST(req: Request) {
  try {
    const username = await requireUser();

    const body = (await req.json().catch(() => ({}))) as { plan?: string };
    const plan = body.plan as Plan | undefined;
    if (plan !== "pro" && plan !== "free") {
      return NextResponse.json({ error: "Invalid or missing plan" }, { status: 400 });
    }

    const origin = new URL(req.url).origin;
    const provider = resolveProvider();
    const session = await provider.createCheckoutSession({
      username,
      plan,
      successUrl: `${origin}/dashboard/settings?billing=success`,
      cancelUrl: `${origin}/dashboard/settings?billing=cancel`,
    });

    console.info(`[billing/checkout] user=${username} plan=${plan} provider=${provider.name}`);
    return NextResponse.json({ url: session.url, sessionId: session.sessionId, provider: provider.name });
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }
    console.error("[billing/checkout] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Checkout failed" }, { status: 500 });
  }
}
