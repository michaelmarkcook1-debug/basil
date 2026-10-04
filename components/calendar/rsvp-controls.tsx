"use client";

/**
 * Answer an invitation from anywhere in Basil: Yes / Maybe / No, or propose a
 * new time. Used on Today (invitations to answer), Meetings and the Schedule
 * detail. The organiser is notified by the server on every answer.
 */
import { useState } from "react";
import { Check, X, HelpCircle, CalendarClock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type Rsvp = "accepted" | "declined" | "tentative" | "needsAction";

export interface RsvpEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  myResponseStatus?: Rsvp;
  isOrganizer?: boolean;
  organizerName?: string;
  organizerEmail?: string;
}

const STATUS_LABEL: Record<Rsvp, string> = {
  accepted: "You're going",
  tentative: "You said maybe",
  declined: "You declined",
  needsAction: "Not answered yet",
};

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function RsvpControls({
  event, compact = false, onChanged,
}: { event: RsvpEvent; compact?: boolean; onChanged?: (status: Rsvp) => void }) {
  const [status, setStatus] = useState<Rsvp>(event.myResponseStatus ?? "needsAction");
  const [busy, setBusy] = useState<Rsvp | "propose" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);

  if (event.isOrganizer) return null;

  async function respond(next: Exclude<Rsvp, "needsAction">) {
    setBusy(next); setError(null); setNotice(null);
    try {
      const res = await fetch(`/api/calendar/${encodeURIComponent(event.id)}/rsvp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const out = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(out.error || "Your response was not sent.");
      setStatus(next);
      onChanged?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Your response was not sent.");
    } finally {
      setBusy(null);
    }
  }

  const choice = (value: Exclude<Rsvp, "needsAction">, label: string, Icon: typeof Check) => (
    <Button
      type="button"
      size={compact ? "xs" : "sm"}
      variant={status === value ? "default" : "outline"}
      aria-pressed={status === value}
      disabled={busy !== null}
      onClick={() => respond(value)}
    >
      {busy === value ? <Loader2 className="animate-spin" /> : <Icon />}
      {label}
    </Button>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {!compact && <span className="mr-1 text-[0.75rem] text-muted-foreground">{STATUS_LABEL[status]}</span>}
        {choice("accepted", "Yes", Check)}
        {choice("tentative", "Maybe", HelpCircle)}
        {choice("declined", "No", X)}
        <Button type="button" size={compact ? "xs" : "sm"} variant="ghost" disabled={busy !== null}
          aria-expanded={proposing} onClick={() => { setProposing((p) => !p); setError(null); setNotice(null); }}>
          <CalendarClock /> New time
        </Button>
      </div>
      {proposing && (
        <ProposeForm
          event={event}
          busy={busy === "propose"}
          onCancel={() => setProposing(false)}
          onSubmit={async (p) => {
            setBusy("propose"); setError(null);
            try {
              const res = await fetch(`/api/calendar/${encodeURIComponent(event.id)}/propose`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(p),
              });
              const out = await res.json().catch(() => ({})) as { error?: string; emailedTo?: string | null };
              if (!res.ok) throw new Error(out.error || "The proposal was not sent.");
              const next: Rsvp = p.response === "declined" ? "declined" : "tentative";
              setStatus(next);
              onChanged?.(next);
              setProposing(false);
              setNotice(out.emailedTo ? `New time proposed — ${out.emailedTo} was emailed.` : "New time proposed on the invitation.");
            } catch (e) {
              setError(e instanceof Error ? e.message : "The proposal was not sent.");
            } finally {
              setBusy(null);
            }
          }}
        />
      )}
      {error && <p role="alert" className="text-[0.75rem] text-signal-critical">{error}</p>}
      {notice && <p role="status" className="text-[0.75rem] text-signal-positive">{notice}</p>}
    </div>
  );
}

interface Proposal { start: string; end: string; note?: string; response: "tentative" | "declined"; emailOrganizer: boolean }

function ProposeForm({ event, busy, onCancel, onSubmit }: {
  event: RsvpEvent; busy: boolean; onCancel: () => void; onSubmit: (p: Proposal) => void;
}) {
  const origStart = new Date(event.start);
  const origMinutes = Math.max(15, Math.round((new Date(event.end).getTime() - origStart.getTime()) / 60_000) || 30);
  const [date, setDate] = useState(localDate(origStart));
  const [time, setTime] = useState(event.isAllDay ? "09:00" : localTime(origStart));
  const [minutes, setMinutes] = useState(event.isAllDay ? 30 : origMinutes);
  const [note, setNote] = useState("");
  const [response, setResponse] = useState<"tentative" | "declined">("tentative");
  const [emailOrganizer, setEmailOrganizer] = useState(!!event.organizerEmail);
  const durations = [...new Set([15, 30, 45, 60, 90, 120, minutes])].sort((a, b) => a - b);
  const who = event.organizerName || event.organizerEmail;
  const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-[0.8125rem]";

  return (
    <form
      className="space-y-2 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const start = new Date(`${date}T${time}`);
        onSubmit({
          start: start.toISOString(),
          end: new Date(start.getTime() + minutes * 60_000).toISOString(),
          note: note.trim() || undefined,
          response,
          emailOrganizer,
        });
      }}
    >
      <p className="text-[0.8125rem] font-medium">Propose a new time for “{event.summary}”</p>
      <div className="grid grid-cols-3 gap-2">
        <label className="text-[0.75rem]">Date<input type="date" required className={field} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="text-[0.75rem]">Start<input type="time" required className={field} value={time} onChange={(e) => setTime(e.target.value)} /></label>
        <label className="text-[0.75rem]">Length
          <select className={field} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {durations.map((d) => <option key={d} value={d}>{d < 60 ? `${d} min` : `${d / 60} h`}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-[0.75rem]">Note (optional)
        <textarea className={field} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Clashes with a client call — would this work?" />
      </label>
      <fieldset className="flex flex-wrap gap-3 text-[0.75rem]">
        <label className="flex items-center gap-1"><input type="radio" checked={response === "tentative"} onChange={() => setResponse("tentative")} /> Mark me as maybe</label>
        <label className="flex items-center gap-1"><input type="radio" checked={response === "declined"} onChange={() => setResponse("declined")} /> Decline this time</label>
      </fieldset>
      <label className={`flex items-center gap-1 text-[0.75rem] ${event.organizerEmail ? "" : "opacity-50"}`}>
        <input type="checkbox" disabled={!event.organizerEmail} checked={emailOrganizer} onChange={(e) => setEmailOrganizer(e.target.checked)} />
        {event.organizerEmail ? `Email ${who} the proposal` : "No organiser email on this invite — the proposal goes in the invite note only"}
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <CalendarClock />} Propose</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}
