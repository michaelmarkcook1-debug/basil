"use client";

/**
 * Settings → People profiles (lib/privacy): whether Basil builds a read of the
 * people you work with at all, and who you asked it to leave alone.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PrivacyView } from "@/components/contacts/forget-person";

export function PeopleProfilesCard() {
  const [view, setView] = useState<PrivacyView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/privacy", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setView(await r.json() as PrivacyView);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function call(kind: string, url: string, init: RequestInit) {
    setBusy(kind);
    setError(null);
    try {
      const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const out = await r.json().catch(() => ({})) as PrivacyView & { error?: string };
      if (!r.ok) throw new Error(out.error ?? `Could not save (${r.status})`);
      setView(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card id="people-profiles" className="mt-6 scroll-mt-6 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">People profiles</CardTitle>
        <p className="text-xs text-muted-foreground">
          Basil reads your email, Slack and meetings to build a short read of the people you work with: personality,
          what matters to them, how warm things are. They don&rsquo;t see it. It helps with meeting prep and drafts.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError && <p className="text-xs text-signal-critical">This setting could not be read. <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>}
        {error && <p role="alert" className="rounded-md bg-signal-critical-subtle px-3 py-2 text-xs text-signal-critical">{error}</p>}
        {view && (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={view.profiling}
              disabled={busy !== null}
              onChange={(e) => void call("toggle", "/api/privacy", { method: "PATCH", body: JSON.stringify({ profiling: e.target.checked }) })}
            />
            <span>
              <span className="font-medium text-foreground">Build people profiles {busy === "toggle" && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}</span>
              <span className="block text-muted-foreground">
                Off: no new profiles, tone history or warmth reads, and existing ones are hidden everywhere. Your own notes about people are still used.
                To delete a person&rsquo;s profile, open them in Contacts and choose &ldquo;Forget what Basil inferred&rdquo;.
              </span>
            </span>
          </label>
        )}
        {view && view.optedOut.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">People Basil leaves alone</p>
            <ul className="space-y-1.5">
              {view.optedOut.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
                  <span>{o.name}<span className="ml-2 text-muted-foreground">since {new Date(o.at).toLocaleDateString()}</span></span>
                  <button
                    type="button"
                    className="text-muted-foreground underline"
                    disabled={busy !== null}
                    onClick={() => void call(`allow:${o.id}`, `/api/privacy?contactId=${encodeURIComponent(o.id)}`, { method: "DELETE" })}
                  >
                    Allow again
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
