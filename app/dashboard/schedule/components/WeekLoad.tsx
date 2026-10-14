"use client";

/**
 * "This week" on the Calendar page: meeting hours vs free working hours for
 * Monday–Friday of the week in view, as stacked columns on a navy panel — the
 * same mark as NextDaysPanel on Today.
 *
 * Counted only from the events the page already loaded for the visible month
 * (no fetch of its own). Overlapping meetings are merged so a double-booking is
 * not counted twice. A weekday that falls in another month was not loaded, so
 * it is drawn as a dashed outline and never reported as free.
 */

import { useMemo, useState } from "react";

export interface WeekEvent {
  start: string;
  end: string;
  isAllDay?: boolean;
  attendees?: string[];
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
}

export interface WeekDay {
  iso: string;      // YYYY-MM-DD
  weekday: string;  // "Mon"
  label: string;    // "Mon", or "Today"
  date: number;     // day of month
  loaded: boolean;  // inside the month the page fetched
  isToday: boolean;
  meet: number;     // hours, to the quarter
  free: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const FULL: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" };
const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const quarter = (h: number) => Math.round(h * 4) / 4;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3h", "4h 30m", "45m", "0h". */
export function hm(h: number): string {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  if (whole === 0 && mins === 0) return "0h";
  if (whole === 0) return `${mins}m`;
  return mins ? `${whole}h ${mins}m` : `${whole}h`;
}

/** Monday (local) of the working week to show for a day; a weekend looks ahead to the coming week. Pure. */
export function weekMonday(anchor: Date): Date {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 12);
  const dow = d.getDay(); // 0 = Sun
  d.setDate(d.getDate() + (dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow));
  return d;
}

/** Monday on or before a day — "this week" for the title, never looking ahead. */
function mondayOnOrBefore(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

/**
 * Meeting hours (other people on the invite, not declined, merged, clipped to
 * working hours) and the free hours left, for Monday–Friday. Events are bucketed
 * by the date in their own start string — the same rule the page's mini
 * calendar uses — and placed in local hours, as the day grid draws them. Pure.
 */
export function weekLoad(
  events: WeekEvent[],
  monday: Date,
  loadedYear: number,
  loadedMonth: number,
  todayIso: string,
  workStart = 9,
  workEnd = 18,
): WeekDay[] {
  const span = workEnd - workStart;
  return WEEKDAYS.map((weekday, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i, 12);
    const iso = isoOf(d);
    const loaded = d.getFullYear() === loadedYear && d.getMonth() === loadedMonth;
    const spans: Array<[number, number]> = [];
    if (loaded) {
      for (const e of events) {
        if (e.isAllDay || e.myResponseStatus === "declined" || (e.attendees?.length ?? 0) === 0) continue;
        if ((e.start || "").substring(0, 10) !== iso) continue;
        const s = new Date(e.start);
        const t = new Date(e.end);
        const from = s.getHours() + s.getMinutes() / 60;
        const to = isoOf(t) === isoOf(s) ? t.getHours() + t.getMinutes() / 60 : 24;
        const a = Math.max(workStart, from);
        const b = Math.min(workEnd, to);
        if (b > a) spans.push([a, b]);
      }
    }
    spans.sort((x, y) => x[0] - y[0]);
    let meet = 0;
    let curS = 0;
    let curE = 0;
    for (const [a, b] of spans) {
      if (a > curE) { meet += curE - curS; curS = a; curE = b; }
      else curE = Math.max(curE, b);
    }
    meet += curE - curS;
    meet = quarter(Math.min(meet, span));
    return {
      iso, weekday, date: d.getDate(), loaded,
      isToday: iso === todayIso,
      label: iso === todayIso ? "Today" : weekday,
      meet, free: quarter(span - meet),
    };
  });
}

const full = (d: WeekDay) => (d.isToday ? "Today" : FULL[d.weekday]);

