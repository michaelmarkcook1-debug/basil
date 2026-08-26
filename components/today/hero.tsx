"use client";

/**
 * The executive hero: greeting, the read, and the botanical mark behind it.
 *
 * ONE DEVIATION FROM THE REFERENCE, stated rather than smuggled. The reference
 * puts a small uppercase "GOOD MORNING" above a large "Michael." That is a
 * kicker, and it is the single element the craft floor bans outright rather than
 * merely discouraging — the heading carries its own weight, and a label above it
 * is a line the eye must cross to reach the thing it already understood. So the
 * greeting became the heading: one serif line at display size. Same words, same
 * impact, no eyebrow.
 *
 * The mark is a real vector from the brand set, not a decorative texture — the
 * craft floor allows a background only when it comes from the subject's own
 * world. It sits at low opacity, is aria-hidden, and never sits under body copy:
 * contrast is measured against the canvas, so anything that could alter the
 * effective background under text would invalidate the whole palette audit.
 */

import { ProvenanceIndicator } from "./primitives";
import type { SourceState } from "@/lib/today/executive";

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Hero({
  name, shape, risk, sources, now, generatedAt,
}: {
  name: string;
  shape: string;
  risk: string | null;
  sources: SourceState[];
  now: Date;
  generatedAt?: string;
}) {
  const missing = sources.filter((s) => !s.connected);

  return (
    <section
      aria-labelledby="hero-h"
      className="relative overflow-hidden rounded-2xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-5 py-6 sm:px-8 sm:py-8"
    >
      {/* The mark. Anchored to the top-right and clipped by the panel, so it
          reads as a watermark on the sheet rather than a sticker placed on it. */}
      <img
        src="/brand/basil-botanical-mark.svg"
        alt=""
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-14 h-[15rem] w-[15rem] select-none opacity-[0.07] sm:-right-6 sm:h-[19rem] sm:w-[19rem]"
      />

      <div className="relative">
        <h1
          id="hero-h"
          className="basil-display text-[2rem] leading-[1.1] tracking-[-0.02em] text-[color:var(--w-ink)] sm:text-[2.75rem]"
        >
          {greeting(now)}, {name}.
        </h1>

        <p className="mt-3 max-w-[62ch] text-[1rem] leading-relaxed text-[color:var(--w-ink)] sm:text-[1.0625rem]">
          {shape}
        </p>
        {risk && (
          <p className="mt-1.5 max-w-[62ch] text-[0.9375rem] font-semibold leading-relaxed text-[color:var(--w-ink)]">
            {risk}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--w-rule)] pt-3.5">
          <time dateTime={now.toISOString()} className="wire-data text-[0.75rem] text-[color:var(--w-ink-soft)]">
            {now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
            {" · "}
            {now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          </time>
          <ProvenanceIndicator provenance="observed" source="your connected accounts" at={generatedAt} />
          {missing.length > 0 && (
            <span className="text-[0.6875rem] font-medium text-[color:var(--w-manila)]">
              {missing.map((m) => m.label).join(", ")} not connected
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
