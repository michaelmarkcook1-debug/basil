"use client";

/**
 * The lower panels: signal provenance, threads awaiting reply, relationship
 * attention, and what Basil did unattended.
 *
 * Each is a list of real records with a route out of it. None of them is a
 * summary card that has to be opened to be useful — that shape is why the page
 * read as a set of database views.
 */

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Card, Empty, Unavailable } from "./primitives";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import type { SignalSlice } from "@/lib/today/executive";
import type { TodayFeedItem } from "@/lib/today/types";

export function PanelFrame({
  title, href, cta, children,
}: { title: string; href?: string; cta?: string; children: React.ReactNode }) {
  const id = `p-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-[color:var(--w-carbon)]">
          {title}
        </h2>
        {href && cta && (
          <Link
            href={href}
            className="-mr-2 inline-flex min-h-[44px] items-center gap-0.5 px-2 text-[0.75rem] font-medium text-[color:var(--w-ink-soft)] hover:text-[color:var(--w-carbon)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 sm:min-h-[32px]"
          >
            {cta}
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
        )}
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/** Where today's signal came from. Bars, not a ring — see signalBreakdown(). */
export function SignalProvenance({
  slices, total, unavailable,
}: { slices: SignalSlice[]; total: number; unavailable?: string }) {
  if (unavailable) return <Unavailable what="Signal sources" why={unavailable} />;
  if (total === 0) return <Empty>No signal today from any connected source.</Empty>;

  const max = Math.max(...slices.map((s) => s.count), 1);
  const summary = slices.map((s) => `${s.source}: ${s.count}`).join(". ");

  return (
    <Card className="p-4">
      <p className="wire-data text-[1.75rem] font-bold leading-none text-[color:var(--w-ink)]">{total}</p>
      <p className="mt-1 text-[0.8125rem] text-[color:var(--w-ink-soft)]">
        signal{total === 1 ? "" : "s"} today, by source
      </p>
      <ul className="mt-3 space-y-2" role="img" aria-label={`Signals by source. ${summary}.`}>
        {slices.map((s) => (
          <li key={s.source} className="flex items-center gap-2.5">
            <span className="w-[4.5rem] shrink-0 truncate text-[0.75rem] text-[color:var(--w-ink)]">{s.source}</span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-sm bg-[var(--w-tray)]">
              <span
                className="block h-full rounded-sm"
                style={{ width: `${(s.count / max) * 100}%`, background: "var(--w-carbon)" }}
              />
            </span>
            <span className="wire-data w-6 shrink-0 text-right text-[0.75rem] font-bold text-[color:var(--w-ink)]">
              {s.count}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Threads where someone is waiting on the reader. */
export function ThreadsPanel({
  items, unavailable,
}: { items: TodayFeedItem[]; unavailable?: string }) {
  if (unavailable) return <Unavailable what="Threads" why={unavailable} />;
  if (items.length === 0) return <Empty>Nobody is waiting on a reply from you.</Empty>;

  return (
    <Card className="divide-y divide-[var(--w-rule)]">
      <ul className="divide-y divide-[var(--w-rule)]">
        {items.slice(0, 4).map((i) => {
          const f = i.kind === "followup" ? i.followup : null;
          return (
            <li key={i.id}>
              <Link
                href={i.href ?? "#"}
                className="block min-h-[44px] px-3.5 py-2.5 hover:bg-[var(--w-tray)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <p className="truncate text-[0.875rem] font-medium text-[color:var(--w-ink)]">{i.title}</p>
                <p className="mt-0.5 flex items-center gap-2 text-[0.75rem] text-[color:var(--w-ink-soft)]">
                  {f && <span className="truncate">{f.fromName}</span>}
                  {f && (
                    <span className="wire-data shrink-0 text-[color:var(--w-manila)]">
                      {f.hoursWaiting >= 24
                        ? `${Math.floor(f.hoursWaiting / 24)}d waiting`
                        : `${f.hoursWaiting}h waiting`}
                    </span>
                  )}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Who has gone quiet. Ranked by the engine's own score, not invented here. */
export function RelationshipPanel({
  items, unavailable,
}: { items: TodayFeedItem[]; unavailable?: string }) {
  if (unavailable) return <Unavailable what="Relationship signals" why={unavailable} />;
  if (items.length === 0) return <Empty>No relationship needs attention today.</Empty>;

  const initials = (n: string) =>
    n.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";

  return (
    <Card className="divide-y divide-[var(--w-rule)]">
      <ul className="divide-y divide-[var(--w-rule)]">
        {items.slice(0, 4).map((i) => {
          const name = i.title.replace(/\s*(has|have)\s+gone\s+quiet.*$/i, "").trim() || i.title;
          return (
            <li key={i.id}>
              <Link
                href={i.href ?? "/dashboard/contacts"}
                className="flex min-h-[44px] items-center gap-2.5 px-3.5 py-2.5 hover:bg-[var(--w-tray)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <ContactAvatar initials={initials(name)} color="" className="h-7 w-7 shrink-0" fallbackClassName="text-[0.625rem]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.875rem] font-medium text-[color:var(--w-ink)]">{name}</span>
                  <span className="block truncate text-[0.75rem] text-[color:var(--w-ink-soft)]">{i.subtitle}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * What Basil did while the reader was elsewhere.
 *
 * This is the panel the product most needs and the one most easily faked. It
 * shows counted records only — never a generated "insight" — because the whole
 * claim of an unattended assistant is that its report of its own work is true.
 */
export function IntelligencePanel({
  completedToday, inferred, unavailable,
}: { completedToday: number; inferred: number; unavailable?: string }) {
  if (unavailable) return <Unavailable what="Basil activity" why={unavailable} />;
  if (completedToday === 0 && inferred === 0) {
    return <Empty>Basil has recorded no activity today.</Empty>;
  }
  return (
    <Card className="p-4">
      <ul className="space-y-2.5">
        {completedToday > 0 && (
          <li className="flex items-baseline gap-2.5">
            <span className="wire-data text-[1.25rem] font-bold leading-none text-[color:var(--w-filed)]">
              {completedToday}
            </span>
            <span className="text-[0.8125rem] text-[color:var(--w-ink)]">
              commitment{completedToday === 1 ? "" : "s"} closed today
            </span>
          </li>
        )}
        {inferred > 0 && (
          <li className="flex items-baseline gap-2.5">
            <span className="wire-data text-[1.25rem] font-bold leading-none text-[color:var(--w-carbon)]">
              {inferred}
            </span>
            <span className="text-[0.8125rem] text-[color:var(--w-ink)]">
              signal{inferred === 1 ? "" : "s"} Basil inferred rather than observed
            </span>
          </li>
        )}
      </ul>
      <p className="mt-3 text-[0.75rem] text-[color:var(--w-ink-soft)]">
        Counted from stored records. Basil does not summarise its own work.
      </p>
    </Card>
  );
}
