import { NextResponse } from "next/server";
import { graphGet } from "@/lib/microsoft/auth";
import { getWatchState } from "@/lib/microsoft/watch-state";
import { createEvent, hasExternalId } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import { resolveMicrosoftSubscriptionUser } from "@/lib/webhooks/resolve-user";
import { writeDeadLetter } from "@/lib/webhooks/dead-letter";
import { start } from "workflow/api";
import { ingestMicrosoftMailWorkflow } from "@/lib/jobs/workflows/ingest-microsoft-mail";
import { createJobRecord } from "@/lib/jobs/store";

/**
 * POST /api/webhooks/microsoft/mail — Microsoft Graph push notification handler
 * for Outlook mail change notifications.
 *
 * MS Graph notification protocol:
 *  1. On subscription validation: POST ?validationToken=XXXXXXXX
 *     — must respond 200 with Content-Type: text/plain, body = validationToken.
 *  2. On change: POST with JSON body { "value": [{ subscriptionId, changeType,
 *     clientState, resource, resourceData: { id } }] }
 *
 * Security: clientState from each notification is verified against the stored
 * WatchState.mail.clientState.
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
  const body = (await req.json().catch(() => null)) as GraphNotificationEnvelope | null; // ci-ok: malformed webhook body returns null, empty check handles it
  if (!body?.value?.length) {
    return NextResponse.json({ ok: true });
  }

  for (const notification of body.value) {
    // Resolve owning user from the subscription ID in this notification.
    const webhookUsername = await resolveMicrosoftSubscriptionUser(notification.subscriptionId, "mail");
    if (!webhookUsername) {
      await writeDeadLetter("ms-mail", notification, `No user found for subscriptionId: ${notification.subscriptionId}`);
      continue;
    }

    const state = await getWatchState(webhookUsername);
    const expectedClientState = state.mail?.clientState;

    // Verify clientState to prevent spoofed notifications. Fail closed: a
    // missing stored clientState means we can't authenticate this notification,
    // so reject it rather than process an unverifiable event.
    if (!expectedClientState || notification.clientState !== expectedClientState) {
      console.error(
        "[ms-mail-webhook] clientState missing or mismatch — ignoring notification",
        { subscriptionId: notification.subscriptionId, user: webhookUsername }
      );
      continue;
    }

    const msgId = notification.resourceData?.id;
    if (!msgId) continue;

    const externalId = `outlook:${msgId}`;

    try {
      // Skip if already ingested (e.g. poll-ingest ran first)
      if (await hasExternalId(webhookUsername, externalId)) continue;

      const msg = await graphGet<GraphMailMessage>(
        webhookUsername,
        `/me/messages/${msgId}?$select=id,subject,from,bodyPreview,receivedDateTime,isRead`
      );
      if (!msg) continue;

      const from = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown";
      const shaped = eventFromIngest({
        source: "email",
        externalId,
        title: msg.subject || "(no subject)",
        body: msg.bodyPreview || "",
        from,
        date: msg.receivedDateTime,
      });
      const event = await createEvent(webhookUsername, shaped);
      publish(event);

      void createJobRecord(webhookUsername, "ingest.microsoft.mail", externalId);
      await start(ingestMicrosoftMailWorkflow, [
        webhookUsername,
        {
          messageId: msgId,
          externalId,
          eventId: event.id,
          subject: msg.subject || "(no subject)",
          from,
          snippetFallback: msg.bodyPreview || "",
        },
      ]);
    } catch (e) {
      console.error(
        "[ms-mail-webhook] failed to process notification:",
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

interface GraphMailMessage {
  id: string;
  subject: string;
  from?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  bodyPreview: string;
  receivedDateTime: string;
  isRead: boolean;
}
