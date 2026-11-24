"use client";

/** Settings → Plaud, once connected: what has synced, "Sync now", and reaching further back. */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface View {
  connected: boolean; lastSyncAt: string | null; synced: number;
  lastResult: { found: number; added: number; failed: number; remaining: number; at: string } | null;
  error?: string;
}

export function PlaudSync() {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (init?: RequestInit, tag = "load") => {
    setBusy(tag); setError(null);
    try {
      const r = await fetch("/api/plaud", { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
      const d = (await r.json()) as View;
      setView(d);
      if (!r.ok || d.error) setError(d.error ?? `Failed (${r.status})`);
    } catch (e) {
      console.warn("[plaud-sync]", e instanceof Error ? e.message : e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => { void call(); }, [call]);
  const sync = (days?: number) => call({ method: "POST", body: JSON.stringify({ action: "sync", ...(days ? { days } : {}) }) }, days ? "back" : "sync");
  const r = view?.lastResult;

  return (
    <div className="space-y-2 border-t pt-3 text-xs">
      <p className="text-muted-foreground">
        Each Plaud recording arrives in Basil with Plaud’s transcript (speakers and timestamps) and AI notes, then becomes notes, decisions and actions — searchable from Ask Basil and listed on{" "}
        <Link href="/dashboard/uploads" className="underline">Uploads</Link>. Audio stays in Plaud. Syncs daily before your briefing.
      </p>
      {view && (
        <p className="text-muted-foreground">
          {view.synced} recording{view.synced === 1 ? "" : "s"} synced
          {r ? ` · last run ${new Date(r.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}: ${r.added} added${r.failed ? `, ${r.failed} failed` : ""}${r.remaining ? `, ${r.remaining} still to come` : ""}` : " · not synced yet"}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={busy !== null} onClick={() => void sync()}>
          {busy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Sync now
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs" disabled={busy !== null} onClick={() => void sync(90)}>
          {busy === "back" ? "Reaching back…" : "Reach back 90 days"}
        </Button>
      </div>
      {busy && <p className="text-muted-foreground">Reading recordings and pulling out notes and actions — up to eight per run, newest first.</p>}
      {error && <p className="text-signal-critical">{error}</p>}
    </div>
  );
}
