"use client";

/**
 * The top-left of Today: greeting, Basil's read of the day, and three counts.
 * Names in the read that match people in your orbit become chips — hover one
 * and that person lights up in the orbit beside it.
 */

import { Fragment, useMemo } from "react";
import type { SourceState } from "@/lib/today/executive";
import { splitByNames } from "@/lib/today/visual-data";

export interface StatTile { value: string; unit?: string; label: string; dark?: boolean }

export function ReadOfTheDay({
  greeting, name, dateLine, text, fromBriefing, people, focus, onFocus, stats, sources,
}: {
  greeting: string;
  name: string;
  dateLine: string;
  timeZone?: string;
  text: string;
  fromBriefing: boolean;
  people: string[];
  focus: string | null;
  onFocus: (name: string | null) => void;
  stats: StatTile[];
  sources: SourceState[];
}) {
  const runs = useMemo(() => splitByNames(text, people), [text, people]);
  const down = sources.filter((s) => !s.connected).map((s) => s.label);

  return (
    <section aria-label="Your day in one read" className="basil-rise flex min-w-0 flex-[1_1_520px] flex-col gap-5 pt-2">
      <span className="basil-mono inline-flex items-center gap-2.5 text-[12px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">
        <span className="relative h-2.5 w-2.5">
          <span className="basil-ping absolute inset-0 rounded-full bg-[#C8A96B]" />
          <span className="absolute inset-0 rounded-full bg-[#C8A96B]" />
        </span>
        {dateLine || " "}
      </span>
      <h1 className="basil-serif text-[56px] leading-[0.95] tracking-[-0.02em] text-[#10213F] sm:text-[84px]">
        {greeting},<br /><em className="italic">{name}</em><span className="text-[#C8A96B]">.</span>
      </h1>
      {text && (
        <p className="basil-serif max-w-[640px] text-[22px] leading-[1.4] text-[color:var(--w-ink)] sm:text-[27px]" style={{ textWrap: "pretty" }}>
          {runs.map((r, i) => r.person ? (
            <button
              key={i}
              type="button"
              onMouseEnter={() => onFocus(r.person!)}
              onMouseLeave={() => onFocus(null)}
              onFocus={() => onFocus(r.person!)}
              onBlur={() => onFocus(null)}
              className="mx-0.5 rounded-full border-0 px-3 py-0.5 align-[3px] font-sans text-[17px] font-medium transition-colors"
              style={{
                background: focus === r.person ? "#10213F" : "rgba(200,169,107,.22)",
                color: focus === r.person ? "#F6F1E7" : "#14213A",
              }}
            >
              {r.text}
            </button>
          ) : <Fragment key={i}>{r.text}</Fragment>)}
        </p>
      )}
      <p className="text-[12px] text-[color:var(--w-ink-soft)]">
        {fromBriefing ? "From this morning’s briefing." : "Basil’s read of your calendar and feed."}
        {down.length > 0 ? ` ${down.join(", ")} not connected, so this read is partial.` : ""}
      </p>
      <div className="flex flex-wrap gap-3">
        {stats.map((s) => (
          <div
            key={s.label}
            className="flex flex-[1_1_140px] flex-col gap-0.5 rounded-2xl px-[18px] py-3.5"
            style={s.dark ? { background: "#10213F" } : { background: "rgba(255,253,248,.85)", border: "1px solid var(--w-rule)" }}
          >
            <span className="basil-serif text-[44px] leading-none" style={{ color: s.dark ? "#D4B978" : "#10213F" }}>
              {s.value}{s.unit && s.value !== "—" ? <span className="text-[24px]">{s.unit}</span> : null}
            </span>
            <span className="text-[13px]" style={{ color: s.dark ? "rgba(246,241,231,.82)" : "var(--w-ink-soft)" }}>{s.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
