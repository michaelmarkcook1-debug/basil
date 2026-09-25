/**
 * lib/chat/receipts.ts — what a tool call actually came to, and how to show it.
 *
 * Dependency-free so the page (client) and the store (server) share one
 * vocabulary. The live audit's L2: a draft the user DENIED reopened from
 * History as "draft Email ✓". Three things conspired — the store refused
 * updates to an existing message id, the save kept only the first text part,
 * and restore mapped every non-denied state to success. This module owns the
 * mapping so it cannot drift between save and restore again.
 */

/** The only outcomes that exist. A receipt without one is `unknown`. */
export type ToolOutcome = "success" | "denied" | "failed" | "pending" | "unknown";

/** Final AI-SDK part state → outcome. Anything unfinished is pending, never success. */
export function outcomeFromState(state: string | undefined): ToolOutcome {
  switch (state) {
    case "output-available": return "success";
    case "output-denied": return "denied";
    case "output-error": return "failed";
    case "approval-requested":
    case "approval-responded":
    case "input-streaming":
    case "input-available":
      return "pending";
    default:
      return "unknown";
  }
}

/**
 * Outcome → the part state a RESTORED message carries. Archived pending and
 * unknown receipts get states of their own so the live renderer can never
 * mistake them for an approval request: nothing restored from history is
 * executable, and nothing unfinished reads as done.
 */
export function stateFromOutcome(outcome: ToolOutcome): string {
  switch (outcome) {
    case "success": return "output-available";
    case "denied": return "output-denied";
    case "failed": return "output-error";
    case "pending": return "archived-pending";
    case "unknown": return "archived-unknown";
  }
}

/** Approve/Deny controls render for a LIVE request only — never an archived one. */
export function shouldRenderApproval(part: { type?: unknown; state?: unknown }): boolean {
  return typeof part.type === "string" && part.type.startsWith("tool-") && part.state === "approval-requested";
}

export interface StoredToolReceipt {
  toolName: string;
  /** Raw part state at save time — kept for diagnosis; `outcome` is what is trusted. */
  state: string;
  outcome: ToolOutcome;
  input?: unknown;
}

export interface StoredMessageShape {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolReceipts?: StoredToolReceipt[];
}

type UIPart = { type: string; text?: string; state?: string; input?: unknown };
type UIMessageShape = { id: string; role: string; parts?: ReadonlyArray<UIPart> };

const MAX_INPUT_JSON = 1000;

/**
 * A live UI message → the archived form. Every text part is kept (a denial
 * acknowledgement is usually the SECOND text part of a multi-step turn), and
 * every tool part becomes a receipt with an explicit outcome.
 */
export function toStoredMessage(m: UIMessageShape, now: () => string = () => new Date().toISOString()): StoredMessageShape | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  const parts = m.parts ?? [];
  const content = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text as string).trim())
    .filter(Boolean)
    .join("\n\n");
  const toolReceipts: StoredToolReceipt[] = parts
    .filter((p) => typeof p.type === "string" && p.type.startsWith("tool-"))
    .map((p) => {
      const state = typeof p.state === "string" ? p.state : "unknown";
      const json = JSON.stringify(p.input ?? {});
      return {
        toolName: p.type.replace("tool-", ""),
        state,
        outcome: outcomeFromState(state),
        input: json.length > MAX_INPUT_JSON ? { truncated: true } : p.input,
      };
    });
  if (!content && toolReceipts.length === 0) return null;
  return {
    id: m.id,
    role: m.role,
    content,
    createdAt: now(),
    ...(toolReceipts.length > 0 ? { toolReceipts } : {}),
  };
}

/**
 * An archived message → a UI message. Receipts saved before `outcome` existed
 * are derived from their raw state — correctly this time.
 */
export function toUIMessage(m: StoredMessageShape): { id: string; role: "user" | "assistant"; parts: UIPart[]; content: string; createdAt: Date } {
  const parts: UIPart[] = [];
  if (m.content) parts.push({ type: "text", text: m.content });
  for (const r of m.toolReceipts ?? []) {
    const outcome: ToolOutcome = r.outcome ?? outcomeFromState(r.state);
    parts.push({ type: `tool-${r.toolName}`, state: stateFromOutcome(outcome), input: r.input });
  }
  return { id: m.id, role: m.role, parts, content: m.content, createdAt: new Date(m.createdAt) };
}

/** Copy for a receipt row. Distinct words for distinct outcomes — a tick means done and only done. */
export function receiptLabel(state: string | undefined): { label: string; tone: "done" | "denied" | "failed" | "pending" | "unknown" } {
  switch (state) {
    case "output-available": return { label: "✓", tone: "done" };
    case "output-denied": return { label: "denied", tone: "denied" };
    case "output-error": return { label: "failed", tone: "failed" };
    case "archived-pending": return { label: "not completed", tone: "pending" };
    case "archived-unknown": return { label: "outcome unknown", tone: "unknown" };
    default: return { label: "", tone: "pending" };
  }
}
