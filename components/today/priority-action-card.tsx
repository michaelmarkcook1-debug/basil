"use client";

/**
 * One decision, stated as a decision.
 *
 * The old row gave you a headline, a wire name and a filed time — everything
 * except what to do about it. This leads with urgency and the action, gives one
 * sentence of consequence, then the controls. Sourcing is last.
 */

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { UrgencyBadge, urgencyRule, ProvenanceIndicator, Card } from "./primitives";
import type { Priority } from "@/lib/today/executive";

export function PriorityActionCard({
  priority: p, primaryLabel = "Open", onBrief,
}: {
  priority: Priority;
  primaryLabel?: string;
  onBrief?: (p: Priority) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailId = `why-${p.id.replace(/[^a-z0-9]/gi, "-")}`;

  return (
    <Card className="p-4 sm:p-5 border-l-4" style={{ borderLeftColor: urgencyRule(p.urgency) }}>
      <div className="flex flex-wrap items-center gap-2">
        <UrgencyBadge urgency={p.urgency} />
        {p.groupedCount && (
          <span className="rounded border border-[var(--w-rule-strong)] bg-[var(--w-tray)] px-1.5 py-0.5 text-[0.6875rem] font-medium text-[color:var(--w-ink-soft)]">
            {p.groupedCount} signals grouped
          </span>
        )}
      </div>

      <h3 className="mt-2 text-[1.0625rem] font-semibold leading-snug text-[color:var(--w-ink)]">
        {p.title}
      </h3>
      <p className="mt-1 text-[0.9375rem] leading-relaxed text-[color:var(--w-ink-soft)]">
        {p.why}
      </p>
      {p.context && (
        <p className="mt-1.5 text-[0.8125rem] font-medium text-[color:var(--w-carbon)]">{p.context}</p>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {p.href && (
          <Link
            href={p.href}
            className="inline-flex min-h-[44px] sm:min-h-[36px] items-center rounded-md px-3.5 text-[0.875rem] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ background: "var(--w-carbon)", color: "var(--w-on-accent)" }}
          >
            {primaryLabel}
          </Link>
        )}
        <button
          type="button"
          onClick={() => { setOpen((v) => !v); onBrief?.(p); }}
          aria-expanded={open}
          aria-controls={detailId}
          className="inline-flex min-h-[44px] sm:min-h-[36px] items-center gap-1 rounded-md border border-[var(--w-rule-strong)] px-3 text-[0.875rem] font-medium text-[color:var(--w-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Why?
          <ChevronDown className={`h-4 w-4 motion-safe:transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      </div>

      <div id={detailId} hidden={!open} className="mt-3 border-t border-[var(--w-rule)] pt-3">
        {p.members && p.members.length > 0 ? (
          <ul className="space-y-2">
            {p.members.map((m) => (
              <li key={m.id} className="text-[0.875rem]">
                {m.href ? (
                  <Link href={m.href} className="font-medium text-[color:var(--w-carbon)] underline underline-offset-2">
                    {m.title}
                  </Link>
                ) : (
                  <span className="font-medium text-[color:var(--w-ink)]">{m.title}</span>
                )}
                <span className="text-[color:var(--w-ink-soft)]"> — {m.subtitle}</span>
              </li>
            ))}
          </ul>
        ) : p.detail ? (
          <p className="text-[0.875rem] text-[color:var(--w-ink)]">{p.detail}</p>
        ) : (
          <p className="text-[0.875rem] text-[color:var(--w-ink-soft)]">
            No further detail is stored for this signal.
          </p>
        )}
        <ProvenanceIndicator className="mt-2" provenance={p.provenance} source={p.source} at={p.occurredAt} />
      </div>

      {!open && (
        <ProvenanceIndicator className="mt-3" provenance={p.provenance} source={p.source} at={p.occurredAt} />
      )}
    </Card>
  );
}
