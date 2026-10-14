"use client";

/**
 * The right-hand column of the new Today: what others owe you (as waiting-time
 * bars) and your next working days (meetings vs free time, as stacked columns).
 * Every number is counted from the actions store or the calendar.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ActionItem } from "@/lib/types/action";
import type { CalendarEvent } from "@/lib/google/calendar";
import { daysSince, nextDaysLoad } from "@/lib/today/visual-data";


export function WaitingPanel({ items, now, delay = 0 }: { items: ActionItem[]; now: Date; delay?: number }) {
  const rows = useMemo(() => items
    .map((a) => ({
      id: a.id,
      who: (a as { owner?: string; assignee?: string }).owner ?? (a as { assignee?: string }).assignee ?? "Someone",
      what: a.text,
      days: daysSince((a as { createdAt?: string }).createdAt, now),
    }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 4), [items, now]);
  const max = Math.max(10, ...rows.map((r) => r.days));

  return (
    <section aria-labelledby="waiting-h" className="basil-rise flex flex-col gap-3.5 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-[22px]" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-baseline justify-between gap-2.5">
        <h2 id="waiting-h" className="basil-serif text-[26px] text-[#10213F]">Waiting on others</h2>
        <Link href="/dashboard/actions" className="text-[14px] font-medium no-underline" style={{ color: "var(--w-carbon)" }}>
          All {items.length} →
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-[14px] text-[color:var(--w-ink-soft)]">Nobody owes you anything right now.</p>
      ) : rows.map((r, i) => (
        <div key={r.id} className="flex flex-col gap-1.5">
          <span className="text-[14px] leading-snug text-[color:var(--w-ink)]"><strong className="font-semibold">{r.who}</strong> · {r.what}</span>
          <span className="flex items-center gap-2.5">
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--w-tray)]">
              <span className="basil-grow block h-2.5 rounded-full" style={{ width: `${(r.days / max) * 100}%`, background: "#2F5FA8", animationDelay: `${delay + 200 + i * 120}ms` }} />
            </span>
            <span className="basil-mono w-[58px] text-right text-[12px] text-[color:var(--w-ink)]">{r.days} day{r.days === 1 ? "" : "s"}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

export function NextDaysPanel({
  events, now, timeZone, workStart = 9, workEnd = 18, delay = 0,
}: {
  events: CalendarEvent[]; now: Date; timeZone?: string; workStart?: number; workEnd?: number; delay?: number;
}) {
  const days = useMemo(() => nextDaysLoad(events, now, timeZone, workStart, workEnd), [events, now, timeZone, workStart, workEnd]);
  const [hover, setHover] = useState<string | null>(null);
  const span = workEnd - workStart;
  const px = 120 / span;
  const focus = days.find((d) => d.key === hover) ?? days[0];
  const busiest = [...days].sort((a, b) => b.meet - a.meet)[0];
  const calmest = [...days].sort((a, b) => b.free - a.free)[0];

  return (
    <section aria-labelledby="days-h" className="basil-rise flex flex-col gap-3.5 rounded-[20px] bg-[#10213F] p-[22px] text-[#F6F1E7]" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-baseline justify-between gap-2.5">
        <h2 id="days-h" className="basil-serif text-[26px]">Your next five days</h2>
        <span className="flex gap-3 text-[12px] text-[rgba(246,241,231,.8)]">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-[#6C7FA3]" />Meetings</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-[#D4B978]" />Free</span>
        </span>
      </div>
      <div className="flex h-[150px] items-end gap-3.5 px-1">
        {days.map((d, i) => (
          <button
            key={d.key}
            type="button"
            onMouseEnter={() => setHover(d.key)}
            onFocus={() => setHover(d.key)}
            aria-label={`${d.label}: ${d.meet} hours of meetings, ${d.free} free`}
            className="flex h-full flex-1 flex-col items-stretch justify-end gap-1.5 border-0 bg-transparent p-0 text-[#F6F1E7]"
          >
            <span className="basil-col flex flex-col gap-0.5 rounded-[5px] transition-[outline-color]" style={{ animationDelay: `${delay + 200 + i * 80}ms`, outline: focus?.key === d.key ? "2px solid #F6F1E7" : "2px solid transparent", outlineOffset: 3 }}>
              <span className="rounded-t-[4px] rounded-b-[2px] bg-[#D4B978]" style={{ height: Math.round(d.free * px) }} />
              <span className="rounded-[2px] bg-[#6C7FA3]" style={{ height: Math.round(d.meet * px) }} />
            </span>
            <span className="basil-mono text-center text-[11px]" style={{ color: focus?.key === d.key ? "#D4B978" : "rgba(246,241,231,.75)" }}>{d.label}</span>
          </button>
        ))}
      </div>
      {focus && (
        <p className="text-[14px] leading-relaxed text-[rgba(246,241,231,.9)]" aria-live="polite">
          {focus.label}: {focus.meet} h of meetings, {focus.free} h free.
          {busiest && calmest && busiest.key !== calmest.key
            ? ` ${busiest.label} is your heaviest day; ${calmest.label} has the most room to think.`
            : ""}
        </p>
      )}
    </section>
  );
}
