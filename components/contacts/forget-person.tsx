"use client";

/**
 * Contacts → a person → "Forget what Basil inferred" (lib/privacy).
 *
 * Basil builds a read of the people you work with from your mail, Slack and
 * meetings. They have not seen it. This lets you delete that read, and by
 * default stop Basil building another. Your own notes and memories go only
 * if you tick them.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface PrivacyView { profiling: boolean; optedOut: { id: string; name: string; at: string }[] }

export function ForgetPerson({ contactId, name, privacy, onChanged }: {
  contactId: string;
  name: string;
  privacy: PrivacyView | null;
  /** Called with the new privacy state after a forget or allow-again, so the page can reload profiles. */
  onChanged: (next: PrivacyView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(false);
  const [memories, setMemories] = useState(false);
  const [optOut, setOptOut] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const first = name.split(/\s+/)[0] || name;
  const excluded = privacy?.optedOut.some((o) => o.id === contactId) ?? false;

  async function forget() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/privacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, name, notes, memories, optOut }),
      });
      const out = await r.json().catch(() => ({})) as { error?: string; memories?: number; privacy?: PrivacyView };
      if (!r.ok || !out.privacy) throw new Error(out.error ?? `Could not forget (${r.status})`);
      setOpen(false);
      setDone(`Done. Basil's read of ${first} is deleted${out.memories ? `, with ${out.memories} memor${out.memories === 1 ? "y" : "ies"}` : ""}.`);
      onChanged(out.privacy);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function allowAgain() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/privacy?contactId=${encodeURIComponent(contactId)}`, { method: "DELETE" });
      const out = await r.json().catch(() => ({})) as PrivacyView & { error?: string };
      if (!r.ok) throw new Error(out.error ?? `Could not change it (${r.status})`);
      setDone(null);
      onChanged(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (privacy && !privacy.profiling) {
    return (
      <p className="text-[12px] text-muted-foreground">
        People profiles are off in Settings, so Basil is not building a read of {first}. Your own notes are still used.
      </p>
    );
  }

  return (
    <div className="space-y-2 text-[12px]">
      {excluded ? (
        <p className="text-muted-foreground">
          You asked Basil not to build a profile of {first}. No tone or warmth reads are made either.{" "}
          <button type="button" className="underline" disabled={busy} onClick={() => void allowAgain()}>Allow again</button>
        </p>
      ) : (
        <p className="text-muted-foreground">
          This read is Basil&rsquo;s inference from your email, Slack and meetings with {first}. {first} hasn&rsquo;t seen it.{" "}
          {!open && <button type="button" className="underline" onClick={() => { setOpen(true); setDone(null); }}>Forget what Basil inferred</button>}
        </p>
      )}
      {done && <p role="status" className="text-muted-foreground">{done}</p>}
      {error && <p role="alert" className="text-signal-critical">{error}</p>}
      {open && !excluded && (
        <div className="space-y-2 rounded-lg border border-border bg-background p-3">
          <p className="font-medium text-foreground">Forget Basil&rsquo;s read of {first}?</p>
          <p className="text-muted-foreground">Deletes the profile, the tone history and the warmth read. This can&rsquo;t be undone. {first} stays in your contacts.</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={optOut} onChange={(e) => setOptOut(e.target.checked)} /> Don&rsquo;t build a new one</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> Also delete my own notes about {first}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={memories} onChange={(e) => setMemories(e.target.checked)} /> Also delete memories filed under {name}</label>
          <div className="flex gap-2 pt-1">
            <Button size="xs" variant="destructive" onClick={() => void forget()} disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Forget
            </Button>
            <Button size="xs" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
