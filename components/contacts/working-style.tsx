"use client";

/** "How to work with them" — the user-manual fields of a profile, each with its sources. */

import { CitedField, type Verdicts } from "@/components/contacts/cited-field";
import type { ProfileEvidence, WorkingField, WorkingStyle } from "@/lib/contacts/profile-evidence";

const ROWS: ReadonlyArray<[WorkingField, string]> = [
  ["reachThem", "Reaching them"],
  ["decides", "How they decide"],
  ["badNews", "Bad news and a no"],
  ["silence", "When they go quiet"],
];

export function WorkingStyleBlock({ style, evidence, bare = false, contactId, verdicts }: { style: WorkingStyle; evidence?: ProfileEvidence; bare?: boolean; contactId?: string; verdicts?: Verdicts }) {
  return (
    <div className="flex flex-col gap-3">
      {!bare && <p className="text-[12px] font-semibold tracking-widest uppercase text-[color:var(--w-carbon)]">How to work with them</p>}
      {style.howToLandIt && (
        <div className="rounded-lg bg-[var(--w-tray)] px-3 py-2">
          <p className="text-[11.5px] font-semibold uppercase tracking-wider text-[color:var(--w-carbon)]">How to land it</p>
          <CitedField field="howToLandIt" text={style.howToLandIt} evidence={evidence} contactId={contactId} verdicts={verdicts} className="basil-serif text-[17px] italic leading-snug text-[color:var(--w-ink)]" />
        </div>
      )}
      {ROWS.map(([field, label]) => style[field] ? (
        <div key={field}>
          <p className="text-[12px] font-semibold text-[color:var(--w-ink)]">{label}</p>
          <CitedField field={field} text={style[field]} evidence={evidence} contactId={contactId} verdicts={verdicts} className="text-sm leading-relaxed text-foreground/90" />
        </div>
      ) : null)}
    </div>
  );
}
