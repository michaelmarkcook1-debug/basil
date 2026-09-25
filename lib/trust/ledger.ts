/**
 * lib/trust/ledger.ts — the record of how the user has treated Basil's requests.
 *
 * Until 2026-09-25 every approval and denial vanished the moment it happened:
 * the SDK routed the decision to the tool and nothing wrote it down. That left
 * trust permanently binary — ten tools asked every time, forever, with no way
 * to notice that the user had said yes to `addAction` forty times running.
 *
 * The ledger keeps three things, per user:
 *   entries      — one row per decision (approved / denied / auto), with edit
 *                  distance when the user changed a draft before approving
 *   delegations  — tools the user has let Basil run without asking
 *   seen         — refs already recorded, so a resent chat history (the whole
 *                  thread comes back on every turn) is not double-counted
 *
 * Delegation is offered, never assumed: only REVERSIBLE tools qualify, only
 * after a streak of approvals, and every delegated run is still recorded as
 * `auto` so it shows in "Basil this morning" and can be revoked on the
 * learning page. Outward-facing tools (mail, Slack, calendar invites) and
 * destructive ones (remove, forget) never qualify.
 */

import { randomUUID } from "node:crypto";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";

export type TrustDecision = "approved" | "denied" | "auto";

export interface TrustEntry {
  id: string;
  tool: string;
  decision: TrustDecision;
  at: string;
  source: "chat" | "event";
  /** Idempotency key — a toolCallId or event id. */
  ref?: string;
  /** The user changed the draft before approving. */
  edited?: boolean;
  /** Normalised Levenshtein distance between Basil's draft and what was sent, 0–1. */
  editDistance?: number;
}

export interface Delegation {
  tool: string;
  since: string;
}

export interface TrustLedger {
  entries: TrustEntry[];
  delegations: Delegation[];
  seen: string[];
}

const FILE = "sage-trust.json";
const MAX_ENTRIES = 1000;
const MAX_SEEN = 2000;
export const EMPTY_LEDGER: TrustLedger = { entries: [], delegations: [], seen: [] };

/** Tools whose effect the user can undo with one click. Only these may be delegated. */
export const REVERSIBLE_TOOLS: ReadonlySet<string> = new Set([
  "addAction", "completeAction", "logDecision", "supersedeDecision",
]);

/** Consecutive approvals before Basil offers to stop asking. */
export const DELEGATION_MIN_STREAK = 10;

function normalize(l: Partial<TrustLedger> | null | undefined): TrustLedger {
  return { entries: l?.entries ?? [], delegations: l?.delegations ?? [], seen: l?.seen ?? [] };
}

export async function getLedger(username: string): Promise<TrustLedger> {
  return normalize(await readUserStore<TrustLedger>(username, FILE, EMPTY_LEDGER));
}

export interface DecisionInput {
  tool: string;
  decision: TrustDecision;
  source: "chat" | "event";
  ref?: string;
  edited?: boolean;
  editDistance?: number;
}

/** Record one decision. Returns false when `ref` was already recorded. */
export async function recordDecision(username: string, input: DecisionInput): Promise<boolean> {
  let recorded = false;
  await updateUserStore<TrustLedger>(
    username,
    FILE,
    (cur) => {
      const l = normalize(cur);
      if (input.ref && l.seen.includes(input.ref)) return l;
      recorded = true;
      const entry: TrustEntry = {
        id: randomUUID(),
        tool: input.tool,
        decision: input.decision,
        source: input.source,
        at: new Date().toISOString(),
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.edited !== undefined ? { edited: input.edited } : {}),
        ...(input.editDistance !== undefined ? { editDistance: input.editDistance } : {}),
      };
      const entries = [...l.entries, entry];
      const seen = input.ref ? [...l.seen, input.ref] : l.seen;
      return {
        entries: entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries,
        delegations: l.delegations,
        seen: seen.length > MAX_SEEN ? seen.slice(seen.length - MAX_SEEN) : seen,
      };
    },
    EMPTY_LEDGER,
    { allowShrink: true },
  );
  return recorded;
}

type PartLike = Record<string, unknown> & { type?: unknown };
type MessageLike = { parts?: ReadonlyArray<PartLike> | null };

/**
 * Harvest approve/deny decisions from a chat history. The client answers an
 * approval by setting the tool part's state to "approval-responded" with
 * `approval: { id, approved }`; the whole history is resent on every turn, so
 * each toolCallId is recorded at most once.
 */
export async function recordApprovalResponses(
  username: string,
  messages: ReadonlyArray<MessageLike>,
): Promise<number> {
  let n = 0;
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (typeof p.type !== "string" || !p.type.startsWith("tool-")) continue;
      if (p.state !== "approval-responded") continue;
      const approval = p.approval as { approved?: unknown } | undefined;
      if (typeof approval?.approved !== "boolean") continue;
      const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : undefined;
      if (!toolCallId) continue;
      try {
        const ok = await recordDecision(username, {
          tool: p.type.slice("tool-".length),
          decision: approval.approved ? "approved" : "denied",
          source: "chat",
          ref: `chat:${toolCallId}`,
        });
        if (ok) n += 1;
      } catch (err) {
        console.error("[trust] could not record approval response:", err instanceof Error ? err.message : err);
      }
    }
  }
  return n;
}

type StepLike = { content?: ReadonlyArray<{ type?: unknown; toolName?: unknown; toolCallId?: unknown }> | null };

