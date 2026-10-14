"use client";

/**
 * How you talk with someone, and how often — from the last 30 days of
 * interactions Basil already gathers (no extra fetch, nothing estimated).
 *
 *   How you talk  = email / Slack / meetings as one part-to-whole bar
 *   Your rhythm   = interactions per week for the last five weeks (hover a week)
 */

import { useState } from "react";
import { rampStep } from "@/lib/today/visual-data";

export interface ChannelMixLite { email: number; slack: number; meetings: number; other?: number }

const CH = [
  { key: "email", label: "Email", color: "#5865C2" },
  { key: "slack", label: "Slack", color: "#0E9E8A" },
  { key: "meetings", label: "Meetings", color: "#BE7A2A" },
] as const;

const RAMP = ["#A9B4CC", "#8392B4", "#5C6E98", "#384D7B", "#1B2E56"];

export function ConversationShape({ name, mix, weekly }: { name: string; mix?: ChannelMixLite; weekly?: number[] }) {
  const [week, setWeek] = useState<number | null>(null);
  if (!mix && !weekly) return null;
  const total = mix ? mix.email + mix.slack + mix.meetings : 0;
  const top = mix && total > 0 ? CH.reduce((a, b) => (mix[b.key] > mix[a.key] ? b : a)).label.toLowerCase() : null;
  const w = weekly ?? [];
  const maxW = Math.max(0, ...w);
  const shown = week ?? w.length - 1;

  return (
    <div className="flex flex-wrap gap-4">
      {mix && (
        <div className="basil-lift flex min-w-0 flex-[1_1_260px] flex-col gap-3 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5">
          <h3 className="basil-serif text-[22px] text-[#10213F]">How you talk</h3>
          {total === 0 ? (
            <p className="text-[14px] text-[color:var(--w-ink-soft)]">No messages or meetings with {name} in the last 30 days.</p>
          ) : (
            <>
              <div className="flex h-10 gap-[2px] overflow-hidden rounded-xl" role="img" aria-label={`Last 30 days with ${name}: ${mix.email} email, ${mix.slack} Slack, ${mix.meetings} meetings`}>
                {CH.map((c, i) => mix[c.key] > 0 && (
                  <span
                    key={c.key}
                    className="basil-grow flex items-center pl-2.5 text-[13px] font-semibold text-white"
                    style={{ width: `${(mix[c.key] / total) * 100}%`, background: c.color, animationDelay: `${300 + i * 100}ms` }}
                  >
                    {mix[c.key] / total >= 0.18 ? `${Math.round((mix[c.key] / total) * 100)}%` : ""}
                  </span>
                ))}
              </div>
              <div className="flex flex-col gap-1.5 text-[14px]">
                {CH.map((c) => (
                  <span key={c.key} className="flex items-center gap-2.5">
                    <span className="h-3 w-3 rounded-[3px]" style={{ background: c.color }} />{c.label}
                    <span className="basil-mono ml-auto">{mix[c.key]}</span>
                  </span>
                ))}
              </div>
              <p className="text-[13px] text-[color:var(--w-ink-soft)]">Mostly {top} with {name}, over the last 30 days.</p>
            </>
          )}
        </div>
      )}
      {w.length > 0 && (
        <div className="basil-lift flex min-w-0 flex-[1_1_260px] flex-col gap-3 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5">
          <h3 className="basil-serif text-[22px] text-[#10213F]">Your rhythm together</h3>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${w.length}, minmax(0, 1fr))` }}>
            {w.map((v, i) => {
              const step = rampStep(v, maxW);
              return (
                <button
                  key={i}
                  type="button"
                  onMouseEnter={() => setWeek(i)}
                  onFocus={() => setWeek(i)}
                  aria-label={`${w.length - 1 - i === 0 ? "This week" : `${w.length - 1 - i} weeks ago`}: ${v} interactions`}
                  className="box-border h-12 rounded-lg p-0 transition-[outline-color]"
                  style={{
                    background: step < 0 ? "transparent" : RAMP[step],
                    border: step < 0 ? "1px solid var(--w-rule)" : "0",
                    outline: i === shown ? "2px solid #C8A96B" : "2px solid transparent",
                    outlineOffset: 2,
                  }}
                />
              );
            })}
          </div>
          <div className="basil-mono flex justify-between text-[11px] text-[color:var(--w-ink-soft)]"><span>5 weeks ago</span><span>this week</span></div>
          <p className="text-[14px] text-[color:var(--w-ink)]" aria-live="polite">
            {w.length - 1 - shown === 0 ? "This week" : w.length - 1 - shown === 1 ? "Last week" : `${w.length - 1 - shown} weeks ago`}: {w[shown]} interaction{w[shown] === 1 ? "" : "s"}.
          </p>
        </div>
      )}
    </div>
  );
}
