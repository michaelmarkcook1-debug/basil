"use client";

/**
 * The buttons on a Pipedrive follow-up card. "Dismiss" hides it for 14 days.
 * With "Find a time and book" turned on (Settings → Pipedrive), "Find a time"
 * checks both calendars and offers slots; choosing one asks once more — it
 * sends the invite — and then books it, with meeting prep one click away.
 */
import { useState } from "react";
import Link from "next/link";
import { CalendarPlus, Loader2 } from "lucide-react";

interface Slot { start: string; end: string; label: string }

export function FollowupActions({ id, schedulable, contact, onDone }: {
  id: string;
  schedulable: boolean;
  contact?: string;
  onDone?: () => void | Promise<unknown>;
}) {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [picked, setPicked] = useState<Slot | null>(null);
  const [busy, setBusy] = useState<"slots" | "book" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<{ prepUrl: string; htmlLink: string; label: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  async function post<T>(url: string, body: unknown): Promise<T> {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = (await r.json().catch(() => ({}))) as T & { error?: string }; // ci-ok: an unreadable body is reported as the status below
    if (!r.ok) throw new Error(d.error ?? `Failed (${r.status})`);
    return d;
  }

  async function findTime() {
    setBusy("slots"); setError(null); setPicked(null);
    try {
      const d = await post<{ slots: Slot[] }>("/api/pipedrive/followups/slots", { id });
      setSlots(d.slots);
      if (d.slots.length === 0) setError("No free time in the next week that suits both of you.");
    } catch (e) {
      console.warn("[followup-actions]", e instanceof Error ? e.message : e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function book(slot: Slot) {
    setBusy("book"); setError(null);
    try {
      const d = await post<{ prepUrl: string; htmlLink: string }>("/api/pipedrive/followups/book", { id, start: slot.start });
      setBooked({ ...d, label: slot.label });
      setSlots(null); setPicked(null);
    } catch (e) {
      console.warn("[followup-actions]", e instanceof Error ? e.message : e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function dismiss() {
    setBusy("dismiss"); setError(null);
    try {
      await post("/api/pipedrive/followups", { action: "dismiss", id });
      setDismissed(true);
      await onDone?.();
    } catch (e) {
      console.warn("[followup-actions]", e instanceof Error ? e.message : e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (dismissed) return <p className="text-[14px] text-[color:var(--w-ink-soft)]">Dismissed. Basil will raise it again in 14 days if nothing changes.</p>;

  if (booked) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[14px]">
        <span className="font-medium text-[color:var(--w-filed)]">Booked for {booked.label}{contact ? ` with ${contact}` : ""}.</span>
        <Link href={booked.prepUrl} className="inline-flex min-h-[44px] items-center rounded-xl bg-[#10213F] px-4 font-medium text-[#F6F1E7]">Open meeting prep</Link>
        {booked.htmlLink && <a href={booked.htmlLink} target="_blank" rel="noreferrer" className="underline underline-offset-2">In calendar</a>}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {schedulable && (
          <button type="button" onClick={() => void findTime()} disabled={busy !== null}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#10213F] px-4 text-[14px] font-medium text-[#F6F1E7]">
            {busy === "slots" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CalendarPlus className="h-4 w-4" aria-hidden />}
            Find a time
          </button>
        )}
        <button type="button" onClick={() => void dismiss()} disabled={busy !== null}
          className="inline-flex min-h-[44px] items-center rounded-xl border border-[var(--w-rule-strong)] px-3.5 text-[14px] font-medium text-[color:var(--w-ink)]">
          {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
      {slots && slots.length > 0 && !picked && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Free times">
          {slots.map((s) => (
            <button key={s.start} type="button" onClick={() => setPicked(s)}
              className="min-h-[40px] rounded-lg border border-[var(--w-rule-strong)] bg-[var(--w-paper)] px-3 text-[13.5px] text-[color:var(--w-ink)] hover:bg-[var(--w-flimsy)]">
              {s.label}
            </button>
          ))}
        </div>
      )}
      {picked && (
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <span>Book {picked.label}{contact ? ` and send the invite to ${contact}` : ""}?</span>
          <button type="button" onClick={() => void book(picked)} disabled={busy !== null}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-xl bg-[#10213F] px-3.5 font-medium text-[#F6F1E7]">
            {busy === "book" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Book &amp; send invite
          </button>
          <button type="button" onClick={() => setPicked(null)} className="underline underline-offset-2">Choose another</button>
        </div>
      )}
      {error && <p role="alert" className="text-[13px] text-[color:var(--w-stamp)]">{error}</p>}
    </div>
  );
}
