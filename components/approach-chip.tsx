"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Compass, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Approach chips — the influence layer made ambient (a Basil signature motif).
 *
 * Renders compact "how to approach this person" hints beside attendee/sender
 * names wherever action happens: meeting prep, signals, the brief. Backed by
 * GET /api/contacts/approach (no AI call — distilled from stored personality
 * intelligence), so it's cheap enough to mount anywhere. Renders nothing when
 * Basil has no profile for the names — never noise.
 */

export interface ApproachHint {
  name: string;
  contactId: string;
  hint: string | null;
  watchOut: string | null;
}

export function useApproachHints(names: string[]): ApproachHint[] {
  const [hints, setHints] = useState<ApproachHint[]>([]);
  const key = names.filter(Boolean).slice(0, 25).join(",");

  useEffect(() => {
    if (!key) { setHints([]); return; }
    let active = true;
    fetch(`/api/contacts/approach?names=${encodeURIComponent(key)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { hints?: ApproachHint[] } | null) => {
        if (active && d?.hints) setHints(d.hints);
      })
      .catch(() => { /* hints are an enhancement — absence is fine */ });
    return () => { active = false; };
  }, [key]);

  return hints;
}

export function ApproachChip({ hint, className }: { hint: ApproachHint; className?: string }) {
  return (
    <Link
      href="/dashboard/contacts"
      title={`Open ${hint.name} in People`}
      className={cn(
        "group relative inline-flex max-w-full items-start gap-1.5 rounded-lg border border-[var(--w-rule)] bg-[var(--w-carbon-tint)] px-2.5 py-1.5",
        "text-xs leading-snug text-foreground/80 transition-colors hover:border-[var(--w-rule)] hover:bg-[var(--w-carbon-tint)]",
        className
      )}
    >
      {/* Gold corner tick — quietly signals "Basil knows this person" */}
      <span aria-hidden className="absolute right-0 top-0 h-0 w-0 rounded-tr-lg border-l-[7px] border-t-[7px] border-l-transparent border-t-gold/60" />
      <Compass size={13} strokeWidth={1.8} className="mt-px shrink-0 text-[var(--w-carbon)]" />
      <span className="min-w-0">
        <span className="font-semibold text-[var(--w-carbon)]">{hint.name.split(" ")[0]}</span>
        {hint.hint && <span> — {hint.hint}</span>}
        {hint.watchOut && (
          <span className="mt-0.5 flex items-start gap-1 text-foreground/60">
            <AlertTriangle size={11} strokeWidth={1.8} className="mt-0.5 shrink-0 text-signal-warning" />
            {hint.watchOut}
          </span>
        )}
      </span>
    </Link>
  );
}

/** Convenience strip: fetches + renders chips for a list of attendee/sender names. */
export function ApproachChips({ names, className }: { names: string[]; className?: string }) {
  const hints = useApproachHints(names);
  if (hints.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {hints.map((h) => (
        <ApproachChip key={h.contactId} hint={h} />
      ))}
    </div>
  );
}
