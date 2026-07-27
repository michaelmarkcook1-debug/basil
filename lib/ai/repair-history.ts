import "server-only";

import type { UIMessage } from "ai";

/**
 * lib/ai/repair-history.ts
 *
 * Repair conversations that a failed tool call would otherwise BRICK.
 *
 * THE BUG THIS FIXES
 * Every provider requires each `tool_use` block to be answered by a matching
 * `tool_result`. If a tool call starts and never finishes — the function times
 * out, the stream is severed, the client navigates away mid-flight — the
 * assistant message is persisted with a tool part stuck in `input-available`
 * and no output.
 *
 * That orphan is then replayed on EVERY subsequent turn, because useChat resends
 * the whole history. The provider rejects the request outright:
 *
 *   "Tool result is missing for tool call toolu_01GZHWFT4vP7rgkchuJ2f3JT"
 *
 * So a single transient tool failure does not cost you one reply — it
 * permanently bricks the entire conversation. Nothing the user types will ever
 * work again in that thread, and the only escape is starting a new chat, which
 * throws away the context they were building.
 *
 * THE REPAIR
 * Orphans are converted to a terminal `output-error` part. That restores the
 * pairing the provider demands AND is honest with the model: it can see the tool
 * failed and say so, rather than the call vanishing and leaving it to invent
 * what happened.
 *
 * `approval-requested` is deliberately left alone — that is a LEGITIMATE pending
 * state in this app's tool-approval flow, and messages awaiting approval are
 * resent on purpose. Erroring those out would break approvals entirely.
 */

/** Tool-part states that are already settled — a result exists. */
const TERMINAL_STATES = new Set(["output-available", "output-error", "output-denied"]);
/** Pending by design — the approval round-trip owns these. Do not touch. */
const AWAITING_USER_STATES = new Set(["approval-requested"]);

interface LooseToolPart {
  type: string;
  state?: string;
  errorText?: string;
  output?: unknown;
  [k: string]: unknown;
}

function isToolPart(part: unknown): part is LooseToolPart {
  if (!part || typeof part !== "object") return false;
  const t = (part as { type?: unknown }).type;
  return typeof t === "string" && (t.startsWith("tool-") || t === "dynamic-tool");
}

/**
 * Convert orphaned tool calls into terminal error results.
 *
 * @returns the repaired messages plus a count, so the caller can log that a
 *          conversation needed rescuing (silence here would hide a real
 *          reliability problem behind a working chat).
 */
export function repairOrphanedToolCalls(
  messages: UIMessage[]
): { messages: UIMessage[]; repaired: number } {
  let repaired = 0;

  const out = messages.map((message) => {
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return message;

    let touched = false;
    const nextParts = parts.map((part) => {
      if (!isToolPart(part)) return part;
      const state = typeof part.state === "string" ? part.state : "";
      if (TERMINAL_STATES.has(state) || AWAITING_USER_STATES.has(state)) return part;

      // input-streaming / input-available / anything unrecognised: the call was
      // issued but never answered.
      touched = true;
      repaired++;
      return {
        ...part,
        state: "output-error",
        errorText:
          "This tool call did not complete (the request was interrupted). No result was recorded.",
      };
    });

    return touched ? ({ ...message, parts: nextParts } as UIMessage) : message;
  });

  return { messages: out, repaired };
}
