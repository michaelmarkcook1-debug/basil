// Audit trail for tools that *mutate* state — email drafts, calendar events,
// Slack sends, memory changes. Each successful execution writes an `auto`
// BasilEvent with status `executed` so the Approval Panel's "Handled" view
// has a unified record across chat HITL and Schedule-page flows.
//
// Kept separate from lib/events/store.ts so callers don't need to stitch
// together createEvent + publish every time.

import type { EventSource, BasilEvent } from "./types";
import { createEvent } from "./store";
import { publish } from "./bus";

export interface AuditInput {
  username: string;
  source: EventSource;
  headline: string;
  context: string;
  rationale: string;
  entityName?: string;
  tags?: string[];
}

/** Emit a "Basil already did this" audit record. Non-fatal — failures are
 *  swallowed and logged so a broken audit write never rolls back a real
 *  side effect the user approved. */
export async function emitAuditEvent(input: AuditInput): Promise<BasilEvent | null> {
  try {
    const event = await createEvent(input.username, {
      source: input.source,
      headline: input.headline,
      context: input.context,
      rationale: input.rationale,
      entityName: input.entityName,
      disposition: "auto",
      priority: "normal",
      status: "executed",
      tags: input.tags ?? [],
    });
    publish(event);
    return event;
  } catch (err) {
    console.error("emitAuditEvent failed:", err);
    return null;
  }
}
