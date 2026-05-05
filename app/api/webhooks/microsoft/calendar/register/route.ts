import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { graphFetch } from "@/lib/microsoft/auth";
import { updateCalendar } from "@/lib/microsoft/watch-state";
import { verifySession, getSessionUser } from "@/lib/auth";

/**
 * POST /api/webhooks/microsoft/calendar/register — creates/renews an MS Graph
 * calendar change notification subscription.
 *
 * Also exposed as GET for easy manual trigger (with session auth).
 *
 * Requires env:
 *   MICROSOFT_CALENDAR_WEBHOOK_URL  — public HTTPS URL for this notification endpoint
 *   MICROSOFT_WEBHOOK_SECRET        — clientState secret (fallback: auto-generated UUID)
 *
 * Subscription expires in 3 days — renew via the cron job before expiry.
 */
export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request): Promise<Response> {
  if (!(await verifySession())) {
    return new NextResponse("forbidden", { status: 403 });
  }
  const username = await getSessionUser();
  if (!username) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const notificationUrl = process.env.MICROSOFT_CALENDAR_WEBHOOK_URL;
  if (!notificationUrl) {
    return NextResponse.json(
      { error: "MICROSOFT_CALENDAR_WEBHOOK_URL not configured" },
      { status: 400 }
    );
  }

  const clientState = process.env.MICROSOFT_WEBHOOK_SECRET || randomUUID();
  const expirationDateTime = new Date(Date.now() + 3 * 86400_000).toISOString();

  try {
    const res = await graphFetch(
      username,
      "https://graph.microsoft.com/v1.0/subscriptions",
      {
        method: "POST",
        body: JSON.stringify({
          changeType: "created,updated",
          notificationUrl,
          resource: "/me/events",
          expirationDateTime,
          clientState,
        }),
      }
    );

    if (!res) {
      return NextResponse.json(
        { error: "Microsoft not connected" },
        { status: 400 }
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[ms-calendar-register] Graph subscription POST HTTP ${res.status}: ${text.slice(0, 200)}`
      );
      return NextResponse.json(
        { error: `Graph API error ${res.status}`, detail: text.slice(0, 200) },
        { status: 500 }
      );
    }

    const data = await res.json() as GraphSubscriptionResponse;

    await updateCalendar(username, {
      subscriptionId: data.id,
      expirationDateTime: data.expirationDateTime,
      resource: data.resource,
      clientState,
    });

    return NextResponse.json({
      ok: true,
      subscriptionId: data.id,
      expiresAt: data.expirationDateTime,
      resource: data.resource,
    });
  } catch (e) {
    console.error(
      "[ms-calendar-register] failed to create subscription:",
      e instanceof Error ? e.message : e
    );
    return NextResponse.json(
      { error: "Registration failed" },
      { status: 500 }
    );
  }
}

// ── Graph response shape (internal) ──────────────────────────────────────────

interface GraphSubscriptionResponse {
  id: string;
  resource: string;
  expirationDateTime: string;
  clientState: string;
  changeType: string;
}
