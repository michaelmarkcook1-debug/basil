"use client";

/**
 * components/shared/relationship-overview.tsx
 *
 * What the People page shows before you have picked anyone.
 *
 * It previously showed a grey icon and "Select a contact" — a whole panel of
 * screen explaining the interaction model to someone who had already worked it
 * out. The most useful thing a relationship surface can say unprompted is which
 * relationships have gone quiet, so that is what it says.
 *
 * HONESTY: ranked purely by days since the last recorded interaction, which is
 * a stored fact. There is deliberately NO importance or health score — no such
 * field exists, and a number that looks computed but is invented is worse than
 * no number. Someone you last spoke to 60 days ago may matter enormously or not
 * at all; this says only how long it has been.
 */

import { ContactAvatar } from "@/components/ui/contact-avatar";

export interface QuietContact {
  id: string;
  name: string;
  title?: string;
  initials: string;
  color?: string;
  email?: string;
  lastInteraction: string | null;
}

const DAY = 86_400_000;

export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / DAY);
}

export function RelationshipOverview({
  contacts, onSelect, photos = {}, quietAfterDays = 30, limit = 6,
}: {
  contacts: QuietContact[];
  onSelect: (id: string) => void;
  photos?: Record<string, string>;
  quietAfterDays?: number;
  limit?: number;
}) {
  const withDays = contacts
    .map((c) => ({ c, days: daysSince(c.lastInteraction) }))
    .filter((x): x is { c: QuietContact; days: number } => x.days !== null);

  const quiet = withDays
    .filter((x) => x.days >= quietAfterDays)
    .sort((a, b) => b.days - a.days);

  // Contacts Basil has never seen an interaction for are counted separately.
  // Folding them into "quiet" would imply a relationship went cold when Basil
  // may simply have no record of it — a different claim entirely.
  const noRecord = contacts.length - withDays.length;

  return (
    <div className="mx-auto w-full max-w-xl py-6">
      <h2 className="text-[1.0625rem] font-semibold text-[var(--w-ink)]">Relationship health</h2>
      <p className="mt-1 text-[0.875rem] text-[var(--w-ink-soft)]">
        Ranked by time since the last recorded interaction. Basil does not score
        importance — only how long it has been.
      </p>

      {quiet.length === 0 ? (
        <p className="mt-4 rounded-lg border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-4 text-[0.875rem] text-[var(--w-ink)]">
          {withDays.length === 0
            ? "No interaction history recorded yet, so Basil cannot tell which relationships have gone quiet."
            : `Nobody has gone quiet for more than ${quietAfterDays} days.`}
        </p>
      ) : (
        <>
          <p className="mt-4 text-[0.875rem] font-semibold text-[var(--w-ink)]">
            {quiet.length} {quiet.length === 1 ? "person has" : "people have"} gone quiet for
            more than {quietAfterDays} days
          </p>
          <ul className="mt-2 divide-y divide-[var(--w-rule)] overflow-hidden rounded-lg border border-[var(--w-rule)] bg-[var(--w-flimsy)]">
            {quiet.slice(0, limit).map(({ c, days }) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className="flex w-full min-h-[44px] items-center gap-3 px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 hover:bg-[var(--w-tray)]"
                >
                  <ContactAvatar
                    initials={c.initials}
                    color={c.color ?? ""}
                    photoUrl={photos[c.email?.toLowerCase() ?? ""]}
                    className="h-8 w-8 shrink-0"
                    fallbackClassName="text-xs"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.9375rem] font-medium text-[var(--w-ink)]">{c.name}</span>
                    {c.title && (
                      <span className="block truncate text-[0.8125rem] text-[var(--w-ink-soft)]">{c.title}</span>
                    )}
                  </span>
                  <span className="wire-data shrink-0 text-[0.8125rem] font-semibold" style={{ color: days >= 60 ? "var(--w-stamp)" : "var(--w-manila)" }}>
                    {days}d
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {noRecord > 0 && (
        <p className="mt-3 text-[0.8125rem] text-[var(--w-ink-soft)]">
          {noRecord} contact{noRecord === 1 ? " has" : "s have"} no recorded interaction, so
          they are not ranked here. That is missing history, not a cold relationship.
        </p>
      )}
    </div>
  );
}
