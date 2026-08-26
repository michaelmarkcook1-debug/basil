"use client";

/**
 * The five headline counts.
 *
 * Every tile is a LINK to the thing it counts — a number you cannot click is
 * decoration, and that is the difference between this and the hero-metric
 * template the craft floor refuses by default.
 *
 * The unavailable state is the reason this component is not a loop over
 * `{label, count}`. "0 awaiting reply" and "Gmail is disconnected" are the same
 * integer and opposite facts, and a dashboard that renders the second as the
 * first is lying in the largest type on the page.
 */

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { Stat } from "@/lib/today/executive";

export function StatRow({ stats }: { stats: Stat[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((s) => (
        <li key={s.key}>
          <Link
            href={s.href}
            className="flex h-full min-h-[5.5rem] flex-col justify-between rounded-xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-3.5 py-3 transition-colors hover:border-[var(--w-rule-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {s.unavailable ? (
              <>
                <span className="flex items-center gap-1.5 text-[1.25rem] font-semibold leading-none text-[color:var(--w-manila)]">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                  <span aria-hidden>—</span>
                </span>
                <span className="mt-2 block">
                  <span className="block text-[0.8125rem] font-medium text-[color:var(--w-ink)]">{s.label}</span>
                  <span className="mt-0.5 block text-[0.6875rem] text-[color:var(--w-manila)]">{s.unavailable}</span>
                </span>
                <span className="sr-only">{s.label}: unknown. {s.unavailable}.</span>
              </>
            ) : (
              <>
                <span
                  className="wire-data text-[1.75rem] font-bold leading-none"
                  style={{ color: s.urgent ? "var(--w-stamp)" : "var(--w-ink)" }}
                >
                  {s.count}
                </span>
                <span className="mt-2 block">
                  <span className="block text-[0.8125rem] font-medium text-[color:var(--w-ink)]">{s.label}</span>
                  <span className="mt-0.5 block text-[0.6875rem] text-[color:var(--w-ink-soft)]">
                    {s.count === 0 ? "Nothing outstanding" : "View"}
                  </span>
                </span>
              </>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
