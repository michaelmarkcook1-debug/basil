"use client";

/**
 * dashboard-viz.tsx — the data-visualization layer for the Today command center.
 *
 * Pure presentational SVG/CSS pieces (no data fetching) so the home page can
 * compose a real dashboard instead of a column of text lists:
 *   • Ring          — circular progress dial (used inside stat cards)
 *   • StatCard      — a KPI tile: label + big number + optional ring/spark
 *   • AttentionDonut— where today's signals come from, as a donut + legend
 *   • DayTimeline   — the day as a PROPORTIONAL timeline (block height = duration)
 *                     with a live "now" marker, not a fixed-height list.
 *
 * Everything is themed off the app tokens (gold + signal-* + card/border) so it
 * reads as one premium surface in the warm-dark theme.
 */

import Link from "next/link";
import { CalendarCheck, Video, Brain, Coffee, Inbox, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ── Ring ────────────────────────────────────────────────────────────────────────

export function Ring({
  value,
  color,
  size = 46,
  stroke = 5,
  children,
}: {
  value: number;
  color: string;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value || 0));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          style={{ transition: "stroke-dashoffset 600ms cubic-bezier(0.4,0,0.2,1)" }}
        />
      </svg>
      {children && <div className="absolute inset-0 flex items-center justify-center">{children}</div>}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  sub,
  accent = "var(--gold)",
  ring,
  bar,
  href,
  summary,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: string;
  ring?: { value: number; center?: React.ReactNode };
  bar?: Array<{ value: number; color: string }>;
  /** Optional click-through destination — wraps the card in a Link. */
  href?: string;
  /** Plain-text summary shown on hover (native tooltip) — "what's going on". */
  summary?: string;
}) {
  const cardClass = cn(
    "group relative block overflow-hidden rounded-2xl border border-border/60 bg-card/70 p-4 transition-colors hover:border-gold/30",
    href && "cursor-pointer"
  );
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">{label}</p>
          <p className="mt-1.5 text-[26px] font-semibold leading-none tabular-nums text-foreground">{value}</p>
          {sub && <p className="mt-1.5 text-[11.5px] leading-tight text-muted-foreground">{sub}</p>}
        </div>
        {ring ? (
          <Ring value={ring.value} color={accent} size={46} stroke={5}>
            {ring.center}
          </Ring>
        ) : href ? (
          <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-gold" strokeWidth={1.8} />
        ) : null}
      </div>
      {bar && bar.length > 0 && (
        <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-border/40">
          {bar.map((seg, i) =>
            seg.value > 0 ? (
              <div key={i} style={{ width: `${seg.value * 100}%`, background: seg.color }} className="h-full" />
            ) : null
          )}
        </div>
      )}
    </>
  );

  const cardEl = href ? (
    <Link href={href} className={cardClass}>
      {inner}
    </Link>
  ) : (
    <div className={cardClass}>{inner}</div>
  );

  return summary ? (
    <Tooltip>
      <TooltipTrigger asChild>{cardEl}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed whitespace-pre-line">
        {summary}
      </TooltipContent>
    </Tooltip>
  ) : (
    cardEl
  );
}

// ── Attention donut ─────────────────────────────────────────────────────────────

export interface DonutSeg {
  label: string;
  value: number;
  color: string;
  /** Optional click-through destination for this slice's legend row. */
  href?: string;
  /** Plain-text summary shown on hover (native tooltip) — "what's in this slice". */
  hint?: string;
}

