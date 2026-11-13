// Audit trail for tools that *mutate* state — email drafts, calendar events,
// Slack sends, memory changes. Each successful execution writes an `auto`
// BasilEvent with status `executed` so the Approval Panel's "Handled" view
// has a unified record across chat HITL and Schedule-page flows.
//
// Kept separate from lib/events/store.ts so callers don't need to stitch
// together createEvent + publish every time.

import type { EventSource, BasilEvent } from "./types";
import { createEvent, createEventIfNew } from "./store";
import { publish } from "./bus";

export interface AuditInput {
  username: string;
  source: EventSource;
  headline: string;
  context: string;
  rationale: string;
  entityName?: string;
  tags?: string[];
  /**
   * Stable id of what caused this record (e.g. a webhook delivery id). Stored
   * as the event's externalId/sourceRef, so hasExternalId() recognises a
   * repeat — and a repeat that races this one writes nothing.
   */
  externalId?: string;
}

/** Emit a "Basil already did this" audit record. Non-fatal — failures are
 *  swallowed and logged so a broken audit write never rolls back a real
 *  side effect the user approved. With an externalId already on record,
 *  nothing new is written and the existing record is returned. */
export async function emitAuditEvent(input: AuditInput): Promise<BasilEvent | null> {
  try {
    const record = {
      source: input.source,
      headline: input.headline,
      context: input.context,
      rationale: input.rationale,
      entityName: input.entityName,
      disposition: "auto" as const,
      priority: "normal" as const,
      status: "executed" as const,
      tags: input.tags ?? [],
    };
    if (input.externalId) {
      const { created, event } = await createEventIfNew(input.username, { ...record, externalId: input.externalId });
      if (created) publish(event);
      return event;
    }
    const event = await createEvent(input.username, record);
    publish(event);
    return event;
  } catch (err) {
    console.error("emitAuditEvent failed:", err);
    return null;
  }
}
