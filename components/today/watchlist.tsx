"use client";

/**
 * Everything that is real but not now.
 *
 * Collapsed by default and filterable. The point is not to hide work — it is
 * that a list of eighteen equally-weighted items is a list nobody reads, so
 * the three that matter have to be somewhere else. Nothing is dropped; the
 * count is always on the label.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { UrgencyBadge, ProvenanceIndicator, Card } from "./primitives";
import type { Priority } from "@/lib/today/executive";

type Filter = "all" | "relationships" | "meetings" | "commitments" | "projects" | "communications";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "relationships", label: "Relationships" },
  { key: "commitments", label: "Commitments" },
  { key: "projects", label: "Projects" },
  { key: "communications", label: "Communications" },
  { key: "meetings", label: "Meetings" },
];

/** Bucket by the ORIGINATING STORE, which is a fact, not a topic guess. */
function bucketOf(p: Priority): Filter {
  switch (p.source) {
    case "Contacts": return "relationships";
    case "Commitments": return "commitments";
    case "Linear": return "projects";
    case "Gmail":
    case "Slack": return "communications";
    case "Decisions": return "commitments";
    default: return "all";
  }
}

export function Watchlist({ items }: { items: Priority[] }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: items.length };
    for (const p of items) {
      const b = bucketOf(p);
      c[b] = (c[b] ?? 0) + 1;
    }
    return c;
  }, [items]);

  const shown = filter === "all" ? items : items.filter((p) => bucketOf(p) === filter);
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="watch-h" className="mt-6">
      <h2 id="watch-h" className="sr-only">Watchlist</h2>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="watchlist-body"
        className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <span className="text-[0.9375rem] font-semibold text-[color:var(--w-ink)]">
          Watchlist — {items.length} more
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-[color:var(--w-ink-soft)] motion-safe:transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      <div id="watchlist-body" hidden={!open} className="mt-2">
        <div role="group" aria-label="Filter watchlist" className="flex flex-wrap gap-1.5">
          {FILTERS.filter((f) => f.key === "all" || (counts[f.key] ?? 0) > 0).map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={active}
                className="min-h-[44px] sm:min-h-[32px] rounded-md border px-3 text-[0.8125rem] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={active
                  ? { background: "var(--w-carbon)", color: "var(--w-on-accent)", borderColor: "var(--w-carbon)" }
                  : { borderColor: "var(--w-rule-strong)", color: "var(--w-ink)" }}
              >
                {f.label} <span className="wire-data">{counts[f.key] ?? 0}</span>
              </button>
            );
          })}
        </div>

        {shown.length === 0 ? (
          <Card className="mt-2 p-4">
            <p className="text-[0.875rem] text-[color:var(--w-ink-soft)]">Nothing in this category.</p>
          </Card>
        ) : (
          <Card className="mt-2 divide-y divide-[var(--w-rule)]">
            <ul className="divide-y divide-[var(--w-rule)]">
              {shown.map((p) => (
                <li key={p.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <UrgencyBadge urgency={p.urgency} />
                    {p.href ? (
                      <Link href={p.href} className="text-[0.9375rem] font-medium text-[color:var(--w-ink)] underline-offset-2 hover:underline">
                        {p.title}
                      </Link>
                    ) : (
                      <span className="text-[0.9375rem] font-medium text-[color:var(--w-ink)]">{p.title}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[0.875rem] text-[color:var(--w-ink-soft)]">{p.why}</p>
                  <ProvenanceIndicator className="mt-1" provenance={p.provenance} source={p.source} at={p.occurredAt} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </section>
  );
}
