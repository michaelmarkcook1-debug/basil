import { NextResponse } from "next/server";
import { resolveProvider } from "@/lib/billing/provider";
import { isProcessed, markProcessed } from "@/lib/billing/webhook-dedupe";
import { activatePlan, cancelPlan, markPastDue } from "@/lib/billing/entitlement-store";

/**
 * POST /api/webhooks/stripe
 *
 * Billing provider webhook sink. CRITICAL invariants (follow the existing
 * Slack-webhook conventions):
 *   1. Read the RAW request body (req.text()) BEFORE parsing — signature
 *      verification must run over the exact bytes the provider signed.
 *   2. Verify the signature (provider.parseWebhookEvent throws on failure → 400).
 *   3. Be IDEMPOTENT — dedupe by provider event id; providers retry and may
 *      deliver out of order.
 *
 * Until a real provider is wired (resolveProvider() returns the StubProvider),
 * this endpoint verifies nothing meaningful and returns {ignored:true}; the
 * shell is correct so swapping in StripeProvider needs no route changes.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");

  const provider = resolveProvider();

  let envelope;
  try {
    envelope = await provider.parseWebhookEvent(rawBody, signature);
  } catch (err) {
    console.error("[webhooks/stripe] signature verification failed:", err instanceof Error ? err.message : err);
    return new NextResponse("Invalid signature", { status: 400 });
  }

  if (!envelope) {
    return NextResponse.json({ received: true, ignored: true });
  }

  // Idempotency — skip events we've already applied.
  if (await isProcessed(envelope.id)) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  const { event } = envelope;
  try {
    switch (event.type) {
      case "subscription.activated":
        await activatePlan(event.username, event.plan, {
          customerId: event.customerId,
          subscriptionId: event.subscriptionId,
          currentPeriodEnd: event.currentPeriodEnd,
          provider: provider.name,
        });
        break;
      case "subscription.canceled":
        await cancelPlan(event.username);
        break;
      case "payment.failed":
        await markPastDue(event.username);
        break;
    }
    await markProcessed(envelope.id);
    console.info(`[webhooks/stripe] applied ${event.type} for ${event.username} (event ${envelope.id})`);
    return NextResponse.json({ received: true });
  } catch (err) {
    // Return 500 so the provider RETRIES — the event was not applied.
    console.error(`[webhooks/stripe] failed to apply ${event.type}:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to apply event" }, { status: 500 });
  }
}
