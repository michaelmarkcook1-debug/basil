"use client";

/**
 * The executive read — the only place Today uses serif display type.
 *
 * Reserved for this one line by design: a serif that appears in six places is
 * decoration, and a page where everything is emphasised has no emphasis. This
 * is the sentence a reader takes away if they read nothing else.
 *
 * The text is composed from counted facts, never generated — see
 * operationalRead() for why a model call would be the wrong dependency here.
 */

import { ProvenanceIndicator } from "./primitives";
import type { SourceState } from "@/lib/today/executive";

export function OperationalRead({
  shape, risk, sources, now, generatedAt,
}: {
  shape: string;
  risk: string | null;
  sources: SourceState[];
  now: Date;
  generatedAt?: string;
}) {
  const missing = sources.filter((s) => !s.connected);
  return (
    <section aria-labelledby="read-h" className="rounded-lg border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 id="read-h" className="text-[1.0625rem] font-semibold text-[color:var(--w-ink)]">
          {now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
        </h1>
        <time
          dateTime={now.toISOString()}
          className="wire-data text-[0.8125rem] text-[color:var(--w-ink-soft)]"
        >
          {now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>

      <p className="basil-display mt-3 text-[1.375rem] sm:text-[1.625rem] leading-[1.35] text-[color:var(--w-ink)]">
        {shape}
      </p>
      {risk && (
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-[color:var(--w-ink)]">
          <span className="font-semibold">{risk}</span>
        </p>
      )}

      {/* Sourcing lives at the foot, quiet — available, never leading. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--w-rule)] pt-3">
        <ProvenanceIndicator provenance="observed" source="your connected accounts" at={generatedAt} />
        {missing.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium" style={{ color: "var(--w-manila)" }}>
            {missing.map((m) => m.label).join(", ")} not connected
          </span>
        )}
      </div>
    </section>
  );
}