export function WeekPanel({
  events, anchorIso, year, month, monthName, todayIso, selectedIso, status, onSelectDay,
  workStart = 9, workEnd = 18, delay = 0,
}: {
  events: WeekEvent[];
  /** YYYY-MM-DD of the day whose week is shown (the selected day, else today). */
  anchorIso: string;
  /** The month the page loaded (0-indexed). */
  year: number;
  month: number;
  monthName: string;
  todayIso: string;
  selectedIso?: string;
  status: "loading" | "error" | "disconnected" | "ready";
  onSelectDay?: (iso: string) => void;
  workStart?: number;
  workEnd?: number;
  delay?: number;
}) {
  const monday = useMemo(() => weekMonday(new Date(`${anchorIso}T12:00:00`)), [anchorIso]);
  const days = useMemo(
    () => weekLoad(events, monday, year, month, todayIso, workStart, workEnd),
    [events, monday, year, month, todayIso, workStart, workEnd],
  );
  const [hover, setHover] = useState<string | null>(null);

  const span = workEnd - workStart;
  const px = 92 / span;
  const loaded = days.filter((d) => d.loaded);
  const focus = days.find((d) => d.iso === hover) ?? loaded.find((d) => d.isToday) ?? loaded[0] ?? null;
  const heaviest = [...loaded].sort((a, b) => b.meet - a.meet)[0];
  const lightest = [...loaded].sort((a, b) => a.meet - b.meet)[0];

  const thisMonday = mondayOnOrBefore(new Date(`${todayIso}T12:00:00`));
  const weeksAhead = Math.round((monday.getTime() - thisMonday.getTime()) / (7 * 86_400_000));
  const title = weeksAhead === 0 ? "This week"
    : weeksAhead === 1 ? "Next week"
    : weeksAhead === -1 ? "Last week"
    : `Week of ${monday.getDate()} ${MONTHS_SHORT[monday.getMonth()]}`;

  let note = "";
  if (loaded.length === 0) note = `These days fall outside ${monthName}, so they aren't loaded here.`;
  else if (loaded.every((d) => d.meet === 0)) note = "No meetings booked — every weekday is open.";
  else if (heaviest && lightest && heaviest.iso !== lightest.iso) {
    const light = lightest.isToday ? "today" : FULL[lightest.weekday];
    note = `${full(heaviest)} is your heaviest day (${hm(heaviest.meet)} of meetings); ${light} is the lightest${lightest.meet === 0 ? ", with nothing booked" : ` (${hm(lightest.meet)})`}.`;
  } else if (heaviest) note = `${full(heaviest)} has ${hm(heaviest.meet)} of meetings.`;
  if (loaded.length > 0 && loaded.length < days.length) note += " Dashed days are in another month and aren't counted.";

  const pad2 = (h: number) => `${pad(Math.floor(h))}:${pad(Math.round((h % 1) * 60))}`;

  return (
    <section
      aria-labelledby="week-load-h"
      className="basil-rise flex flex-col gap-3 rounded-[20px] bg-[#10213F] p-5 text-[#F6F1E7]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="week-load-h" className="basil-serif text-[26px] leading-tight">{title}</h2>
        <span className="flex gap-3 text-[12px] text-[#F6F1E7]">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-[3px] bg-[#6C7FA3]" />Meetings</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-[3px] bg-[#D4B978]" />Free</span>
        </span>
      </div>
      <p className="basil-mono -mt-1.5 text-[11px] text-[#F6F1E7]">Mon–Fri · {pad2(workStart)}–{pad2(workEnd)}</p>

      {status !== "ready" ? (
        <p className="text-[14px] leading-relaxed text-[#F6F1E7]">
          {status === "loading" ? "Counting your week…"
            : status === "error" ? "The calendar didn't load, so there's no week to count yet."
            : "Connect Google Calendar to see how your week is shaped."}
        </p>
      ) : (
        <>
          <div className="flex h-[132px] items-end gap-2.5 px-0.5" role="group" aria-label={`${title}: meeting and free hours, Monday to Friday`}>
            {days.map((d, i) => {
              const on = focus?.iso === d.iso;
              const selected = d.iso === selectedIso;
              return (
                <button
                  key={d.iso}
                  type="button"
                  onMouseEnter={() => setHover(d.iso)}
                  onFocus={() => setHover(d.iso)}
                  onClick={() => { if (d.loaded) onSelectDay?.(d.iso); }}
                  aria-label={d.loaded
                    ? `${full(d)}, ${d.date}: ${hm(d.meet)} of meetings, ${hm(d.free)} free. Open this day.`
                    : `${full(d)}, ${d.date}: in another month, not counted here.`}
                  className="flex h-full min-w-0 flex-1 flex-col items-stretch justify-end gap-1.5 rounded-md border-0 bg-transparent p-0 text-[#F6F1E7]"
                >
                  {d.loaded ? (
                    <span
                      className="basil-col flex flex-col gap-0.5 rounded-[5px] transition-[outline-color]"
                      style={{
                        animationDelay: `${delay + 200 + i * 80}ms`,
                        outline: on ? "2px solid #F6F1E7" : "2px solid transparent",
                        outlineOffset: 3,
                      }}
                    >
                      <span className="rounded-t-[4px] rounded-b-[2px] bg-[#D4B978]" style={{ height: Math.round(d.free * px) }} />
                      <span className="rounded-[2px] bg-[#6C7FA3]" style={{ height: Math.round(d.meet * px) }} />
                    </span>
                  ) : (
                    <span
                      className="rounded-[5px]"
                      style={{
                        height: Math.round(span * px) + 2,
                        border: "1.5px dashed #8A8F99",
                        outline: on ? "2px solid #F6F1E7" : "2px solid transparent",
                        outlineOffset: 3,
                      }}
                    />
                  )}
                  <span className="basil-mono flex flex-col items-center text-[11px] leading-tight" style={{ color: on ? "#D4B978" : "#F6F1E7" }}>
                    <span>{d.label}</span>
                    <span className={selected ? "underline decoration-[#D4B978] decoration-2 underline-offset-[3px]" : ""}>{d.date}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {focus && (
            <p className="text-[14px] leading-relaxed text-[#F6F1E7]" aria-live="polite">
              {focus.loaded
                ? `${full(focus)}: ${hm(focus.meet)} of meetings, ${hm(focus.free)} free.`
                : `${full(focus)} ${focus.date} is in another month — not counted here.`}
            </p>
          )}
          {note && <p className="text-[13px] leading-relaxed text-[#D4B978]">{note}</p>}
        </>
      )}
    </section>
  );
}
