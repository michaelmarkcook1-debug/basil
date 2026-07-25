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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getTodayISO } from "@/lib/timezone";
import { CalendarPlus, X, Plus, Check, Video, Loader2, UserPlus } from "lucide-react";

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
      .catch(() => { /* noop */ }); // basil-ci-allow-silent-catch: contacts optional; free-text email entry still works
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
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-4 w-4 text-gold" /> New event
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-title" className="text-xs text-muted-foreground">Title</Label>
            <Input id="ev-title" value={title} autoFocus placeholder="e.g. Product sync"
              onChange={(e) => setTitle(e.target.value)} />
          </div>

          {/* Date + time */}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="ev-date" className="text-xs text-muted-foreground">Date</Label>
              <Input id="ev-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-start" className="text-xs text-muted-foreground">Start</Label>
              <Input id="ev-start" type="time" value={startTime}
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
              <Label htmlFor="ev-end" className="text-xs text-muted-foreground">End</Label>
              <Input id="ev-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
          </div>

          {/* Attendees */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Invite people</Label>
            {attendees.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {attendees.map((a) => (
                  <span key={a.email}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 pl-2 pr-1 py-0.5 text-xs">
                    <span className="max-w-[180px] truncate">{a.name || a.email}</span>
                    <button type="button" aria-label={`Remove ${a.name || a.email}`}
                      onClick={() => removeAttendee(a.email)}
                      className="rounded-full p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="gap-1.5">
                    <UserPlus className="h-3.5 w-3.5" />
                    From contacts
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0 w-72" align="start">
                  <Command>
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
                              <Check className={`mr-2 h-3.5 w-3.5 ${selected ? "opacity-100 text-gold" : "opacity-0"}`} />
                              <div className="min-w-0">
                                <div className="truncate text-sm">{c.name}</div>
                                <div className="truncate text-xs text-muted-foreground">{c.email}</div>
                              </div>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              <div className="flex flex-1 gap-1.5">
                <Input value={emailInput} placeholder="or type an email…"
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRawEmail(); } }} />
                <Button type="button" variant="outline" size="icon" aria-label="Add email"
                  onClick={addRawEmail} disabled={!emailInput.trim()}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* Location / video */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-loc" className="text-xs text-muted-foreground">Location or video link</Label>
            <Input id="ev-loc" value={location} placeholder="Room 2, or paste a Zoom/Meet link"
              onChange={(e) => setLocation(e.target.value)} />
            <label className="flex items-center gap-2 text-sm text-muted-foreground pt-0.5">
              <input type="checkbox" checked={addVideoCall}
                onChange={(e) => setAddVideoCall(e.target.checked)} className="rounded" />
              <Video className="h-3.5 w-3.5" /> Add a Google Meet video call
            </label>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-desc" className="text-xs text-muted-foreground">Notes (optional)</Label>
            <Textarea id="ev-desc" value={description} rows={3} placeholder="Agenda, context, links…"
              onChange={(e) => setDescription(e.target.value)} />
          </div>

          {error && (
            <p className="rounded-md bg-signal-critical-subtle border border-signal-critical-border/60 px-3 py-2 text-xs text-signal-critical">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !title.trim()} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />}
            {attendees.length > 0 ? `Create & invite ${attendees.length}` : "Create event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
