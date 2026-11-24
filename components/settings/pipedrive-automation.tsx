"use client";

/**
 * Settings → Pipedrive, once connected: what Basil holds from Pipedrive (read
 * once a day), "Refresh now", and the opt-in for follow-ups.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Mode = "off" | "suggest" | "alert" | "schedule";
interface View {
  mode: Mode; staleDays: number; meetingMinutes: number; readAt: number | null; stale: boolean;
  counts: { deals: number; openDeals: number; people: number; organisations: number; notes: number; activities: number; leads: number } | null;
  suggestions: unknown[];
}

const MODES: { id: Mode; label: string; detail: string }[] = [
  { id: "off", label: "Context only", detail: "Basil uses Pipedrive to inform everything, but suggests nothing." },
  { id: "suggest", label: "Suggest follow-ups", detail: "Follow-ups appear on Today and in your briefing." },
  { id: "alert", label: "Suggest and alert me", detail: "Also a notification at the start of your working day listing new ones." },
  { id: "schedule", label: "Find a time and book", detail: "Also “Find a time” on each follow-up: Basil checks both calendars and offers slots. Nothing is booked or sent until you pick one and confirm; meeting prep is ready when it is." },
];

export function PipedriveAutomation() {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (init?: RequestInit, tag = "load") => {
    setBusy(tag); setError(null);
    try {
      const r = await fetch("/api/pipedrive/followups", { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
      const d = (await r.json()) as View & { error?: string };
      if (!r.ok) throw new Error(d.error ?? `Failed (${r.status})`);
      setView(d);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }, []);

  useEffect(() => { void call(); }, [call]);

  const patch = (body: Partial<Pick<View, "mode" | "staleDays" | "meetingMinutes">>) => call({ method: "PATCH", body: JSON.stringify(body) }, "save");

  if (!view) return <p className="text-xs text-muted-foreground">{error ?? "Reading…"}</p>;
  const c = view.counts;

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {view.readAt
            ? <>Read {new Date(view.readAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}{view.stale ? " — the last refresh failed, this is the earlier copy" : ""}. Basil reads it in full once a day, before your briefing.</>
            : "Basil is reading Pipedrive for the first time — this takes a minute or two."}
        </p>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={busy !== null} onClick={() => void call({ method: "POST", body: JSON.stringify({ action: "refresh" }) }, "refresh")}>
          {busy === "refresh" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh now
        </Button>
      </div>
      {c && (
        <p className="text-xs text-muted-foreground">
          {c.openDeals} open of {c.deals} deals · {c.people} people · {c.organisations} organisations · {c.activities} activities · {c.notes} notes · {c.leads} leads
        </p>
      )}
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs font-medium">Follow-ups</legend>
        {MODES.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-start gap-2 text-xs">
            <input type="radio" name="pd-mode" className="mt-0.5" checked={view.mode === m.id} disabled={busy !== null} onChange={() => void patch({ mode: m.id })} />
            <span><span className="font-medium">{m.label}</span> — <span className="text-muted-foreground">{m.detail}</span></span>
          </label>
        ))}
      </fieldset>
      {view.mode !== "off" && (
        <div className="flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-2">
            A deal has gone quiet after
            <select className="rounded border bg-background px-1.5 py-1" value={view.staleDays} disabled={busy !== null} onChange={(e) => void patch({ staleDays: Number(e.target.value) })}>
              {[7, 10, 14, 21, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
          {view.mode === "schedule" && (
            <label className="flex items-center gap-2">
              Follow-up meetings last
              <select className="rounded border bg-background px-1.5 py-1" value={view.meetingMinutes} disabled={busy !== null} onChange={(e) => void patch({ meetingMinutes: Number(e.target.value) })}>
                {[15, 30, 45, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {view.mode !== "off" && <p className="text-xs text-muted-foreground">{view.suggestions.length} follow-up{view.suggestions.length === 1 ? "" : "s"} suggested right now.</p>}
      {error && <p className="text-xs text-signal-critical">{error}</p>}
    </div>
  );
}
