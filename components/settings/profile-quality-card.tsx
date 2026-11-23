"use client";

/**
 * Settings → Profile quality: how Basil's people profiles are doing, from your
 * thumbs, your edits and what its own checks removed (lib/contacts/profile-feedback).
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { QualitySummary } from "@/lib/contacts/profile-quality";

const FIELD_LABEL: Record<string, string> = {
  personality: "Personality", whatMakesThemTick: "What makes them tick", watchOut: "Watch out", recentActivity: "Recent activity",
  howToLandIt: "How to land it", reachThem: "Reaching them", decides: "How they decide", badNews: "Bad news", silence: "Silence",
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function ProfileQualityCard() {
  const [q, setQ] = useState<QualitySummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/contacts/profile-feedback", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: QualitySummary) => { if (live) setQ(d); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const edits = Object.entries(q?.editsByField ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return (
    <Card id="profile-quality" className="mt-6 scroll-mt-6 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">Profile quality</CardTitle>
        <p className="text-sm text-muted-foreground">
          How Basil&rsquo;s people profiles are doing: your thumbs on each claim, how much you edit them, and what Basil&rsquo;s own checks removed before you saw them.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {failed ? (
          <p className="text-destructive">Couldn&rsquo;t read this just now.</p>
        ) : !q ? (
          <p className="text-muted-foreground">Reading…</p>
        ) : q.drafts === 0 ? (
          <p className="text-muted-foreground">No profiles drafted since grading began. Draft one from a contact&rsquo;s page.</p>
        ) : (
          <>
            <ul className="grid gap-2 sm:grid-cols-3">
              <li className="rounded-xl border p-3"><p className="text-xl font-semibold tabular-nums">{q.profiles}</p><p className="text-xs text-muted-foreground">people profiled ({q.drafts} drafts)</p></li>
              <li className="rounded-xl border p-3"><p className="text-xl font-semibold tabular-nums">{q.thumbsUp} / {q.thumbsDown}</p><p className="text-xs text-muted-foreground">claims you marked right / wrong</p></li>
              <li className="rounded-xl border p-3"><p className="text-xl font-semibold tabular-nums">{q.removedShare === null ? "—" : pct(q.removedShare)}</p><p className="text-xs text-muted-foreground">of claims removed by Basil&rsquo;s checks{q.removedByCheck ? ` (${q.removedByCheck} by the second check)` : ""}</p></li>
            </ul>
            {edits.length > 0 && (
              <div>
                <p className="mb-1 font-medium">How much you change what Basil wrote</p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {edits.map(([f, r]) => <li key={f}>{FIELD_LABEL[f] ?? f}: {pct(r ?? 0)} rewritten on average</li>)}
                </ul>
              </div>
            )}
            <p className={q.reviewDue ? "font-medium text-[color:var(--w-carbon)]" : "text-muted-foreground"}>
              {q.reviewDue
                ? "There are now 30 or more profiles: time for a by-hand look at where they go wrong. The claims you marked wrong are the place to start."
                : `A by-hand review of where profiles go wrong is worth doing at 30 profiles (${q.profiles} so far).`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
