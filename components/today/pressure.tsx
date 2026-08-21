"use client";

/**
 * Pressure and momentum — two charts, both plotting stored quantities.
 *
 * No pie charts: a pie answers "what share of the whole", which is not a
 * question anyone asks about their own workload. These answer "how much of
 * today is already spoken for" and "what is ageing".
 *
 * Every chart carries a text equivalent in the DOM (not a tooltip, not a title
 * attribute) so a screen reader, a printout and a pasted screenshot all convey
 * the same thing. The visual is a convenience over the text, not a replacement.
 */

import { Card, Empty, Unavailable, Panel } from "./primitives";
import type { AgeingBuckets, DayShape } from "@/lib/today/executive";
import Link from "next/link";

const fmt = (m: number) => {
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h ? `${h}h${r ? ` ${r}m` : ""}` : `${r}m`;
};

/** Today's pressure: booked versus clear, across the working span. */
export function PressureTimeline({ day, connected }: { day: DayShape; connected: boolean }) {
  if (!connected) {
    return <Unavailable what="Pressure timeline" why="It is drawn from your calendar, which is not connected." />;
  }
  if (day.meetingCount === 0) {
    return <Empty>No meetings today, so there is no booked-versus-clear split to show.</Empty>;
  }

  const span = day.meetingMinutes + day.gapMinutes;
  const bookedPct = span > 0 ? (day.meetingMinutes / span) * 100 : 0;
  const summary =
    `Between ${new Date(day.firstStart!).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} ` +
    `and ${new Date(day.lastEnd!).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}, ` +
    `${fmt(day.meetingMinutes)} is booked in ${day.meetingCount} meetings and ${fmt(day.gapMinutes)} is clear. ` +
    `Longest uninterrupted stretch: ${fmt(day.longestGapMinutes)}.`;

  return (
    <Card className="p-4">
      {/* The text equivalent IS the content; the bar is the illustration. */}
      <p className="text-[0.875rem] leading-relaxed text-[var(--w-ink)]">{summary}</p>
      <div
        className="mt-3 flex h-6 overflow-hidden rounded border border-[var(--w-rule-strong)]"
        role="img"
        aria-label={summary}
      >
        <div
          className="flex items-center justify-center text-[0.6875rem] font-semibold text-white"
          style={{ width: `${bookedPct}%`, background: "var(--w-carbon)" }}
        >
          {bookedPct > 18 && <span>Booked</span>}
        </div>
        <div
          className="flex items-center justify-center text-[0.6875rem] font-semibold text-[var(--w-ink-soft)]"
          style={{ width: `${100 - bookedPct}%`, background: "var(--w-tray)" }}
        >
          {100 - bookedPct > 18 && <span>Clear</span>}
        </div>
      </div>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-[var(--w-ink-soft)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--w-carbon)" }} aria-hidden />
          Booked <span className="wire-data">{fmt(day.meetingMinutes)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-[var(--w-rule-strong)]" style={{ background: "var(--w-tray)" }} aria-hidden />
          Clear <span className="wire-data">{fmt(day.gapMinutes)}</span>
        </span>
      </p>
    </Card>
  );
}

/** Commitment ageing: overdue, today, next seven days, stalled. */
export function CommitmentAgeing({
  buckets, loading, failed,
}: { buckets: AgeingBuckets | null; loading: boolean; failed: boolean }) {
  if (failed) return <Unavailable what="Commitment ageing" why="Commitments could not be read, so nothing here would be trustworthy." />;
  if (loading || !buckets) {
    return <div role="status" aria-live="polite" className="h-24 rounded-lg border border-[var(--w-rule)] bg-[var(--w-tray)] motion-safe:animate-pulse"><span className="sr-only">Loading commitments…</span></div>;
  }
  if (buckets.total === 0) {
    return <Empty>No open commitments. Basil can read your commitments store, so this is genuinely clear.</Empty>;
  }

  const rows = [
    { key: "overdue", label: "Overdue", n: buckets.overdue.length, color: "var(--w-stamp)" },
    { key: "today",   label: "Due today", n: buckets.today.length, color: "var(--w-manila)" },
    { key: "next7",   label: "Next 7 days", n: buckets.next7.length, color: "var(--w-carbon)" },
    { key: "stalled", label: "Stalled (30d+, no date)", n: buckets.stalled.length, color: "var(--w-ink-soft)" },
  ];
  const max = Math.max(...rows.map((r) => r.n), 1);
  const summary = rows.map((r) => `${r.label}: ${r.n}`).join(". ") + ".";

  return (
    <Card className="p-4">
      <p className="sr-only">{summary}</p>
      <ul className="space-y-2" role="img" aria-label={summary}>
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-3">
            <span className="w-[8.5rem] shrink-0 text-[0.8125rem] text-[var(--w-ink)]">{r.label}</span>
            <span className="flex-1 h-4 rounded-sm bg-[var(--w-tray)] overflow-hidden">
              <span className="block h-full rounded-sm" style={{ width: `${(r.n / max) * 100}%`, background: r.color }} />
            </span>
            <span className="wire-data w-8 shrink-0 text-right text-[0.8125rem] font-bold text-[var(--w-ink)]">{r.n}</span>
          </li>
        ))}
      </ul>
      {buckets.stalled.length > 0 && (
        <p className="mt-3 text-[0.8125rem] text-[var(--w-ink-soft)]">
          Stalled items have no due date and have not moved in 30 days. They are not overdue — they are forgotten.{" "}
          <Link href="/dashboard/actions" className="font-semibold underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>
            Review commitments
          </Link>
        </p>
      )}
    </Card>
  );
}

export function PressureSection({
  day, calendarConnected, buckets, commitmentsLoading, commitmentsFailed,
}: {
  day: DayShape;
  calendarConnected: boolean;
  buckets: AgeingBuckets | null;
  commitmentsLoading: boolean;
  commitmentsFailed: boolean;
}) {
  return (
    <Panel title="Pressure and momentum" id="pressure-h">
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <h3 className="mb-1.5 text-[0.8125rem] font-medium text-[var(--w-ink)]">Today&rsquo;s pressure</h3>
          <PressureTimeline day={day} connected={calendarConnected} />
        </div>
        <div>
          <h3 className="mb-1.5 text-[0.8125rem] font-medium text-[var(--w-ink)]">Commitment ageing</h3>
          <CommitmentAgeing buckets={buckets} loading={commitmentsLoading} failed={commitmentsFailed} />
        </div>
      </div>
    </Panel>
  );
}
