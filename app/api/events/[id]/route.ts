import { NextResponse } from "next/server";
import { deleteEvent, getEvent, updateEvent, updateEventStatus } from "@/lib/events/store";
import { executeEvent } from "@/lib/events/executor";
import { createAction } from "@/lib/actions/store";
import { getSessionUser } from "@/lib/auth";
import type { EventStatus } from "@/lib/events/types";
import type { ActionItem } from "@/lib/types/action";

/** Map BasilEvent source → ActionItem source (best-fit) */
function toActionSource(evSource: string): ActionItem["source"] {
  switch (evSource) {
    case "email":      return "email";
    case "slack":      return "slack";
    case "calendar":
    case "zoom_email": return "meeting";
    case "manual":     return "manual";
    default:           return "manual";
  }
}

/**
 * PATCH /api/events/:id
 *
 * Body:
 *   { status: EventStatus, draftBody?: string }
 *
 * When status === "approved" the executor runs the underlying action:
 *   - sends the email / Slack message, OR
 *   - creates the action / decision / memory, OR
 *   - acknowledges a notify-only event.
 *
 * Terminal statuses after execution: "executed" (success) or "failed" (error).
 * "approved" is never stored as a permanent state — it was the old, fake behaviour.
 *
 * Non-approval statuses (rejected, acknowledged) just update the status with
 * no side-effects.
 *
 * Response on approval:
 *   { event: BasilEvent, execution: ExecutionResult }
 *
 * Response on reject/acknowledge:
 *   { event: BasilEvent }
 *
 * DELETE /api/events/:id — remove the event entirely.
 */

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as {
    status?: EventStatus;
    draftBody?: string;
  };

  if (!body.status) {
    return NextResponse.json({ error: "status required" }, { status: 400 });
  }

  // ── Non-approval statuses ─────────────────────────────────────────────────
  // rejected / acknowledged just flip the status — nothing executes.
  if (body.status !== "approved") {
    const event = await updateEventStatus(id, body.status);
    if (!event) {
      console.error(`[events/${id}] PATCH status=${body.status}: event not found`);
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // When a notify alert is acknowledged, log a completed action as a receipt so
    // the user has a permanent record that they reviewed the alert.
    if (body.status === "acknowledged" && event.disposition === "notify") {
      // username may be null here (status update path), resolve it best-effort
      const ackUsername = await getSessionUser();
      if (ackUsername) {
        void createAction(ackUsername, {
          text: `Reviewed: ${event.headline}`,
          source: toActionSource(event.source),
          eventId: event.id,
          sourceRef: event.sourceRef ?? event.externalId,
          status: "done",
          confidence: 1.0,
        });
      }
    }

    return NextResponse.json({ event });
  }

  // ── Approval: load → mark executing → run → persist result ───────────────
  const event = await getEvent(id);
  if (!event) {
    console.error(`[events/${id}] PATCH approve: event not found`);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Immediately mark as executing so the UI can show a spinner.
  await updateEvent(id, { status: "executing" });

  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const executedAt = new Date().toISOString();
  const result = await executeEvent(event, username, body.draftBody);

  if (!result.ok) {
    console.error(
      `[events/${id}] execution failed — actionType=${event.actionType ?? "derived"} error=${result.error}`
    );
  }

  const updatedEvent = await updateEvent(id, {
    status: result.ok ? "executed" : "failed",
    executedAt,
    executionResult: result.ok ? result.summary : undefined,
    executionError: result.ok ? undefined : result.error,
    // Generic fallback (backward compat)
    createdObjectId: result.createdObjectId,
    // Typed links — only set when the result populated them
    ...(result.actionId   ? { actionId:   result.actionId   } : {}),
    ...(result.decisionId ? { decisionId: result.decisionId } : {}),
    ...(result.memoryId   ? { memoryId:   result.memoryId   } : {}),
  });

  if (!updatedEvent) {
    // Race: event was deleted between the getEvent and updateEvent calls
    console.error(`[events/${id}] PATCH approve: event vanished before result could be persisted`);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ event: updatedEvent, execution: result });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const ok = await deleteEvent(id);
  if (!ok) {
    console.error(`[events/${id}] DELETE: event not found`);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
