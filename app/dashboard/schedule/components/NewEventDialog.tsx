"use client";

/**
 * NewEventDialog — create a Google Calendar event and invite contacts.
 *
 * Full-functionality event form: title, date, start/end time, notes, a
 * location / video-link field, an optional Google Meet toggle, and an attendee
 * picker backed by the user's contacts (searchable) plus free-text email entry.
 * Submitting POSTs /api/calendar/create, which creates the event with
 * sendUpdates:"all" so every attendee receives a real calendar invite.
 */

import { useState, useEffect, useMemo } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getTodayISO } from "@/lib/timezone";
import { CalendarPlus, X, Plus, Check, Video, Loader2, UserPlus } from "lucide-react";
import { BTN_PRIMARY, BTN_SECONDARY } from "@/components/basil/page-hero";

/** Inputs in the cream world: rounded-xl, ruled border, paper-white fill. */
const FIELD = "rounded-xl border-[var(--w-rule)] bg-[var(--w-flimsy)] text-[color:var(--w-ink)] placeholder:text-[color:var(--w-ink-soft)] focus-visible:border-[#C8A96B]";
const LABEL = "basil-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--w-ink-soft)]";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ContactLite { id: string; name: string; email?: string }
interface Attendee { email: string; name?: string }

export function NewEventDialog({
  open,
  onOpenChange,
  defaultDate,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** YYYY-MM-DD to prefill (e.g. the day the user clicked). */
  defaultDate?: string;
  onCreated?: (info: { title: string; attendeeCount: number; htmlLink?: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate || getTodayISO());
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("09:30");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [addVideoCall, setAddVideoCall] = useState(false);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill the date whenever the dialog is (re)opened for a specific day.
  useEffect(() => {
    if (open && defaultDate) setDate(defaultDate);
  }, [open, defaultDate]);

  // Load contacts once, lazily, the first time the dialog opens.
  useEffect(() => {
    if (!open || contacts.length > 0) return;
    let cancelled = false;
    fetch("/api/contacts/all")
      .then((r) => (r.ok ? r.json() : { contacts: [] }))
      .then((d) => {
        if (cancelled) return;
        const withEmail = (d.contacts as ContactLite[] | undefined ?? [])
          .filter((c) => c.email && EMAIL_RE.test(c.email));
        setContacts(withEmail);
      })
      .catch(() => { /* noop */ }); // ci-ok: contacts optional; free-text email entry still works
    return () => { cancelled = true; };
  }, [open, contacts.length]);

  const selectedEmails = useMemo(() => new Set(attendees.map((a) => a.email)), [attendees]);

  function toggleContact(c: ContactLite) {
    const email = c.email?.toLowerCase();
    if (!email) return;
    setAttendees((prev) =>
      prev.some((a) => a.email === email)
        ? prev.filter((a) => a.email !== email)
        : [...prev, { email, name: c.name }],
    );
  }

  function removeAttendee(email: string) {
    setAttendees((prev) => prev.filter((a) => a.email !== email));
  }

  function addRawEmail() {
    const e = emailInput.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) { setError("Enter a valid email address."); return; }
    setError(null);
    if (!selectedEmails.has(e)) setAttendees((prev) => [...prev, { email: e }]);
    setEmailInput("");
  }

  function resetForm() {
    setTitle(""); setDescription(""); setLocation("");
    setAttendees([]); setAddVideoCall(false); setEmailInput(""); setError(null);
  }

  async function submit() {
    if (!title.trim()) { setError("Give the event a title."); return; }
    if (endTime <= startTime) { setError("End time must be after the start time."); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/calendar/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          date,
          startTime,
          endTime,
          description: description.trim() || undefined,
          location: location.trim() || undefined,
          addVideoCall,
          attendees: attendees.map((a) => a.email),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create event.");
      onCreated?.({
        title: title.trim(),
        attendeeCount: typeof data.attendeeCount === "number" ? data.attendeeCount : attendees.length,
        htmlLink: data.htmlLink,
      });
      resetForm();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create event.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      {/* The dialog portals to <body>, outside the page's `.wire` scope — so it
          carries `wire` itself to get the cream ground and the --w-* tokens. */}
      <DialogContent className="wire max-w-lg sm:max-w-lg max-h-[90vh] overflow-y-auto gap-5 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-paper)] p-6 text-[color:var(--w-ink)] ring-0 shadow-[0_30px_60px_-30px_rgba(16,33,63,.6)]">
        <DialogHeader>
          <DialogTitle className="basil-serif flex items-center gap-2.5 text-[32px] font-normal leading-none tracking-[-0.01em] text-[#10213F]">
            <CalendarPlus className="h-5 w-5 text-[color:var(--w-carbon)]" />
            <span>New event<span className="text-[#C8A96B]">.</span></span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-title" className={LABEL}>Title</Label>
            <Input id="ev-title" value={title} autoFocus placeholder="e.g. Product sync"
              className={`h-11 text-[15px] ${FIELD}`}
              onChange={(e) => setTitle(e.target.value)} />
          </div>

          {/* Date + time */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="ev-date" className={LABEL}>Date</Label>
              <Input id="ev-date" type="date" value={date} className={`basil-mono h-11 text-[14px] ${FIELD}`}
                onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-start" className={LABEL}>Start</Label>
              <Input id="ev-start" type="time" value={startTime} className={`basil-mono h-11 text-[14px] ${FIELD}`}
                onChange={(e) => {
                  const v = e.target.value;
                  setStartTime(v);
                  // Keep end 30m after start if end is now behind start.
                  if (endTime <= v) {
                    const [h, m] = v.split(":").map(Number);
                    const t = h * 60 + m + 30;
                    setEndTime(`${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
                  }
                }} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-end" className={LABEL}>End</Label>
              <Input id="ev-end" type="time" value={endTime} className={`basil-mono h-11 text-[14px] ${FIELD}`}
                onChange={(e) => setEndTime(e.target.value)} />
            </div>
          </div>

          {/* Attendees */}
          <div className="space-y-1.5">
            <Label className={LABEL}>Invite people</Label>
            {attendees.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {attendees.map((a) => (
                  <span key={a.email}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--w-rule)] bg-[var(--w-flimsy)] py-0.5 pl-2.5 pr-1 text-[13px] text-[color:var(--w-ink)]">
                    <span className="max-w-[180px] truncate">{a.name || a.email}</span>
                    <button type="button" aria-label={`Remove ${a.name || a.email}`}
                      onClick={() => removeAttendee(a.email)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[color:var(--w-ink-soft)] hover:bg-[var(--w-tray)] hover:text-[color:var(--w-ink)]">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <button type="button" className={BTN_SECONDARY}>
                    <UserPlus className="h-4 w-4 text-[color:var(--w-carbon)]" />
                    From contacts
                  </button>
                </PopoverTrigger>
                {/* Portalled too — `wire` again for the cream tokens. */}
                <PopoverContent className="wire w-72 rounded-xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-0 text-[color:var(--w-ink)]" align="start">
                  <Command className="bg-[var(--w-flimsy)]">
                    <CommandInput placeholder="Search contacts…" />
                    <CommandList>
                      <CommandEmpty>
                        {contacts.length === 0 ? "No contacts with an email yet." : "No match."}
                      </CommandEmpty>
                      <CommandGroup>
                        {contacts.map((c) => {
                          const email = c.email!.toLowerCase();
                          const selected = selectedEmails.has(email);
                          return (
                            <CommandItem key={c.id} value={`${c.name} ${c.email}`} onSelect={() => toggleContact(c)}>
                              <Check className={`mr-2 h-3.5 w-3.5 ${selected ? "opacity-100 text-[color:var(--w-carbon)]" : "opacity-0"}`} />
                              <div className="min-w-0">
                                <div className="truncate text-[14px] text-[color:var(--w-ink)]">{c.name}</div>
                                <div className="truncate text-[12px] text-[color:var(--w-ink-soft)]">{c.email}</div>
                              </div>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              <div className="flex min-w-[220px] flex-1 gap-1.5">
                <Input value={emailInput} placeholder="or type an email…"
                  className={`h-11 text-[14px] ${FIELD}`}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRawEmail(); } }} />
                <button type="button" aria-label="Add email"
                  onClick={addRawEmail} disabled={!emailInput.trim()}
                  className={`${BTN_SECONDARY} w-11 shrink-0 px-0`}>
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Location / video */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-loc" className={LABEL}>Location or video link</Label>
            <Input id="ev-loc" value={location} placeholder="Room 2, or paste a Zoom/Meet link"
              className={`h-11 text-[14px] ${FIELD}`}
              onChange={(e) => setLocation(e.target.value)} />
            <label className="flex min-h-[36px] cursor-pointer items-center gap-2 pt-0.5 text-[14px] text-[color:var(--w-ink)]">
              <input type="checkbox" checked={addVideoCall}
                onChange={(e) => setAddVideoCall(e.target.checked)} className="h-4 w-4 rounded accent-[#10213F]" />
              <Video className="h-4 w-4 text-[color:var(--w-carbon)]" /> Add a Google Meet video call
            </label>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-desc" className={LABEL}>Notes (optional)</Label>
            <Textarea id="ev-desc" value={description} rows={3} placeholder="Agenda, context, links…"
              className={`px-3 py-2.5 text-[14px] ${FIELD}`}
              onChange={(e) => setDescription(e.target.value)} />
          </div>

          {error && (
            <p role="alert" className="rounded-xl border border-[var(--w-stamp)] bg-[var(--w-flimsy)] px-3 py-2 text-[13px] text-[color:var(--w-stamp)]">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="mx-0 mb-0 rounded-none border-t border-[var(--w-rule)] bg-transparent px-0 pb-0 pt-4">
          <button type="button" className={BTN_SECONDARY} onClick={() => onOpenChange(false)} disabled={saving}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={saving || !title.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
            {attendees.length > 0 ? `Create & invite ${attendees.length}` : "Create event"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
