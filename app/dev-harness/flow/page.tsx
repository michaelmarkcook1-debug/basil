"use client";

/**
 * DEV-ONLY harness for the shared flow components.
 *
 * The pages that use these are behind auth and read a store this environment
 * cannot decrypt, so this renders the real components in every state that
 * matters — including the ones that only appear during an outage, which are
 * otherwise unreachable without breaking a real integration.
 */

import { NeedsAttention } from "@/components/shared/needs-attention";
import { NextBestAction } from "@/components/shared/next-best-action";
import { RelationshipOverview } from "@/components/shared/relationship-overview";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

const CONTACTS = [
  { id: "1", name: "Daniel Okafor", title: "CFO, Northwind", initials: "DO", email: "d@e.com", lastInteraction: daysAgo(71) },
  { id: "2", name: "Mei Lin", title: "Partner, Aster", initials: "ML", email: "m@e.com", lastInteraction: daysAgo(44) },
  { id: "3", name: "Tom Bexley", title: "Head of Ops", initials: "TB", email: "t@e.com", lastInteraction: daysAgo(31) },
  { id: "4", name: "Ana Ruiz", title: "Counsel", initials: "AR", email: "a@e.com", lastInteraction: daysAgo(3) },
  { id: "5", name: "No History", title: "New contact", initials: "NH", email: "n@e.com", lastInteraction: null },
];

function Case({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-1 text-[0.8125rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--w-ink-soft)]">{title}</h2>
      {note && <p className="mb-2 text-[0.8125rem] text-[color:var(--w-ink-soft)]">{note}</p>}
      {children}
    </section>
  );
}

export default function FlowHarness() {
  if (process.env.NODE_ENV === "production") return null;
  return (
    <main className="wire min-h-full">
      <div className="mx-auto w-full max-w-[52rem] px-4 py-6">
        <p className="mb-5 inline-block rounded bg-[var(--w-stamp)] px-2 py-0.5 text-[0.6875rem] font-semibold text-white">
          HARNESS — synthetic data
        </p>

        <Case title="Needs attention — populated" note="The lead every list page now opens with.">
          <NeedsAttention buckets={[
            { label: "Overdue", count: 4, urgent: true },
            { label: "Due today", count: 2 },
            { label: "Needs review", count: 7 },
          ]} />
        </Case>

        <Case title="Needs attention — all clear" note="Zero counts, and the data was genuinely readable.">
          <NeedsAttention buckets={[{ label: "Overdue", count: 0 }]} allClear="Nothing overdue or due today. 12 commitments open further out." />
        </Case>

        <Case title="Needs attention — unavailable" note="Zero counts because nothing could be READ. Must never render as all-clear.">
          <NeedsAttention buckets={[{ label: "Overdue", count: 0 }]} unavailable="Commitments could not be read, so a zero count here would be a guess." />
        </Case>

        <Case title="Next best action" note="Extracted from Projects so every surface can use it.">
          <NextBestAction action="Circulate the revised board pack to Finance before Thursday." />
          <div className="mt-2">
            <NextBestAction action="Confirm the pricing owner." href="/dashboard/decisions" cta="Open decision" />
          </div>
        </Case>

        <Case title="Next best action — nothing recorded" note="An empty box would imply Basil considered the question and had no answer.">
          <NextBestAction action={null} />
        </Case>

        <Case title="Relationship overview" note="Replaces the 'Select a contact' placeholder on People. Ranked by a stored fact only.">
          <div className="rounded-lg border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-4">
            <RelationshipOverview contacts={CONTACTS} onSelect={() => {}} />
          </div>
        </Case>

        <Case title="Relationship overview — no history" note="Missing history is not a cold relationship.">
          <div className="rounded-lg border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-4">
            <RelationshipOverview contacts={[CONTACTS[4]]} onSelect={() => {}} />
          </div>
        </Case>
      </div>
    </main>
  );
}
