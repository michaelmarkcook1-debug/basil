"use client";

/**
 * The shape of the day: meetings, the gaps between them, and where "now" sits.
 *
 * Bar length encodes DURATION, which is the one thing length can honestly mean
 * here. The previous timeline encoded duration as block height and then also
 * used height for emphasis, so a long unimportant meeting outweighed a short
 * critical one purely by sitting there for 90 minutes.
 *
 * Preparation flags are facts off the calendar record (unanswered RSVP, size,
 * external call) — never a guess about whether you are "ready".
 */

import Link from "next/link";
import { Video, Users, AlertTriangle, ArrowRight } from "lucide-react";
import { Card, Empty, Unavailable } from "./primitives";
import { preparationReasons, type DayShape } from "@/lib/today/executive";

function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function dur(m: number) {
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h ? `${h}h${r ? String(r).padStart(2, "0") : ""}` : `${r}m`;
}

export function DayTimeline({
  day, connected, now,
}: { day: DayShape; connected: boolean; now: Date }) {
  if (!connected) {
    return (
      <Unavailable
        what="Calendar"
        why="Google Calendar is not connected, so Basil cannot see your day. This is not an empty schedule."
        action={
          <Link href="/dashboard/settings" className="text-[0.875rem] font-semibold underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>
            Connect calendar
          </Link>
        }
      />
    );
  }

  if (day.meetingCount === 0 && day.allDay.length === 0) {
    return <Empty>Nothing scheduled today. Your calendar is connected and reporting, so this is a clear day rather than a missing one.</Empty>;
  }

  const nowMs = now.getTime();

  return (
    <div className="space-y-2">
      {day.allDay.length > 0 && (
        <Card className="px-3 py-2">
          <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-[color:var(--w-ink-soft)]">All day</p>
          <ul className="mt-1 space-y-0.5">
            {day.allDay.map((e) => (
              <li key={e.id} className="text-[0.875rem] text-[color:var(--w-ink)]">{e.summary}</li>
            ))}
          </ul>
        </Card>
      )}

      {day.backToBackRuns >= 2 && (
        <p
          className="flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[0.8125rem] font-medium"
          style={{ color: "var(--w-manila)", background: "var(--w-manila-tint)", borderColor: "var(--w-manila)" }}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {day.backToBackRuns} back-to-back transitions — no reset between them
        </p>
      )}

      <Card className="divide-y divide-[var(--w-rule)] overflow-hidden">
        <ol className="divide-y divide-[var(--w-rule)]">
          {day.segments.map((seg, i) => {
            if (seg.kind === "gap") {
              const focus = seg.minutes >= 45;
              return (
                <li key={`gap-${i}`} className="flex items-center gap-3 px-3 py-1.5 bg-[var(--w-tray)]">
                  <span className="wire-data w-[3.25rem] shrink-0 text-[0.6875rem] text-[color:var(--w-ink-soft)]">
                    {hhmm(seg.start)}
                  </span>
                  <span className="text-[0.8125rem] text-[color:var(--w-ink-soft)]">
                    {dur(seg.minutes)} clear{focus ? " — usable focus block" : ""}
                  </span>
                </li>
              );
            }
            const e = seg.event!;
            const reasons = preparationReasons(e);
            const isNow = nowMs >= new Date(seg.start).getTime() && nowMs < new Date(seg.end).getTime();
            return (
              <li
                key={e.id}
                className="relative px-3 py-2.5"
                style={isNow ? { background: "var(--w-carbon-tint)" } : undefined}
                aria-current={isNow ? "true" : undefined}
              >
                {isNow && (
                  <span
                    className="absolute left-0 top-0 h-full w-[3px]"
                    style={{ background: "var(--w-carbon)" }}
                    aria-hidden
                  />
                )}
                <div className="flex items-start gap-3">
                  <span className="wire-data w-[3.25rem] shrink-0 pt-0.5 text-[0.75rem] font-bold text-[color:var(--w-ink)]">
                    {hhmm(seg.start)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.9375rem] font-medium leading-snug text-[color:var(--w-ink)]">
                      {isNow && <span className="sr-only">Happening now: </span>}
                      {e.summary}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[0.75rem] text-[color:var(--w-ink-soft)]">
                      <span className="wire-data">{dur(seg.minutes)}</span>
                      {e.attendeeCount > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Users className="h-3 w-3" aria-hidden />{e.attendeeCount}
                        </span>
                      )}
                      {e.hasVideo && (
                        <span className="inline-flex items-center gap-1">
                          <Video className="h-3 w-3" aria-hidden />Video
                        </span>
                      )}
                      {seg.backToBack && <span style={{ color: "var(--w-manila)" }}>Back-to-back</span>}
                    </p>
                    {reasons.length > 0 && (
                      <p className="mt-1 inline-flex items-center gap-1 text-[0.75rem] font-medium"
                         style={{ color: "var(--w-manila)" }}>
                        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                        <span>Prep: {reasons.join(" · ")}</span>
                      </p>
                    )}
                  </div>
                  <Link
                    href={`/dashboard/meetings/${e.id}`}
                    className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center self-center rounded text-[color:var(--w-carbon)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 sm:min-h-[36px] sm:min-w-[36px]"
                    aria-label={`Prepare for ${e.summary}`}
                  >
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </Link>
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <Link
        href="/dashboard/schedule"
        className="inline-flex min-h-[44px] sm:min-h-0 items-center text-[0.875rem] font-semibold underline underline-offset-2"
        style={{ color: "var(--w-carbon)" }}
      >
        Full calendar
      </Link>
    </div>
  );
}
