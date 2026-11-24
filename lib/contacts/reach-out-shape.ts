/**
 * lib/contacts/reach-out-shape.ts — the weekly "reach out to" push (audit
 * 2026-11-24, Part 3 entry 16). Pure; lib/contacts/reach-out.ts gathers the
 * delta engine's relationship signals and app/api/cron/reminders sends.
 *
 * Today already showed "gone quiet" and "cooling" cards, but only to a user
 * who opened Basil. Once a week, an hour into the first working day, the
 * strongest of them become one push: people past a keep-in-touch cadence the
 * user set, key people quiet for 14+ days, and anyone whose tone is cooling.
 * At most 5 names; nothing when there is no one.
 */
import type { ChangeEvent } from "@/lib/delta/types";

export const MAX_PEOPLE = 5;

export interface ReachOut { name: string; why: string; severity: ChangeEvent["severity"] }

export function reachOutList(changes: readonly ChangeEvent[]): ReachOut[] {
  const seen = new Set<string>();
  const out: ReachOut[] = [];
  const ranked = [...changes]
    .filter((c) => c.category === "relationship" && (c.severity === "critical" || c.severity === "high")
      && (c.title === "Stakeholder has gone quiet" || c.title === "Stakeholder cooling"))
    .sort((a, b) => b.score - a.score);
  for (const c of ranked) {
    const name = (c.subject ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const days = /(\d+) days/.exec(c.context)?.[1];
    const why = c.title === "Stakeholder cooling" ? "tone cooling" : /asked to stay in touch every (\d+) days/.test(c.context)
      ? `${days ?? "?"} days, you said every ${/every (\d+) days/.exec(c.context)?.[1]}`
      : `${days ?? "?"} days quiet`;
    out.push({ name, why, severity: c.severity });
    if (out.length >= MAX_PEOPLE) break;
  }
  return out;
}

export function reachOutNotification(list: readonly ReachOut[]): { kind: "relationships"; title: string; body: string; url: string; tag: string } | null {
  if (!list.length) return null;
  const first = (n: string) => n.split(/\s+/)[0];
  const body = list.map((p) => `${first(p.name)} (${p.why})`).join(", ");
  return {
    kind: "relationships",
    title: list.length === 1 ? `Reach out to ${list[0].name} this week` : `Reach out to ${list.length} people this week`,
    body: (body.length > 170 ? `${body.slice(0, 169)}…` : body) + ". Ask Basil for a note to any of them.",
    url: "/dashboard/contacts",
    tag: "basil-reach-out",
  };
}
