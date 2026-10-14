"use client";

/**
 * Your orbit: the people you work with, placed around you.
 *
 *   distance = time since you last spoke (closer = more recent, log scale)
 *   size     = how much you talk (messages in 30 days)
 *   colour   = tone towards you (steady / warmer / cooler; quiet = dashed ring)
 *
 * The constellation turns slowly and stops while you hover. Hovering or
 * focusing a person (here, or anywhere on Today that names them) lights their
 * line and shows the card underneath: tone, last contact, and how to land it.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useTilt, Sheen } from "@/components/basil/tilt";
import { placeOrbit, type OrbitPerson, type Tone } from "@/lib/today/visual-data";

export { orbitTone, type OrbitPerson, type Tone, type SentimentRow } from "@/lib/today/visual-data";

export const TONE: Record<Tone, { label: string; color: string; text: string }> = {
  steady: { label: "Steady", color: "#1F8A70", text: "#145E4C" },
  warmer: { label: "Warmer", color: "#2F5FA8", text: "#24497F" },
  cooler: { label: "Cooler", color: "#D9661F", text: "#8F3F0E" },
  quiet: { label: "Quiet", color: "#8A8F99", text: "#4B5568" },
};

const W = 440, H = 380, CX = 220, CY = 190;
const RINGS = [{ r: 75, label: "today" }, { r: 120, label: "this week" }, { r: 170, label: "this month" }];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "·";
  return parts.length === 1 ? parts[0].slice(0, 2) : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Orbit({
  people, focus, onFocus,
}: {
  people: OrbitPerson[];
  focus: string | null;
  onFocus: (name: string | null) => void;
}) {
  const placed = useMemo(() => placeOrbit(people.slice(0, 12)), [people]);
  const shown = placed.find((p) => p.name === focus) ?? placed[0];
  const tilt = useTilt(2.5);

  return (
    <section
      aria-label="Your orbit: who you are closest to right now"
      className="basil-sky basil-rise basil-tilt relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-[24px] bg-[#10213F] px-[22px] pb-[18px] pt-[22px] text-[#F6F1E7]"
      style={{ animationDelay: "120ms" }}
      onMouseMove={tilt.onMouseMove}
      onMouseLeave={(e) => { onFocus(null); tilt.onMouseLeave(e); }}
    >
      <Sheen />
      <span aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(420px 300px at 50% 46%, rgba(212,185,120,.16), transparent 70%)" }} />
      {[[12, 22, 0], [86, 30, 1.2], [78, 82, 2.1], [8, 74, 0.6]].map(([l, t, d]) => (
        <span key={`${l}-${t}`} aria-hidden className="basil-star absolute h-[3px] w-[3px] rounded-full bg-[#F6F1E7]" style={{ left: `${l}%`, top: `${t}%`, animationDelay: `${d}s` }} />
      ))}
      <div className="relative flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="basil-serif text-[28px]">Your orbit</h2>
        <span className="text-[12px] text-[rgba(246,241,231,.72)]">closer = spoke more recently · size = how much</span>
      </div>

      {placed.length === 0 ? (
        <p className="relative py-16 text-center text-[14px] text-[rgba(246,241,231,.8)]">
          Basil hasn’t seen enough of your conversations yet to place anyone.
        </p>
      ) : (
        <div className="relative mx-auto w-full max-w-[460px]" style={{ aspectRatio: `${W} / ${H}` }}>
          <svg viewBox={`0 0 ${W} ${H}`} aria-hidden className="absolute inset-0 h-full w-full overflow-visible">
            {RINGS.map((g) => (
              <g key={g.r}>
                <circle cx={CX} cy={CY} r={g.r} fill="none" stroke="rgba(246,241,231,.12)" strokeDasharray="2 5" />
                <text x={CX + g.r * 0.71 + 4} y={CY - g.r * 0.71 - 4} textAnchor="start" fontSize="10" fill="rgba(246,241,231,.5)" style={{ fontFamily: "var(--font-geist-mono)" }}>{g.label}</text>
              </g>
            ))}
          </svg>
          <div className="basil-orbit absolute inset-0">
            <svg viewBox={`0 0 ${W} ${H}`} aria-hidden className="absolute inset-0 h-full w-full overflow-visible">
              {placed.map((p) => {
                const on = p.name === shown?.name && focus !== null;
                return (
                  <line
                    key={p.name}
                    x1={CX} y1={CY} x2={p.x} y2={p.y}
                    stroke={on ? "#D4B978" : "rgba(246,241,231,.2)"}
                    strokeWidth={on ? p.width + 1.5 : p.width}
                    strokeDasharray={p.tone === "quiet" ? "3 5" : undefined}
                    strokeLinecap="round"
                    style={{ transition: "stroke .25s, stroke-width .25s" }}
                  />
                );
              })}
            </svg>
            {placed.map((p) => {
              const on = p.name === focus;
              const quiet = p.tone === "quiet";
              return (
                <button
                  key={p.name}
                  type="button"
                  onMouseEnter={() => onFocus(p.name)}
                  onFocus={() => onFocus(p.name)}
                  onClick={() => onFocus(p.name)}
                  aria-label={`${p.name}, ${TONE[p.tone].label.toLowerCase()}${p.lastLabel ? `, last contact ${p.lastLabel}` : ""}`}
                  className="absolute border-0 bg-transparent p-0 text-[#F6F1E7] transition-transform duration-200"
                  style={{ left: `${p.left}%`, top: `${p.top}%`, transform: `translate(-50%, -50%) scale(${on ? 1.25 : 1})` }}
                >
                  <span className="basil-counter flex flex-col items-center gap-1">
                    <span
                      className={`box-border flex items-center justify-center rounded-full text-[11px] font-semibold text-white transition-shadow ${quiet ? "" : "basil-sphere"}`}
                      style={{
                        width: p.size, height: p.size,
                        backgroundColor: quiet ? "rgba(16,33,63,.6)" : TONE[p.tone].color,
                        border: quiet ? "2px dashed rgba(246,241,231,.7)" : "2px solid rgba(246,241,231,.85)",
                        boxShadow: on
                          ? "0 0 0 4px rgba(212,185,120,.9), 0 0 26px rgba(212,185,120,.8)"
                          : quiet ? "none" : "0 8px 16px -6px rgba(0,0,0,.55), inset 0 -2px 4px rgba(0,0,0,.2)",
                      }}
                    >
                      {initials(p.name)}
                    </span>
                    <span className="whitespace-nowrap text-[11px] font-medium" style={{ color: on ? "#D4B978" : "rgba(246,241,231,.78)" }}>
                      {p.name.split(" ")[0]}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2">
            <span className="basil-ping absolute inset-0 rounded-full" style={{ background: "rgba(212,185,120,.5)" }} />
            <span className="basil-sphere absolute inset-0 flex items-center justify-center rounded-full text-[14px] font-semibold text-[#10213F]" style={{ backgroundColor: "#D4B978", boxShadow: "0 0 0 4px #10213F, 0 0 30px rgba(212,185,120,.6)" }}>You</span>
          </div>
        </div>
      )}

      {shown && (
        <div className="relative flex min-h-[76px] items-start gap-3.5 rounded-2xl border border-[rgba(212,185,120,.25)] bg-[rgba(246,241,231,.07)] px-4 py-3.5" aria-live="polite">
          <span
            className="mt-1.5 h-3 w-3 shrink-0 rounded-full"
            style={{ background: shown.tone === "quiet" ? "transparent" : TONE[shown.tone].color, border: shown.tone === "quiet" ? "2px dashed #F6F1E7" : "0" }}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-baseline gap-2">
              <span className="basil-serif text-[24px]">{shown.name}</span>
              <span className="text-[12px] text-[rgba(246,241,231,.75)]">
                {TONE[shown.tone].label}{shown.lastLabel ? ` · last contact ${shown.lastLabel}` : ""}
              </span>
            </span>
            {shown.howTo ? (
              <span className="text-[14px] leading-snug text-[rgba(246,241,231,.9)]"><span className="text-[#D4B978]">How to land it:</span> {shown.howTo}</span>
            ) : (
              <span className="text-[14px] text-[rgba(246,241,231,.75)]">No profile yet. Basil builds one as you talk.</span>
            )}
          </div>
          <Link href={shown.href ?? "/dashboard/contacts"} className="self-center whitespace-nowrap text-[13px] text-[#D4B978] no-underline">Profile →</Link>
        </div>
      )}
    </section>
  );
}
