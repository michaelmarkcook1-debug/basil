"use client";

/**
 * DayPlan — "Your day" at a glance.
 *
 * Auto-builds a suggested time-blocked plan from real data:
 *   • Meetings        — today's calendar events (the fixed backbone)
 *   • Prep            — a 30-min block before each meeting that needs it
 *                       (has video or 2+ attendees), if the slot is free
 *   • Focus           — a morning deep-work block for the top due/priority task
 *   • Lunch / downtime + Admin — sensible default blocks dropped into free slots
 *
 * Suggested blocks are only placed where they don't collide with a real meeting,
 * so the plan never double-books. Everything renders as one scannable timeline.
 */

import { CalendarCheck, Video, Brain, Coffee, Inbox, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlanEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  hasVideo?: boolean;
  attendeeCount?: number;
}

type BlockType = "meeting" | "prep" | "focus" | "lunch" | "admin";

interface Block {
  type: BlockType;
  startMin: number; // minutes since midnight
  endMin: number;
  label: string;
  hasVideo?: boolean;
}

const TYPE_META: Record<BlockType, { icon: typeof Brain; dot: string; chip: string; label: string }> = {
  meeting: { icon: CalendarCheck, dot: "bg-gold",            chip: "text-gold",            label: "Meeting" },
  prep:    { icon: Video,         dot: "bg-signal-info",     chip: "text-signal-info",     label: "Prep" },
  focus:   { icon: Brain,         dot: "bg-signal-positive", chip: "text-signal-positive", label: "Focus" },
  lunch:   { icon: Coffee,        dot: "bg-signal-neutral",  chip: "text-muted-foreground",label: "Downtime" },
  admin:   { icon: Inbox,         dot: "bg-signal-warning",  chip: "text-signal-warning",  label: "Admin" },
};

function minutesOf(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

function overlaps(aS: number, aE: number, blocks: Block[]): boolean {
  return blocks.some((b) => aS < b.endMin && aE > b.startMin);
}

export function DayPlan({ events, focusTask }: { events: PlanEvent[]; focusTask?: string }) {
  const meetings = events
    .filter((e) => !e.isAllDay && e.start && e.end)
    .map<Block>((e) => ({
      type: "meeting",
      startMin: minutesOf(e.start),
      endMin: Math.max(minutesOf(e.end), minutesOf(e.start) + 15),
      label: e.summary || "(busy)",
      hasVideo: e.hasVideo,
    }))
    .sort((a, b) => a.startMin - b.startMin);

  const blocks: Block[] = [...meetings];

  // Prep blocks before meetings that warrant it.
  for (const m of meetings) {
    const needsPrep = m.hasVideo;
    const prepStart = m.startMin - 30;
    if (needsPrep && prepStart >= 7 * 60 && !overlaps(prepStart, m.startMin, blocks)) {
      blocks.push({ type: "prep", startMin: prepStart, endMin: m.startMin, label: `Prep: ${m.label}` });
    }
  }

  // Suggested default blocks — only if the slot is free.
  const suggestions: Block[] = [
    focusTask
      ? { type: "focus", startMin: 9 * 60, endMin: 10 * 60 + 30, label: `Focus: ${focusTask}` }
      : { type: "focus", startMin: 9 * 60, endMin: 10 * 60 + 30, label: "Focus / deep work" },
    { type: "lunch", startMin: 12 * 60 + 30, endMin: 13 * 60 + 30, label: "Lunch & downtime" },
    { type: "admin", startMin: 16 * 60, endMin: 16 * 60 + 30, label: "Admin & inbox" },
  ];
  for (const s of suggestions) {
    if (!overlaps(s.startMin, s.endMin, blocks)) blocks.push(s);
  }

  blocks.sort((a, b) => a.startMin - b.startMin);

  const meetingCount = meetings.length;
  const focusMins = blocks.filter((b) => b.type === "focus").reduce((n, b) => n + (b.endMin - b.startMin), 0);

  if (blocks.length === 0) {
    return (
      <section className="rounded-2xl border border-border/60 bg-card/60 p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Sparkles className="h-4 w-4 text-gold" /> Open day — no meetings scheduled. A clean canvas for deep work.
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-border/60 bg-card/60 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">Your day</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {meetingCount} {meetingCount === 1 ? "meeting" : "meetings"}
            {focusMins > 0 && <> · {Math.round(focusMins / 60 * 10) / 10}h focus suggested</>}
          </p>
        </div>
        <span className="rounded-full bg-gold/10 px-2.5 py-1 text-[11px] font-medium text-gold">Suggested plan</span>
      </div>

      <ol className="relative space-y-1 pl-1">
        {blocks.map((b, i) => {
          const meta = TYPE_META[b.type];
          const Icon = meta.icon;
          const suggested = b.type !== "meeting";
          return (
            <li key={`${b.type}-${b.startMin}-${i}`} className="flex items-stretch gap-3">
              <div className="w-12 shrink-0 pt-2 text-right text-[11px] font-medium tabular-nums text-muted-foreground">
                {fmtMin(b.startMin)}
              </div>
              <div className="flex flex-col items-center">
                <span className={cn("mt-2.5 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-background", meta.dot)} />
                {i < blocks.length - 1 && <span className="w-px flex-1 bg-border/50" />}
              </div>
              <div
                className={cn(
                  "mb-1 flex flex-1 items-center gap-2 rounded-lg px-3 py-2",
                  suggested ? "border border-dashed border-border/50 bg-transparent" : "border border-border/50 bg-muted/40"
                )}
              >
                <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.chip)} />
                <span className="flex-1 truncate text-[13px] text-foreground/90">{b.label}</span>
                <span className={cn("text-[10px] font-medium uppercase tracking-wide", meta.chip)}>
                  {suggested ? meta.label : `${b.endMin - b.startMin}m`}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
