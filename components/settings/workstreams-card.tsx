"use client";

/**
 * Settings → Workstreams: what each workstream holds, and the routing rules the
 * user has taught Basil ("Always file … here" on any card) or Basil learned
 * from how they file (lib/workstreams/learn), and how often Basil's own filing
 * is right. Rules can be removed here; new ones come from the cards.
 */

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WORKSTREAMS, workstreamInfo, type WorkstreamRule } from "@/lib/workstreams/types";
import type { LearningScore } from "@/lib/workstreams/learn";

const FIELD_LABEL: Record<WorkstreamRule["field"], string> = {
  sender: "From",
  domain: "Anyone at",
  channel: "Slack channel #",
  keyword: "Mentions",
  project: "Project",
};

export function WorkstreamsCard() {
  const [rules, setRules] = useState<WorkstreamRule[] | null>(null);
  const [score, setScore] = useState<LearningScore | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/workstreams", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { rules?: WorkstreamRule[]; score?: LearningScore }) => { if (live) { setRules(d.rules ?? []); setScore(d.score ?? null); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  async function remove(id: string) {
    setBusy(id);
    try {
      const r = await fetch(`/api/workstreams?rule=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.ok) setRules((cur) => (cur ?? []).filter((x) => x.id !== id));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card id="workstreams" className="mt-6 scroll-mt-6 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">Workstreams</CardTitle>
        <p className="text-sm text-muted-foreground">
          Everything on Today and in Actions is filed under one of these. Basil sorts new things itself; to correct one,
          click its label on the card. Basil learns from every one you file: file two from the same sender or project
          (three from a Slack channel or company) the same way, and it makes that a rule. File one somewhere else and the
          learned rule goes.
        </p>
        {score && score.checked > 0 && (
          <p className="text-sm">
            Basil’s own filing was right <span className="font-semibold">{Math.round((score.accuracy ?? 0) * 100)}%</span> of
            the {score.checked} times you checked it
            {score.recentAccuracy !== null ? <> ({Math.round(score.recentAccuracy * 100)}% over the last 30)</> : null}.
            It learns from {score.filings} filing{score.filings === 1 ? "" : "s"} of yours.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <ul className="grid gap-2 sm:grid-cols-2">
          {WORKSTREAMS.map((w) => (
            <li key={w.id} className="rounded-xl border p-3" style={{ background: w.bg }}>
              <p className="text-sm font-semibold" style={{ color: w.fg }}>{w.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{w.blurb}</p>
            </li>
          ))}
        </ul>
        <div>
          <p className="mb-2 text-sm font-medium">Your routing rules</p>
          {failed ? (
            <p className="text-sm text-destructive">Your rules could not be read just now.</p>
          ) : rules === null ? (
            <p className="text-sm text-muted-foreground">Reading…</p>
          ) : rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet. They appear when you tick “Always file … here” on a card, or when Basil spots a pattern in how you file.</p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {rules.map((r) => {
                const w = workstreamInfo(r.workstream);
                return (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span>
                      {FIELD_LABEL[r.field]}{r.field === "channel" ? "" : " "}<span className="font-medium">{r.value}</span>
                      {" → "}
                      <span className="font-semibold" style={{ color: w?.fg }}>{w?.label ?? r.workstream}</span>
                      {r.learned && (
                        <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          learned from {r.learned.from} of your filings
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove(r.id)}
                      disabled={busy === r.id}
                      aria-label={`Remove the rule for ${r.value}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted"
                    >
                      {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
