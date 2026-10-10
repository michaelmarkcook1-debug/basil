"use client";

/**
 * Tone & sentiment for one relationship: how this person comes across now,
 * which way it's moving, and the messages that show it — read from the last 30
 * days of Slack and email (lib/contacts/sentiment.ts). The shifts the message
 * classifier noticed over time sit underneath.
 */
import useSWR from "swr";
import { useState } from "react";
import { Loader2, MessageCircle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ToneObservation } from "@/lib/contact-profile-overrides";

export type Tone = "warm" | "positive" | "neutral" | "cool" | "strained";
export type Trend = "warming" | "steady" | "cooling";
export interface RelationshipSentiment {
  contactId: string;
  tone: Tone;
  trend: Trend;
  summary: string;
  evidence: Array<{ date: string; source: string; note: string }>;
  basedOn: number;
  latestAt: string;
  computedAt: string;
}

export const TONE: Record<Tone, { label: string; chip: string; dot: string }> = {
  warm:     { label: "Warm",     chip: "bg-signal-positive-subtle text-signal-positive", dot: "bg-signal-positive" },
  positive: { label: "Positive", chip: "bg-signal-positive-subtle text-signal-positive", dot: "bg-signal-positive/70" },
  neutral:  { label: "Neutral",  chip: "bg-muted/60 text-muted-foreground",              dot: "bg-slate-400" },
  cool:     { label: "Cool",     chip: "bg-signal-warning-subtle text-signal-warning",   dot: "bg-signal-warning" },
  strained: { label: "Strained", chip: "bg-signal-critical-subtle text-signal-critical", dot: "bg-signal-critical" },
};
export const TREND: Record<Trend, { label: string; chip: string }> = {
  warming: { label: "↑ Warming", chip: "bg-signal-positive-subtle text-signal-positive" },
  steady:  { label: "→ Steady",  chip: "bg-muted/60 text-muted-foreground" },
  cooling: { label: "↓ Cooling", chip: "bg-signal-warning-subtle text-signal-warning" },
};

/** "Warm · warming" — for tooltips and list dots. */
export function toneLine(s: RelationshipSentiment): string {
  return `${TONE[s.tone].label} · ${TREND[s.trend].label.slice(2).toLowerCase()}`;
}

interface OneResponse { sentiment: RelationshipSentiment | null; interactions: number; minInteractions: number; error?: string }

async function fetchOne(url: string): Promise<OneResponse> {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || "Could not read this relationship.");
  return j as OneResponse;
}

const ago = (iso: string) => {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1 ? "just now" : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

export function RelationshipToneCard({
  contactId, name, shifts = [], onUpdated,
}: { contactId: string; name: string; shifts?: ToneObservation[]; onUpdated?: () => void }) {
  const key = `/api/contacts/sentiment?id=${encodeURIComponent(contactId)}`;
  const { data, error, isLoading, mutate } = useSWR<OneResponse>(key, fetchOne, { revalidateOnFocus: false });
  const [refreshing, setRefreshing] = useState(false);
  const first = name.split(/\s+/)[0];
  const s = data?.sentiment ?? null;

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await fetch("/api/contacts/sentiment", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: contactId }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { await mutate(j as OneResponse, { revalidate: false }); onUpdated?.(); }
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xs font-semibold tracking-widest uppercase text-[color:var(--w-carbon)] flex items-center gap-1.5">
            <MessageCircle className="h-3.5 w-3.5" /> Tone &amp; sentiment
          </CardTitle>
          {s && (
            <Button type="button" size="xs" variant="ghost" onClick={refresh} disabled={refreshing} aria-label={`Re-read the relationship with ${first}`}>
              {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-read
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p role="alert" className="text-sm text-signal-critical">{error.message}</p>
        ) : isLoading || !data ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading the last 30 days with {first}…
          </p>
        ) : !s ? (
          <p className="text-sm text-muted-foreground">
            Not enough recent messages with {first} to read the tone yet
            {` (${data.interactions} in the last 30 days; Basil needs ${data.minInteractions}).`}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${TONE[s.tone].chip}`}>{TONE[s.tone].label}</span>
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${TREND[s.trend].chip}`}>{TREND[s.trend].label}</span>
            </div>
            <p className="text-sm leading-relaxed">{s.summary}</p>
            {s.evidence.length > 0 && (
              <ul className="space-y-1.5">
                {s.evidence.map((e, i) => (
                  <li key={i} className="text-[0.8125rem] text-foreground/90">
                    <span className="text-muted-foreground">{e.date} · {e.source} — </span>{e.note}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Read from {s.basedOn} message{s.basedOn === 1 ? "" : "s"} · updated {ago(s.computedAt)}
            </p>
          </>
        )}

        {shifts.length > 0 && (
          <div className="border-t border-[var(--w-rule)] pt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Shifts Basil noticed</p>
            <ul className="space-y-2">
              {[...shifts].reverse().map((obs, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    obs.direction === "warming" ? "bg-signal-positive" : obs.direction === "cooling" ? "bg-signal-warning" : "bg-slate-400"
                  }`} />
                  <div className="min-w-0">
                    <span className="text-foreground/90">{obs.summary}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{obs.date} · via {obs.source}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