/** Every run of a delegated tool is written down as `auto` — a receipt, not silence. */
export async function recordDelegatedRuns(
  username: string,
  steps: ReadonlyArray<StepLike>,
  delegated: ReadonlySet<string>,
): Promise<number> {
  if (delegated.size === 0) return 0;
  let n = 0;
  for (const st of steps) {
    for (const part of st.content ?? []) {
      if (part.type !== "tool-result" || typeof part.toolName !== "string") continue;
      if (!delegated.has(part.toolName)) continue;
      const ref = typeof part.toolCallId === "string" ? `auto:${part.toolCallId}` : undefined;
      try {
        if (await recordDecision(username, { tool: part.toolName, decision: "auto", source: "chat", ref })) n += 1;
      } catch (err) {
        console.error("[trust] could not record delegated run:", err instanceof Error ? err.message : err);
      }
    }
  }
  return n;
}

export async function getDelegations(username: string): Promise<ReadonlySet<string>> {
  const l = await getLedger(username);
  return new Set(l.delegations.map((d) => d.tool));
}

/** Turn delegation on or off for a tool. Only reversible tools may be delegated. */
export async function setDelegation(username: string, tool: string, on: boolean): Promise<Delegation[]> {
  if (on && !REVERSIBLE_TOOLS.has(tool)) {
    throw new Error(`${tool} cannot be delegated — its effect is not reversible`);
  }
  const next = await updateUserStore<TrustLedger>(
    username,
    FILE,
    (cur) => {
      const l = normalize(cur);
      const others = l.delegations.filter((d) => d.tool !== tool);
      return {
        ...l,
        delegations: on ? [...others, { tool, since: new Date().toISOString() }] : others,
      };
    },
    EMPTY_LEDGER,
    { allowShrink: true },
  );
  return normalize(next).delegations;
}

// ── Reading the ledger ────────────────────────────────────────────────────────

export interface ToolTrust {
  tool: string;
  approved: number;
  denied: number;
  auto: number;
  edited: number;
  meanEditDistance: number | null;
  /** Consecutive approvals, most recent first, ignoring delegated runs. */
  streak: number;
  reversible: boolean;
  delegated: boolean;
  /** Basil should offer to stop asking. */
  offer: boolean;
}

export function summarize(ledger: TrustLedger): Record<string, ToolTrust> {
  const delegated = new Set(ledger.delegations.map((d) => d.tool));
  const out: Record<string, ToolTrust> = {};
  for (const e of ledger.entries) {
    const t = (out[e.tool] ??= {
      tool: e.tool, approved: 0, denied: 0, auto: 0, edited: 0, meanEditDistance: null,
      streak: 0, reversible: REVERSIBLE_TOOLS.has(e.tool), delegated: delegated.has(e.tool), offer: false,
    });
    if (e.decision === "approved") t.approved += 1;
    else if (e.decision === "denied") t.denied += 1;
    else t.auto += 1;
    if (e.edited) t.edited += 1;
  }
  for (const tool of delegated) {
    out[tool] ??= { tool, approved: 0, denied: 0, auto: 0, edited: 0, meanEditDistance: null, streak: 0, reversible: REVERSIBLE_TOOLS.has(tool), delegated: true, offer: false };
  }
  for (const t of Object.values(out)) {
    const dists = ledger.entries.filter((e) => e.tool === t.tool && typeof e.editDistance === "number").map((e) => e.editDistance as number);
    t.meanEditDistance = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : null;
    let streak = 0;
    for (let i = ledger.entries.length - 1; i >= 0; i--) {
      const e = ledger.entries[i];
      if (e.tool !== t.tool || e.decision === "auto") continue;
      if (e.decision === "approved") streak += 1; else break;
    }
    t.streak = streak;
    t.offer = t.reversible && !t.delegated && streak >= DELEGATION_MIN_STREAK;
  }
  return out;
}

export interface TrustMonth {
  month: string;
  approved: number;
  denied: number;
  auto: number;
  approvalRate: number | null;
  edits: number;
  meanEditDistance: number | null;
}

/** Month-by-month, oldest first — the "Month 1 vs Month 6" the relationship needs. */
export function monthly(ledger: TrustLedger, months = 6): TrustMonth[] {
  const by = new Map<string, TrustMonth>();
  const dists = new Map<string, number[]>();
  for (const e of ledger.entries) {
    const month = e.at.slice(0, 7);
    const m = by.get(month) ?? { month, approved: 0, denied: 0, auto: 0, approvalRate: null, edits: 0, meanEditDistance: null };
    if (e.decision === "approved") m.approved += 1;
    else if (e.decision === "denied") m.denied += 1;
    else m.auto += 1;
    if (e.edited) m.edits += 1;
    if (typeof e.editDistance === "number") dists.set(month, [...(dists.get(month) ?? []), e.editDistance]);
    by.set(month, m);
  }
  for (const m of by.values()) {
    const decided = m.approved + m.denied;
    m.approvalRate = decided > 0 ? m.approved / decided : null;
    const d = dists.get(m.month) ?? [];
    m.meanEditDistance = d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-months);
}

/** Normalised Levenshtein distance, 0 (identical) to 1 (nothing shared). Inputs capped for cost. */
export function editDistance(a: string, b: string): number {
  const x = a.trim().slice(0, 2000), y = b.trim().slice(0, 2000);
  if (x === y) return 0;
  if (!x.length || !y.length) return 1;
  let prev = new Array<number>(y.length + 1);
  let cur = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[y.length] / Math.max(x.length, y.length);
}
