/**
 * How a calendar event is drawn on the Calendar page (2026-10-14 identity),
 * shared by the day grid, the day list and the legend so all three agree:
 *
 *   meeting  — accepted (or tentative) with other people: navy
 *   solo     — just you (focus, holds, personal blocks): gold hatch
 *   invite   — someone else's invitation you haven't answered: cream, blue ring
 *   declined — dashed ghost, title struck through
 *
 * Pure presentation: nothing here fetches, and the classification reads only
 * fields the page already has.
 */

import type { CSSProperties } from "react";

export type BlockKind = "meeting" | "solo" | "invite" | "declined";

export interface KindInput {
  attendees?: string[];
  isOrganizer?: boolean;
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
}

export function blockKind(e: KindInput): BlockKind {
  if (e.myResponseStatus === "declined") return "declined";
  if (e.myResponseStatus === "needsAction" && e.isOrganizer === false) return "invite";
  if ((e.attendees?.length ?? 0) === 0) return "solo";
  return "meeting";
}

const HATCH =
  "repeating-linear-gradient(135deg, rgba(200,169,107,.42) 0 6px, rgba(200,169,107,.18) 6px 12px), var(--w-flimsy)";

/** Fill, border and title colour for each kind — the same marks as the Today day ribbon. */
export const KIND_STYLE: Record<BlockKind, CSSProperties> = {
  meeting: { background: "#10213F", color: "#F6F1E7", border: "1px solid #10213F" },
  solo: { background: HATCH, color: "#4A3712", border: "1px solid #C8A96B" },
  invite: { background: "var(--w-paper)", color: "var(--w-ink)", border: "1.5px solid #2F5FA8" },
  declined: { background: "var(--w-paper)", color: "var(--w-ink-soft)", border: "1.5px dashed #8A8F99" },
};

/** Secondary line (times, attendees) on each kind — solid colours, never faded. */
export const KIND_SUB: Record<BlockKind, string> = {
  meeting: "#D4B978",
  solo: "#4A3712",
  invite: "var(--w-ink-soft)",
  declined: "var(--w-ink-soft)",
};

export const KIND_LABEL: Record<BlockKind, string> = {
  meeting: "Meeting",
  solo: "Just you",
  invite: "Needs your reply",
  declined: "Declined",
};

/** The hover / drag lift used on every event block. */
export const LIFT_SHADOW = "0 16px 28px -14px rgba(16,33,63,.55)";

/** A small square in the kind's own fill, for legends and lists. Decorative — always paired with a text label. */
export function KindSwatch({ kind, className = "" }: { kind: BlockKind; className?: string }) {
  const s = KIND_STYLE[kind];
  return (
    <span
      aria-hidden
      className={`inline-block h-3 w-3 shrink-0 rounded-[4px] ${className}`}
      style={{ background: s.background, border: s.border }}
    />
  );
}

/** The four kinds, with labels — the legend over the day grid. */
export function KindLegend({ className = "" }: { className?: string }) {
  return (
    <ul aria-label="Event key" className={`flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[12px] text-[color:var(--w-ink-soft)] ${className}`}>
      {(Object.keys(KIND_LABEL) as BlockKind[]).map((k) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <KindSwatch kind={k} />
          {KIND_LABEL[k]}
        </li>
      ))}
    </ul>
  );
}
