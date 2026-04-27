/**
 * Basil event executor.
 *
 * Called by the PATCH /api/events/:id route when a user approves an event.
 * Each EventActionType maps to a real side-effect: sending an email,
 * posting a Slack message, or persisting an internal object.
 *
 * If the integration is unavailable (no auth, missing config) the executor
 * returns { ok: false, error: "..." } — it never throws and never silently
 * marks success.
 */

import type { BasilEvent, EventActionType } from "./types";
import { sendEmail } from "@/lib/google/gmail";
import { sendSlackMessage } from "@/lib/slack/client";
import { createAction } from "@/lib/actions/store";
import { createDecision } from "@/lib/decisions/store";
import { createMemory } from "@/lib/memory/store";

// ── Public types ────────────────────────────────────────────────────────────

export interface ExecutionResult {
  ok: boolean;
  /** Human-readable description of what happened, shown in the approval panel. */
  summary: string;
  /** ID of the ActionItem created (when actionType === "create_action"). */
  actionId?: string;
  /** ID of the Decision created (when actionType === "create_decision"). */
  decisionId?: string;
  /** ID of the Memory created (when actionType === "create_memory"). */
  memoryId?: string;
  /** Generic ID of the created/sent artifact — kept for backward compat.
   *  Mirrors whichever of actionId / decisionId / memoryId was set,
   *  or the Gmail message ID for send_email. */
  createdObjectId?: string;
  /** Populated on failure. */
  error?: string;
}

// ── Action-type derivation ──────────────────────────────────────────────────

/**
 * Infer which action to take from the event when actionType is not set explicitly.
 *
 * Priority order:
 *   1. event.actionType (explicit — set by AI tools or rules engine)
 *   2. draft.channel    (draft events always mean send that draft)
 *   3. "acknowledge"    (notify-only events with no outbound message)
 */
function deriveActionType(event: BasilEvent): EventActionType {
  if (event.actionType) return event.actionType;
  if (event.draft?.channel === "email") return "send_email";
  if (event.draft?.channel === "slack") return "send_slack";
  return "acknowledge";
}

// ── Main executor ───────────────────────────────────────────────────────────

/**
 * Execute an approved event.
 *
 * @param event     The BasilEvent to execute.
 * @param username  The logged-in user approving the event (used for per-user integrations).
 * @param draftBody User-edited body content (may differ from event.draft.body).
 *                  Ignored for non-draft action types.
 */
export async function executeEvent(
  event:     BasilEvent,
  username:  string,
  draftBody?: string
): Promise<ExecutionResult> {
  const actionType = deriveActionType(event);

  // The body to send/store — prefer the user's edited version over the stored draft
  const resolvedBody = (draftBody ?? event.draft?.body ?? "").trim();

  switch (actionType) {
    // ── Outbound email ───────────────────────────────────────────────────────
    case "send_email": {
      if (!event.draft) {
        return {
          ok: false,
          error: "Event has no draft — cannot send email.",
          summary: "",
        };
      }
      const { to, subject } = event.draft;
      if (!to) {
        return {
          ok: false,
          error: "Draft is missing a recipient address.",
          summary: "",
        };
      }
      if (!resolvedBody) {
        return {
          ok: false,
          error: "Email body is empty.",
          summary: "",
        };
      }
      try {
        const result = await sendEmail(username, to, subject ?? "(no subject)", resolvedBody);
        return {
          ok: true,
          summary: `Email sent to ${to}`,
          createdObjectId: result.id,
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          summary: "",
        };
      }
    }

    // ── Outbound Slack message ───────────────────────────────────────────────
    case "send_slack": {
      if (!event.draft) {
        return {
          ok: false,
          error: "Event has no draft — cannot send Slack message.",
          summary: "",
        };
      }
      const { to } = event.draft;
      if (!to) {
        return {
          ok: false,
          error: "Draft is missing a recipient/channel.",
          summary: "",
        };
      }
      if (!resolvedBody) {
        return {
          ok: false,
          error: "Slack message body is empty.",
          summary: "",
        };
      }
      try {
        const result = await sendSlackMessage(username, to, resolvedBody);
        if (!result.ok) {
          return {
            ok: false,
            error: result.error ?? "Slack API returned an error.",
            summary: "",
          };
        }
        return {
          ok: true,
          summary: `Slack message sent to ${to}`,
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          summary: "",
        };
      }
    }

    // ── Create internal ActionItem ───────────────────────────────────────────
    case "create_action": {
      // Use the edited body if non-empty, otherwise fall back to the headline
      const text = resolvedBody || event.headline;
      if (!text) {
        return { ok: false, error: "No text to create action from.", summary: "" };
      }
      try {
        const sourceMap: Record<string, "email" | "slack" | "manual"> = {
          email: "email",
          slack: "slack",
        };
        const action = await createAction({
          text,
          owner: event.entityName ?? "Michael Cook",
          source: sourceMap[event.source] ?? "manual",
          eventId: event.id,
          sourceRef: event.sourceRef,
        });
        return {
          ok: true,
          summary: `Action created: "${text.slice(0, 80)}"`,
          actionId: action.id,
          createdObjectId: action.id,
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          summary: "",
        };
      }
    }

    // ── Create Decision record ───────────────────────────────────────────────
    case "create_decision": {
      const text = resolvedBody || event.headline;
      if (!text) {
        return { ok: false, error: "No text to create decision from.", summary: "" };
      }
      try {
        const decision = await createDecision({
          text,
          decidedBy: event.entityName ?? "Michael Cook",
          context: event.context,
          source: (event.source === "email" || event.source === "slack" || event.source === "manual") ? event.source : "manual",
          eventId: event.id,
          sourceRef: event.sourceRef,
        });
        return {
          ok: true,
          summary: `Decision recorded: "${text.slice(0, 80)}"`,
          decisionId: decision.id,
          createdObjectId: decision.id,
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          summary: "",
        };
      }
    }

    // ── Create Memory fact ───────────────────────────────────────────────────
    case "create_memory": {
      const content = resolvedBody || event.headline;
      if (!content) {
        return { ok: false, error: "No content to store as memory.", summary: "" };
      }
      try {
        const memory = await createMemory(username, {
          kind: "fact",
          content,
          entity: event.entityName,
          source: "inferred",
          eventId: event.id,
          sourceRef: event.sourceRef,
        });
        return {
          ok: true,
          summary: `Memory stored: "${content.slice(0, 80)}"`,
          memoryId: memory.id,
          createdObjectId: memory.id,
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          summary: "",
        };
      }
    }

    // ── Acknowledge / notify-only ────────────────────────────────────────────
    case "acknowledge":
    default:
      // Nothing to execute — the status update itself is the action.
      return { ok: true, summary: "Noted." };
  }
}
