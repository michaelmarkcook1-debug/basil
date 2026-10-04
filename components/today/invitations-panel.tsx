"use client";

/**
 * Invitations waiting for an answer, answered in place. Renders nothing when
 * there are none — an empty "nothing to RSVP" panel is noise.
 */
import useSWR from "swr";
import { useState } from "react";
import { PanelFrame } from "./panels";
import { Card } from "./primitives";
import { RsvpControls, type RsvpEvent } from "@/components/calendar/rsvp-controls";
import { needsAnswer } from "@/lib/calendar/invitations";

interface UpcomingEvent extends RsvpEvent { dateLabel?: string }


const when = (e: UpcomingEvent) => {
  const s = new Date(e.start);
  const day = e.dateLabel ?? s.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return e.isAllDay ? `${day}, all day` : `${day}, ${s.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};

export function InvitationsPanel() {
  const { data } = useSWR<{ events?: UpcomingEvent[] }>(
    "/api/calendar/upcoming",
    (u: string) => fetch(u).then((r) => (r.ok ? r.json() : { events: [] })),
    { revalidateOnFocus: false },
  );
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const pending = (data?.events ?? []).filter((e) => needsAnswer(e) && !answered.has(e.id));
  if (pending.length === 0) return null;

  return (
    <div className="mt-6">
      <PanelFrame title={`Invitations to answer (${pending.length})`} href="/dashboard/meetings" cta="All meetings">
        <Card>
          <ul className="divide-y divide-[var(--w-rule)]">
            {pending.slice(0, 5).map((e) => (
              <li key={e.id} className="space-y-1.5 px-3.5 py-2.5">
                <p className="text-[0.875rem] font-medium text-[color:var(--w-ink)]">{e.summary}</p>
                <p className="text-[0.75rem] text-[color:var(--w-ink-soft)]">
                  {when(e)}{e.organizerName || e.organizerEmail ? ` · from ${e.organizerName || e.organizerEmail}` : ""}
                </p>
                <RsvpControls compact event={e} onChanged={() => setAnswered((s) => new Set(s).add(e.id))} />
              </li>
            ))}
          </ul>
        </Card>
      </PanelFrame>
    </div>
  );
}
