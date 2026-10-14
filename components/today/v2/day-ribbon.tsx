"use client";

/**
 * The shape of your day, as one ribbon: meetings (navy), free stretches you
 * could think in (gold hatch), declined meetings (dashed ghost), and a live
 * "now" line. Hover or focus a block for what it is and a way in.
 *
 * Length encodes duration and nothing else. Free stretches are computed from
 * the calendar within your working hours — gaps of 30 minutes or more — never
 * guessed.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import type { CalendarEvent } from "@/lib/google/calendar";
import { buildBlocks, hhmm, localHours, parseHHMM, type Kind } from "@/lib/today/visual-data";

const STYLE: Record<Kind, React.CSSProperties> = {
  meeting: {
    backgroundColor: "#10213F", color: "#F6F1E7", border: "1px solid #10213F",
    backgroundImage: "linear-gradient(180deg, rgba(255,255,255,.12), rgba(255,255,255,0) 55%)",
  },
  free: {
    background: "repeating-linear-gradient(135deg, rgba(200,169,107,.42) 0 6px, rgba(200,169,107,.18) 6px 12px)",
    color: "#4A3712", border: "1px solid #C8A96B",
  },
  declined: { background: "rgba(246,241,231,.7)", color: "#4B5568", border: "1.5px dashed #8A8F99" },
};

export function DayRibbon({
  events, now, timeZone, connected, workStart, workEnd,
}: {
  events: CalendarEvent[];
  now: Date;
  timeZone?: string;
  connected: boolean;
  workStart?: string;
  workEnd?: string;
}) {
  const ws = parseHHMM(workStart, 9);
  const we = parseHHMM(workEnd, 18);
  const blocks = useMemo(() => buildBlocks(events, now, timeZone, ws, we), [events, now, timeZone, ws, we]);
  const startH = Math.min(8, Math.floor(Math.min(ws, ...blocks.map((b) => b.start))));
  const endH = Math.max(19, Math.ceil(Math.max(we, ...blocks.map((b) => b.end))));
  const span = endH - startH;
  const at = (h: number) => ((h - startH) / span) * 100;
  const nowH = localHours(now.toISOString(), timeZone);
  const nowIn = nowH >= startH && nowH <= endH;

  // Default focus: the next meeting, else the first block.
  const next = blocks.find((b) => b.kind === "meeting" && b.end > nowH) ?? blocks[0];
  const [focusId, setFocusId] = useState<string | null>(null);
  const focus = blocks.find((b) => b.id === focusId) ?? next;

  if (!connected) {
    return (
      <p className="text-[0.9375rem] text-[color:var(--w-ink-soft)]">
        Google Calendar is not connected, so Basil cannot see your day. This is not an empty schedule.{" "}
        <Link href="/dashboard/settings" className="font-semibold underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>Connect calendar</Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <div className="relative h-[132px] min-w-[720px]">
          {nowIn && (
            <span aria-hidden className="absolute left-0 top-[26px] h-[74px] rounded-l-[10px]"
              style={{ width: `${at(nowH)}%`, background: "repeating-linear-gradient(90deg, rgba(16,33,63,.05) 0 2px, transparent 2px 8px)" }} />
          )}
          {Array.from({ length: span + 1 }, (_, i) => startH + i).map((h) => (
            <span key={h}>
              <span aria-hidden className="absolute bottom-0 top-0 w-px" style={{ left: `${at(h)}%`, background: "rgba(16,33,63,.08)" }} />
              <span className="basil-mono absolute top-[108px] -translate-x-1/2 text-[11px] text-[color:var(--w-ink-soft)]" style={{ left: `${at(h)}%` }}>
                {String(h).padStart(2, "0")}:00
              </span>
            </span>
          ))}
          {blocks.map((b, i) => {
            const on = b.id === focus?.id;
            return (
              <button
                key={b.id}
                type="button"
                onMouseEnter={() => setFocusId(b.id)}
                onFocus={() => setFocusId(b.id)}
                onClick={() => setFocusId(b.id)}
                aria-label={`${b.title}, ${b.time}${b.kind === "declined" ? ", declined" : ""}`}
                className="basil-grow absolute top-[30px] flex h-[66px] flex-col justify-between overflow-hidden rounded-xl px-2.5 py-2 text-left transition-[translate,box-shadow] duration-200"
                style={{
                  ...STYLE[b.kind],
                  left: `${at(b.start)}%`,
                  width: `${Math.max(1.2, at(b.end) - at(b.start))}%`,
                  animationDelay: `${300 + i * 80}ms`,
                  translate: on ? "0 -6px" : "0 0",
                  boxShadow: on
                    ? "inset 0 1px 0 rgba(255,255,255,.18), 0 18px 30px -12px rgba(16,33,63,.6)"
                    : b.kind === "meeting" ? "inset 0 1px 0 rgba(255,255,255,.14), 0 6px 14px -8px rgba(16,33,63,.6)" : "0 4px 10px -8px rgba(16,33,63,.4)",
                }}
              >
                <span className="truncate text-[13px] font-semibold" style={{ textDecoration: b.kind === "declined" ? "line-through" : "none" }}>
                  {b.title}
                </span>
                <span className="basil-mono whitespace-nowrap text-[11px] opacity-80">{hhmm(b.start)}</span>
              </button>
            );
          })}
          {nowIn && (
            <>
              <span aria-hidden className="absolute top-[14px] h-[92px] w-[2px] rounded" style={{ left: `${at(nowH)}%`, background: "#C8A96B" }} />
              <span aria-hidden className="absolute top-[8px] -ml-[5px] h-3 w-3" style={{ left: `${at(nowH)}%` }}>
                <span className="basil-ping absolute inset-0 rounded-full" style={{ background: "#C8A96B" }} />
                <span className="absolute inset-0 rounded-full" style={{ background: "#C8A96B", boxShadow: "0 0 0 3px #FFFDF8" }} />
              </span>
              <span className="basil-mono absolute -top-[2px] ml-3 text-[11px] font-medium" style={{ left: `${at(nowH)}%`, color: "var(--w-carbon)" }}>
                now {hhmm(nowH)}
              </span>
            </>
          )}
        </div>
      </div>

      {focus ? (
        <div aria-live="polite" className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-[var(--w-rule)] bg-[var(--w-paper)] px-[18px] py-4">
          <span className="basil-mono min-w-[112px] text-[13px] text-[color:var(--w-ink-soft)]">{focus.time}</span>
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
            <span className="basil-serif text-[24px] leading-tight text-[#10213F]">{focus.title}</span>
            <span className="text-[14px] text-[color:var(--w-ink-soft)]">
              {focus.kind === "free" ? "Unbooked inside your working hours." : focus.kind === "declined" ? "You declined this one." : focus.who}
            </span>
          </div>
          {focus.href && (
            <Link href={focus.href} className="basil-lift inline-flex min-h-[44px] items-center rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] px-4 text-[14px] font-medium text-[#10213F]">
              {focus.cta}
            </Link>
          )}
        </div>
      ) : (
        <p className="text-[0.9375rem] text-[color:var(--w-ink-soft)]">Nothing on your calendar today.</p>
      )}
    </div>
  );
}

export { buildBlocks, localHours } from "@/lib/today/visual-data";
