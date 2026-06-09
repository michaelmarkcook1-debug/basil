/**
 * lib/billing/provider.ts — payment provider behind an interface.
 *
 * The app talks to billing only through BillingProvider, so the real provider
 * (Stripe, or a merchant-of-record like Paddle/LemonSqueezy) can be wired in
 * later by implementing this interface and supplying env secrets — without
 * touching the checkout route, webhook handler, paywall, or entitlement store.
 *
 * Until a provider is configured, resolveProvider() returns the StubProvider,
 * which simulates an upgrade locally so the entire flow is testable with NO
 * live keys (createCheckoutSession applies a trial/upgrade and returns the
 * success URL directly).
 *
 * server-only.
 */

import "server-only";
import type { Plan } from "./plans";
import { activatePlan, startTrial } from "./entitlement-store";

/** Normalised webhook event the app understands (provider-agnostic). */
export type BillingWebhookEvent =
  | { type: "subscription.activated"; username: string; plan: Plan; customerId?: string; subscriptionId?: string; currentPeriodEnd?: string }
  | { type: "subscription.canceled"; username: string }
  | { type: "payment.failed"; username: string };

export interface CheckoutSession {
  url: string;
  sessionId: string;
}

/** A verified webhook event plus its provider event id (for idempotent dedupe). */
export interface BillingWebhookEnvelope {
  /** Stable provider event id — used to ignore retried / duplicate deliveries. */
  id: string;
  event: BillingWebhookEvent;
}

export interface BillingProvider {
  readonly name: "stub" | "stripe";
  /** Begin checkout for a plan; returns a URL to redirect the user to. */
  createCheckoutSession(input: {
    username: string;
    plan: Plan;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession>;
  /**
   * Verify a raw webhook body + signature and normalise it. Returns null when
   * the event is irrelevant. THROWS on signature-verification failure so the
   * route returns 400 (never trust an unverified body).
   */
  parseWebhookEvent(rawBody: string, signature: string | null): Promise<BillingWebhookEnvelope | null>;
}

// ── Stub provider (no live keys) ────────────────────────────────────────────────

class StubProvider implements BillingProvider {
  readonly name = "stub" as const;

  async createCheckoutSession(input: {
    username: string;
    plan: Plan;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession> {
    // No real payment page exists — simulate the upgrade immediately so the
    // end-to-end flow (button → entitlement change → UI) is exercisable.
    if (input.plan === "pro") {
      await startTrial(input.username).catch(async () => {
        await activatePlan(input.username, "pro", { provider: "stub" });
      });
    }
    return { url: input.successUrl, sessionId: `stub_${input.username}_${input.plan}` };
  }

  async parseWebhookEvent(): Promise<BillingWebhookEnvelope | null> {
    // Stub provider never sends webhooks.
    return null;
  }
}

// ── Provider resolution ─────────────────────────────────────────────────────────

let cached: BillingProvider | undefined;

/**
 * Returns the active provider. When STRIPE_SECRET_KEY (and webhook secret) are
 * configured, a real Stripe provider should be returned here — that adapter is
 * intentionally NOT implemented yet (owner must provision the account + price
 * IDs + keys first). Until then, the StubProvider drives the flow locally.
 */
export function resolveProvider(): BillingProvider {
  if (cached) return cached;
  // Placeholder for the real provider — kept explicit so it's obvious where it
  // plugs in. Implement StripeProvider and return it when these are present.
  // if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
  //   cached = new StripeProvider();
  //   return cached;
  // }
  cached = new StubProvider();
  return cached;
}

/** True when a real (non-stub) payment provider is wired in. */
export function isLiveBilling(): boolean {
  return resolveProvider().name !== "stub";
}
