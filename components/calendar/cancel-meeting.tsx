"use client";

/**
 * Cancel a meeting, or take yourself out of one, with the right people told.
 *
 * Organiser: the meeting is called off; Google sends every guest a
 * cancellation, and an optional note follows as a short email from your Gmail.
 * Guest: you decline (the organiser is told, with your note on their copy) and
 * it leaves your calendar. The dialog names exactly who will hear before you
 * confirm, and telling them can be switched off.
 */
import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { BTN_SECONDARY } from "@/components/basil/page-hero";
import { formatTime } from "@/lib/utils";
import { cancelCopy, type CancellableEvent } from "@/lib/calendar/cancel-copy";

export type { CancellableEvent };

export interface CancelOutcome { role: "organiser" | "guest" | "bystander"; told: string[]; noteSent: boolean; noteGiven: boolean }

const BTN_DANGER = "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[var(--w-stamp)] px-4 text-[14px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50";

export function CancelMeetingDialog({
  event, open, onOpenChange, onDone,
}: {
  event: CancellableEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (outcome: CancelOutcome, event: CancellableEvent) => void;
}) {
  const [notify, setNotify] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!event) return null;
  const copy = cancelCopy(event);
  const canTell = copy.tell !== null;

  async function confirm() {
    if (!event) return;
    setBusy(true); setError(null);
    const sentNote = canTell && notify ? note.trim() : "";
    try {
      const res = await fetch(`/api/calendar/${encodeURIComponent(event.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify: canTell && notify, note: sentNote }),
      });
      const out = await res.json().catch(() => ({})) as Partial<CancelOutcome> & { error?: string };
      if (!res.ok) throw new Error(out.error || "The meeting was not cancelled.");
      onDone({ role: out.role ?? "organiser", told: out.told ?? [], noteSent: Boolean(out.noteSent), noteGiven: sentNote.length > 0 }, event);
      setNote(""); setNotify(true);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The meeting was not cancelled.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) { setError(null); onOpenChange(v); } }}>
      <DialogContent className="wire max-w-md sm:max-w-md gap-5 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-paper)] p-6 text-[color:var(--w-ink)] ring-0 shadow-[0_30px_60px_-30px_rgba(16,33,63,.6)]">
        <DialogHeader>
          <DialogTitle className="basil-serif text-[28px] font-normal leading-tight text-[#10213F]">{copy.title}</DialogTitle>
          <DialogDescription className="text-[14px] text-[color:var(--w-ink-soft)]">
            <span className="font-semibold text-[color:var(--w-ink)]">{event.summary}</span>
            {" · "}{formatTime(event.start)} – {formatTime(event.end)}
            {event.recurring && <><br />Only this occurrence — the rest of the series stays.</>}
          </DialogDescription>
        </DialogHeader>

        {canTell ? (
          <div className="flex flex-col gap-3">
            <label className="flex cursor-pointer items-start gap-3 text-[14px]">
              <input
                type="checkbox"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-[#10213F]"
              />
              <span>{copy.tell}</span>
            </label>
            {notify && (
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={copy.noteHint}
                maxLength={2000}
                rows={3}
                className="rounded-xl border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] text-[14px]"
              />
            )}
            {!notify && (
              <p className="text-[13px] text-[color:var(--w-ink-soft)]">
                {event.isOrganizer
                  ? "The meeting is still removed from the guests' calendars, but nobody gets an email."
                  : "It leaves your calendar without a reply to the organiser."}
              </p>
            )}
          </div>
        ) : (
          <p className="text-[14px] text-[color:var(--w-ink-soft)]">
            {event.isOrganizer ? "No one else is invited, so nobody needs telling." : "You were invited through a group, so there is no reply to send — it just leaves your calendar."}
          </p>
        )}

        {error && <p role="alert" className="text-[13px] text-[color:var(--w-stamp)]">{error}</p>}

        <DialogFooter className="mx-0 mb-0 rounded-none border-t border-[var(--w-rule)] bg-transparent px-0 pb-0 pt-4">
          <button type="button" className={BTN_SECONDARY} onClick={() => onOpenChange(false)} disabled={busy}>Keep it</button>
          <button type="button" className={BTN_DANGER} onClick={confirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
            {copy.action}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
