import { NextResponse } from "next/server";
import { graphGet } from "@/lib/microsoft/auth";
import { getWatchState } from "@/lib/microsoft/watch-state";
import { createEvent, hasExternalId } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";

/**
 * POST /api/webhooks/microsoft/calendar — Microsoft Graph push notification
 * handler for Outlook calendar change notifications.
 *
 * MS Graph notification protocol:
 *  1. On subscription validation: POST ?validationToken=XXXXXXXX
 *     — must respond 200 with Content-Type: text/plain, body = validationToken.
 *  2. On change: POST with JSON body { "value": [{ subscriptionId, changeType,
 *     clientState, resource, resourceData: { id } }] }
 *
 * Security: clientState from each notification is verified against the stored
 * WatchState.calendar.clientState.
 *
 * Always returns 200 (MS Graph requires 200, not 202).
 */
export async function POST(req: Request) {
  // ── Subscription validation handshake ────────────────────────────────────
  const urlParams = new URL(req.url).searchParams;
  const validationToken = urlParams.get("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // ── Change notification ───────────────────────────────────────────────────
  const body = (await req.json().catch(() => null)) as GraphNotificationEnvelope | null;
  if (!body?.value?.length) {
    return NextResponse.json({ ok: true });
  }

  const state = await getWatchState();
  const expectedClientState = state.calendar?.clientState;

  for (const notification of body.value) {
    // Verify clientState to prevent spoofed notifications
    if (expectedClientState && notification.clientState !== expectedClientState) {
      console.error(
        "[ms-calendar-webhook] clientState mismatch — ignoring notification",
        { subscriptionId: notification.subscriptionId }
      );
      continue;
    }

    const eventId = notification.resourceData?.id;
    if (!eventId) continue;

    const externalId = `outlook-cal:${eventId}`;

    try {
      // Skip if already ingested
      if (await hasExternalId(externalId)) continue;

      const ev = await graphGet<GraphCalendarEvent>(
        `/me/events/${eventId}?$select=id,subject,start,end,attendees,isOnlineMeeting,organizer`
      );
      if (!ev) continue;

      const attendeeNames = (ev.attendees || [])
        .map((a) => a.emailAddress?.name)
        .filter(Boolean)
        .join(", ");

      const from = ev.organizer?.emailAddress?.name || "Unknown";

      const shaped = eventFromIngest({
        source: "calendar",
        externalId,
        title: ev.subject || "(no subject)",
        body: `${ev.start?.dateTime ?? ""} — ${attendeeNames}`,
        from,
        date: ev.start?.dateTime,
      });
      const createdEvent = await createEvent(shaped);
      publish(createdEvent);
    } catch (e) {
      console.error(
        "[ms-calendar-webhook] failed to process notification:",
        e instanceof Error ? e.message : e
      );
    }
  }

  // MS Graph requires 200 (not 202) to acknowledge delivery
  return NextResponse.json({ ok: true });
}

// ── Graph response shapes (internal) ─────────────────────────────────────────

interface GraphNotificationEnvelope {
  value: Array<{
    subscriptionId: string;
    changeType: string;
    clientState: string;
    resource: string;
    resourceData?: {
      id?: string;
    };
  }>;
}

interface GraphCalendarEvent {
  id: string;
  subject: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  attendees?: Array<{
    emailAddress?: { name?: string; address?: string };
    type?: string;
  }>;
  organizer?: {
    emailAddress?: { name?: string; address?: string };
  };
  isOnlineMeeting: boolean;
}
