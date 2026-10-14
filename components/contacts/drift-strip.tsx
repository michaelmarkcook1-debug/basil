"use client";

/**
 * Time since you last spoke — everyone on one line.
 *
 *   x      = days since last contact (log scale: today, 1 day, 3 days, a week, two weeks, a month+)
 *   size   = messages in the last 30 days
 *   colour = tone towards you (quiet = dashed ring)
 *
 * The shaded right-hand zone is past a week: longer than most working
 * relationships go without a word. Hover a bubble to highlight that person in
 * the list; click to open them.
 */

import { useMemo } from "react";
import { TONE } from "@/components/today/v2/orbit";
import { driftX, laneFor, type Tone } from "@/lib/today/visual-data";

export interface DriftPerson { id: string; name: string; initials: string; days: number | null; volume: number; tone: Tone }

const TICKS = [
  { d: 0, label: "today" }, { d: 1, label: "1 day" }, { d: 3, label: "3 days" },
  { d: 7, label: "1 week" }, { d: 14, label: "2 weeks" }, { d: 30, label: "a month+" },
];

export function DriftStrip({
  people, hoveredId, selectedId, onHover, onSelect,
}: {
  people: DriftPerson[];
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const placed = useMemo(() => {
    const known = people.filter((p) => p.days !== null).sort((a, b) => (a.days as number) - (b.days as number));
    const xs = known.map((p) => driftX(p.days as number));
    const lanes = laneFor(xs, 4.5, 3);
    const maxVol = Math.max(1, ...known.map((p) => p.volume));
    return known.map((p, i) => ({ ...p, x: xs[i], lane: lanes[i], size: Math.round(24 + 16 * Math.sqrt(p.volume / maxVol)) }));
  }, [people]);
  const unknown = people.length - placed.length;

  return (
    <section aria-labelledby="drift-h" className="basil-rise mb-6 flex flex-col gap-2.5 rounded-[24px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-5 pb-4 pt-5 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2.5">
        <h2 id="drift-h" className="basil-serif text-[28px] text-[#10213F]">Time since you last spoke</h2>
        <span className="flex flex-wrap gap-3.5 text-[12px] text-[color:var(--w-ink-soft)]">
          {(["steady", "warmer", "cooler"] as const).map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: TONE[t].color }} />{TONE[t].label}</span>
          ))}
          <span className="inline-flex items-center gap-1.5"><span className="box-border h-2.5 w-2.5 rounded-full border-2 border-dashed border-[#8A8F99]" />Quiet</span>
          <span>· size = messages in 30 days</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="relative h-[224px] min-w-[680px]">
          <span aria-hidden className="absolute right-0 top-0 h-[190px] rounded-xl" style={{ left: `${driftX(7)}%`, background: "repeating-linear-gradient(135deg, rgba(217,102,31,.07) 0 8px, transparent 8px 16px)" }} />
          <span className="absolute bottom-[38px] right-2 text-[12px] text-[#8F3F0E]">longer than a week</span>
          {TICKS.map((t, i) => (
            <span key={t.d}>
              <span aria-hidden className="absolute top-0 h-[190px] w-px bg-[rgba(16,33,63,.1)]" style={{ left: `${driftX(t.d)}%` }} />
              <span
                className="basil-mono absolute top-[198px] whitespace-nowrap text-[11px] text-[color:var(--w-ink-soft)]"
                style={{ left: `${driftX(t.d)}%`, transform: i === 0 ? "none" : i === TICKS.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}
              >{t.label}</span>
            </span>
          ))}
          {placed.map((p, i) => {
            const lit = p.id === hoveredId || p.id === selectedId;
            const quiet = p.tone === "quiet";
            return (
              <button
                key={p.id}
                type="button"
                onMouseEnter={() => onHover(p.id)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(p.id)}
                onClick={() => onSelect(p.id)}
                aria-label={`${p.name}, ${TONE[p.tone].label.toLowerCase()}, last contact ${Math.round(p.days as number)} days ago`}
                className="basil-pop absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 border-0 bg-transparent p-0"
                style={{ left: `${Math.max(1.5, Math.min(98.5, p.x))}%`, top: 38 + p.lane * 58, animationDelay: `${200 + i * 40}ms` }}
              >
                <span
                  className={`box-border flex items-center justify-center rounded-full text-[11px] font-semibold transition-[transform,box-shadow] duration-200 ${quiet ? "" : "basil-sphere"}`}
                  style={{
                    width: p.size, height: p.size,
                    backgroundColor: quiet ? "#FFFDF8" : TONE[p.tone].color,
                    border: quiet ? "2px dashed #8A8F99" : "3px solid #FFFDF8",
                    color: quiet ? "#4B5568" : "#FFFFFF",
                    transform: `scale(${p.id === hoveredId ? 1.22 : p.id === selectedId ? 1.1 : 1})`,
                    boxShadow: lit
                      ? "0 0 0 3px #C8A96B, 0 12px 26px -8px rgba(16,33,63,.55)"
                      : "0 8px 16px -7px rgba(16,33,63,.5), inset 0 -2px 4px rgba(0,0,0,.18)",
                  }}
                >{p.initials}</span>
                <span className="whitespace-nowrap text-[11px] font-medium transition-colors" style={{ color: lit ? "#10213F" : "#4B5568" }}>{p.name.split(" ")[0]}</span>
              </button>
            );
          })}
        </div>
      </div>
      {unknown > 0 && <p className="text-[12px] text-[color:var(--w-ink-soft)]">{unknown} {unknown === 1 ? "person has" : "people have"} no contact recorded yet.</p>}
    </section>
  );
}
