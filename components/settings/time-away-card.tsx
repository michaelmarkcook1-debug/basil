"use client";

/**
 * Settings → Time away: which days you work, whose bank holidays you take, and
 * the absences Basil knows about (lib/away). Absences come from Google Calendar
 * out-of-office blocks and from here; calendar ones are changed in Google.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { shortDay, type AwayPeriod, type HolidayRegion } from "@/lib/away/calendar";

const DAYS = [
  { n: 1, label: "Mon" }, { n: 2, label: "Tue" }, { n: 3, label: "Wed" }, { n: 4, label: "Thu" },
  { n: 5, label: "Fri" }, { n: 6, label: "Sat" }, { n: 0, label: "Sun" },
];
const REGIONS: { value: HolidayRegion; label: string }[] = [
  { value: "england-and-wales", label: "England and Wales" },
  { value: "scotland", label: "Scotland" },
  { value: "northern-ireland", label: "Northern Ireland" },
  { value: "none", label: "None" },
];

interface AwayData { periods: AwayPeriod[]; workingDays: number[]; holidayRegion: HolidayRegion }

export function TimeAwayCard() {
  const [data, setData] = useState<AwayData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [days, setDays] = useState<number[]>([]);
  const [region, setRegion] = useState<HolidayRegion>("england-and-wales");
  const [form, setForm] = useState({ start: "", end: "", cover: "" });
  const [busy, setBusy] = useState<"pattern" | "add" | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/away", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json() as AwayData;
      setData(d);
      setDays(d.workingDays);
      setRegion(d.holidayRegion);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function call(kind: string, url: string, init: RequestInit, done: string) {
    setBusy(kind);
    setError(null);
    setSaved(null);
    try {
      const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const out = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) {
        setError(out.error || "That was not saved.");
        return false;
      }
      setSaved(done);
      await load();
      return true;
    } catch {
      setError("That was not saved.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  const patternChanged = !!data && (region !== data.holidayRegion || [...days].sort().join() !== [...data.workingDays].sort().join());

  return (
    <Card id="time-away" className="mt-6 scroll-mt-6 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">Time away</CardTitle>
        <p className="text-xs text-muted-foreground">
          On days you don’t work, Basil writes no briefing and nothing ages: replies, overdue items and quiet relationships wait until
          you’re back. The first working day back gets a briefing that covers the whole gap.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {loadError && <p className="text-xs text-signal-critical">Time away could not be read. <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>}
        {error && <p role="alert" className="rounded-md bg-signal-critical-subtle px-3 py-2 text-xs text-signal-critical">{error}</p>}
        {saved && <p role="status" className="text-xs text-muted-foreground">{saved}</p>}

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Days you work</p>
          <div className="flex flex-wrap gap-2">
            {DAYS.map(({ n, label }) => (
              <label key={n} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={days.includes(n)}
                  onChange={(e) => setDays((d) => (e.target.checked ? [...d, n] : d.filter((x) => x !== n)))}
                />
                {label}
              </label>
            ))}
          </div>
          <label className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            Bank holidays
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value as HolidayRegion)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            >
              {REGIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <Button
            size="sm" variant="outline"
            disabled={!patternChanged || days.length === 0 || busy !== null}
            onClick={() => void call("pattern", "/api/settings", { method: "PATCH", body: JSON.stringify({ workingDays: days, holidayRegion: region }) }, "Working days saved.")}
          >
            {busy === "pattern" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Save working days
          </Button>
          {days.length === 0 && <p className="text-xs text-signal-critical">Pick at least one day.</p>}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Absences</p>
          {data && data.periods.length === 0 && (
            <p className="text-xs text-muted-foreground">None coming up. Out-of-office blocks on your Google Calendar appear here within the hour.</p>
          )}
          {data?.periods.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs">
              <span>
                <span className="font-medium">{shortDay(p.start)}{p.end !== p.start ? ` to ${shortDay(p.end)}` : ""}</span>
                {p.label ? ` · ${p.label}` : ""}{p.cover ? ` · ${p.cover} covering` : ""}
                <span className="text-muted-foreground"> · {p.source === "calendar" ? "from Google Calendar" : "added in Basil"}</span>
              </span>
              {p.source === "basil" ? (
                <Button
                  size="sm" variant="ghost" className="h-7 px-2 text-xs"
                  disabled={busy !== null}
                  onClick={() => void call(p.id, `/api/away?id=${encodeURIComponent(p.id)}`, { method: "DELETE" }, "Absence removed.")}
                >
                  Remove
                </Button>
              ) : (
                <span className="text-muted-foreground">Change it in Google Calendar</span>
              )}
            </div>
          ))}
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_1.4fr_auto] md:items-end">
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              First day away
              <Input type="date" value={form.start} onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))} />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Last day away
              <Input type="date" value={form.end} min={form.start || undefined} onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))} />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Who is covering (optional)
              <Input value={form.cover} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, cover: e.target.value }))} placeholder="Guy Saunders" />
            </label>
            <Button
              size="sm"
              disabled={!form.start || !form.end || form.end < form.start || busy !== null}
              onClick={async () => {
                const ok = await call("add", "/api/away", { method: "POST", body: JSON.stringify({ start: form.start, end: form.end, cover: form.cover || undefined }) }, "Absence added.");
                if (ok) setForm({ start: "", end: "", cover: "" });
              }}
            >
              {busy === "add" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            This tells Basil only. To set your Gmail auto-reply too, ask Basil: “Turn on my out of office from … to …”.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