export function AttentionDonut({ segments, total }: { segments: DonutSeg[]; total: number }) {
  const size = 132;
  const stroke = 16;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const sum = segments.reduce((n, s) => n + s.value, 0) || 1;

  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const frac = s.value / sum;
      const dash = frac * circ;
      const arc = { color: s.color, dash, gap: circ - dash, offset };
      offset += dash;
      return arc;
    });

  return (
    <div className="flex items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} opacity={0.5} />
          {arcs.map((a, i) => (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth={stroke}
              strokeDasharray={`${a.dash} ${a.gap}`}
              strokeDashoffset={-a.offset}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold leading-none tabular-nums text-foreground">{total}</span>
          <span className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">signals</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-2">
        {segments.map((s) => {
          const row = (
            <>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="flex-1 truncate text-muted-foreground group-hover/seg:text-foreground">{s.label}</span>
              <span className="tabular-nums font-medium text-foreground">{s.value}</span>
            </>
          );
          const rowEl = s.href ? (
            <Link
              href={s.href}
              className="group/seg -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-0.5 text-[13px] transition-colors hover:bg-white/[0.03]"
            >
              {row}
            </Link>
          ) : (
            <div className="group/seg flex items-center gap-2.5 text-[13px]">{row}</div>
          );
          return (
            <li key={s.label}>
              {s.hint ? (
                <Tooltip>
                  <TooltipTrigger asChild>{rowEl}</TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed whitespace-pre-line">
                    {s.hint}
                  </TooltipContent>
                </Tooltip>
              ) : (
                rowEl
              )}
            </li>
          );
        })}
        {total === 0 && <li className="text-[13px] text-muted-foreground">Nothing pending — all clear.</li>}
      </ul>
    </div>
  );
}

// ── Day timeline (proportional) ──────────────────────────────────────────────────

type BlockType = "meeting" | "prep" | "focus" | "lunch" | "admin";

interface Block {
  type: BlockType;
  startMin: number;
  endMin: number;
  label: string;
  hasVideo?: boolean;
  /** Calendar event id — carried through so a meeting (or its prep) block can
   *  deep-link to /dashboard/meetings/[eventId]. Absent for synthetic
   *  focus/lunch/admin suggestions (those link to the schedule instead). */
  eventId?: string;
}

export interface PlanEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  hasVideo?: boolean;
  attendeeCount?: number;
}

const TYPE_META: Record<BlockType, { icon: typeof Brain; color: string; label: string }> = {
  meeting: { icon: CalendarCheck, color: "var(--gold)", label: "Meeting" },
  prep: { icon: Video, color: "var(--signal-info)", label: "Prep" },
  focus: { icon: Brain, color: "var(--signal-positive)", label: "Focus" },
  lunch: { icon: Coffee, color: "var(--muted-foreground)", label: "Downtime" },
  admin: { icon: Inbox, color: "var(--signal-warning)", label: "Admin" },
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

export function buildDayBlocks(events: PlanEvent[], focusTask?: string): Block[] {
  const meetings = events
    .filter((e) => !e.isAllDay && e.start && e.end)
    .map<Block>((e) => ({
      type: "meeting",
      startMin: minutesOf(e.start),
      endMin: Math.max(minutesOf(e.end), minutesOf(e.start) + 15),
      label: e.summary || "(busy)",
      hasVideo: e.hasVideo,
      eventId: e.id,
    }))
    .sort((a, b) => a.startMin - b.startMin);

  const blocks: Block[] = [...meetings];
  for (const m of meetings) {
    const prepStart = m.startMin - 30;
    if (m.hasVideo && prepStart >= 7 * 60 && !overlaps(prepStart, m.startMin, blocks)) {
      // Prep block deep-links to the SAME meeting it's preparing for.
      blocks.push({ type: "prep", startMin: prepStart, endMin: m.startMin, label: `Prep · ${m.label}`, eventId: m.eventId });
    }
  }
  const suggestions: Block[] = [
    { type: "focus", startMin: 9 * 60, endMin: 10 * 60 + 30, label: focusTask ? `Focus · ${focusTask}` : "Focus / deep work" },
    { type: "lunch", startMin: 12 * 60 + 30, endMin: 13 * 60 + 30, label: "Lunch & downtime" },
    { type: "admin", startMin: 16 * 60, endMin: 16 * 60 + 30, label: "Admin & inbox" },
  ];
  for (const s of suggestions) if (!overlaps(s.startMin, s.endMin, blocks)) blocks.push(s);

  return blocks.sort((a, b) => a.startMin - b.startMin);
}

export function DayTimeline({
  events,
  focusTask,
  nowMin,
}: {
  events: PlanEvent[];
  focusTask?: string;
  nowMin: number;
}) {
  const blocks = buildDayBlocks(events, focusTask);
  const meetings = blocks.filter((b) => b.type === "meeting");
  const focusMins = blocks.filter((b) => b.type === "focus").reduce((n, b) => n + (b.endMin - b.startMin), 0);

  // Window: 8am → 8pm, expanded to cover any out-of-range blocks + now.
  let dayStart = 8 * 60;
  let dayEnd = 20 * 60;
  for (const b of blocks) {
    dayStart = Math.min(dayStart, b.startMin);
    dayEnd = Math.max(dayEnd, b.endMin);
  }
  if (nowMin >= dayStart && nowMin <= dayEnd) {
    dayStart = Math.min(dayStart, nowMin);
    dayEnd = Math.max(dayEnd, nowMin);
  }
  const span = Math.max(dayEnd - dayStart, 60);
  const PX_PER_MIN = 1.05;
  const height = span * PX_PER_MIN;
  const yOf = (min: number) => (min - dayStart) * PX_PER_MIN;

  // Hour gridlines.
  const hourLines: number[] = [];
  for (let h = Math.ceil(dayStart / 60); h <= Math.floor(dayEnd / 60); h++) hourLines.push(h * 60);

  const nowVisible = nowMin >= dayStart && nowMin <= dayEnd;

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link
            href="/dashboard/schedule"
            className="group/hd inline-flex items-center gap-1 text-sm font-semibold tracking-tight text-foreground outline-none transition-colors hover:text-gold focus-visible:text-gold"
          >
            Your day
            <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground/40 transition-colors group-hover/hd:text-gold" strokeWidth={1.8} />
          </Link>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {meetings.length} {meetings.length === 1 ? "meeting" : "meetings"}
            {focusMins > 0 && <> · {Math.round((focusMins / 60) * 10) / 10}h focus protected</>}
          </p>
        </div>
        <span className="rounded-full bg-gold/10 px-2.5 py-1 text-[11px] font-medium text-gold">Suggested plan</span>
      </div>

      {blocks.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Brain className="h-4 w-4 text-signal-positive" /> Open day — no meetings. A clean canvas for deep work.
        </div>
      ) : (
        <div className="relative pl-12" style={{ height }}>
          {/* Hour gridlines + labels */}
          {hourLines.map((m) => (
            <div key={m} className="absolute inset-x-0 flex items-center" style={{ top: yOf(m), left: 0 }}>
              <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/50">{fmtMin(m)}</span>
              <span className="ml-2 h-px flex-1 bg-border/30" />
            </div>
          ))}

          {/* Blocks — every block is a click-through:
              · meeting / prep  → the meeting's prep & cheatsheet page
              · focus/lunch/admin (synthetic suggestions) → the schedule */}
          {blocks.map((b, i) => {
            const meta = TYPE_META[b.type];
            const Icon = meta.icon;
            const top = yOf(b.startMin);
            const h = Math.max((b.endMin - b.startMin) * PX_PER_MIN, 22);
            const isMeeting = b.type === "meeting";
            const linkable = (b.type === "meeting" || b.type === "prep") && b.eventId;
            const href = linkable
              ? `/dashboard/meetings/${encodeURIComponent(b.eventId!)}`
              : "/dashboard/schedule";
            const verb = linkable ? "Open meeting prep" : "Open your schedule";
            const blockSummary = `${b.label} · ${fmtMin(b.startMin)}–${fmtMin(b.endMin)}${b.hasVideo ? " · video call" : ""} — ${verb}.`;
            return (
              <Tooltip key={`${b.type}-${b.startMin}-${i}`}>
                <TooltipTrigger asChild>
                  <Link
                    href={href}
                    aria-label={blockSummary}
                    className={cn(
                      "group/blk absolute left-12 right-0 flex items-center gap-2 overflow-hidden rounded-lg px-2.5 outline-none",
                      "cursor-pointer transition-[box-shadow,background-color] hover:ring-1 hover:ring-gold/40",
                      "focus-visible:ring-2 focus-visible:ring-gold/60",
                      isMeeting ? "border-l-2" : "border border-dashed hover:bg-white/[0.03]"
                    )}
                    style={{
                      top,
                      height: h - 3,
                      background: isMeeting ? `color-mix(in srgb, ${meta.color} 14%, transparent)` : "transparent",
                      borderColor: isMeeting ? meta.color : "var(--border)",
                    }}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: meta.color }} />
                    <span className="flex-1 truncate text-[12.5px] font-medium text-foreground/90">{b.label}</span>
                    {h > 30 && (
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70 group-hover/blk:hidden">
                        {fmtMin(b.startMin)}
                      </span>
                    )}
                    {/* Hover affordance — appears in the slot the time label vacates */}
                    <ArrowUpRight
                      className="hidden h-3.5 w-3.5 shrink-0 text-gold group-hover/blk:block"
                      strokeWidth={2}
                    />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
                  {blockSummary}
                </TooltipContent>
              </Tooltip>
            );
          })}

          {/* Now line */}
          {nowVisible && (
            <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: yOf(nowMin), left: 0 }}>
              <span className="w-10 shrink-0 text-right text-[10px] font-semibold text-signal-critical">now</span>
              <span className="ml-2 h-px flex-1 bg-signal-critical/70" />
              <span className="absolute left-[46px] h-2 w-2 -translate-y-px rounded-full bg-signal-critical" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
