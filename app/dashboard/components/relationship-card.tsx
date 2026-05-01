"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Flame,
  RefreshCw,
  Loader2,
  Wifi,
  ArrowUpRight,
  MessageSquare,
  Info,
} from "lucide-react";
import { contacts as staticContacts } from "@/lib/contacts-data";

interface ContactActivity {
  contactId: string;
  name: string;
  lastInteraction: string | null;
  sources: string[];
  recentItems: string[];
}

interface ActivityData {
  activity: ContactActivity[];
  fetchedAt: string;
  dataSources: {
    calendarEvents: number;
    emails: number;
    slackMessages: number;
    driveFiles?: number;
    zoomMeetings?: number;
    linearItems?: number;
  };
}

// ── Relationship temperature buckets ──
// Human names chosen over jargon: "In the loop" > "warm"
export type Bucket = "loop" | "drifting" | "cold" | "unknown";

// Day thresholds used to bucket a contact's last-interaction freshness.
// Exported so other surfaces (Basil prompts, contact detail pages, tests) can
// reason about "cold" vs. "drifting" without duplicating the numbers.
// `loop` = interacted within BUCKET_DAYS.loopMax days;
// `drifting` = within BUCKET_DAYS.driftingMax days; beyond that = `cold`.
export const BUCKET_DAYS = {
  loopMax: 5,
  driftingMax: 10,
  /** Sentinel days value when we have no interaction data at all. */
  noSignal: 999,
} as const;

interface BucketStyle {
  label: string;
  hint: string;
  dot: string;
  text: string;
  ring: string;
  bg: string;
}

const BUCKET_STYLE: Record<Bucket, BucketStyle> = {
  loop: {
    label: "In the loop",
    hint: `Spoken in the last ${BUCKET_DAYS.loopMax} days`,
    dot: "bg-emerald-500",
    text: "text-emerald-600",
    ring: "ring-emerald-500/60",
    bg: "bg-emerald-500/[0.06]",
  },
  drifting: {
    label: "Drifting",
    hint: `${BUCKET_DAYS.loopMax + 1}–${BUCKET_DAYS.driftingMax} days since last contact`,
    dot: "bg-amber-500",
    text: "text-amber-600",
    ring: "ring-amber-500/60",
    bg: "bg-amber-500/[0.06]",
  },
  cold: {
    label: "Going cold",
    hint: `${BUCKET_DAYS.driftingMax + 1}+ days — overdue for a touchpoint`,
    dot: "bg-rose-500",
    text: "text-rose-600",
    ring: "ring-rose-500/60",
    bg: "bg-rose-500/[0.06]",
  },
  unknown: {
    label: "No signal",
    hint: "No interaction data yet",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    ring: "ring-border",
    bg: "bg-muted/40",
  },
};

export function bucketFor(days: number): Bucket {
  if (days === BUCKET_DAYS.noSignal) return "unknown";
  if (days <= BUCKET_DAYS.loopMax) return "loop";
  if (days <= BUCKET_DAYS.driftingMax) return "drifting";
  return "cold";
}

function daysLabel(days: number): string {
  if (days === BUCKET_DAYS.noSignal) return "—";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

// Stale threshold: auto-refresh if cached data is older than this many ms.
const STALE_MS = 30 * 60 * 1000; // 30 minutes

export function RelationshipCard() {
  const [liveData, setLiveData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);

  const refreshActivity = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/contacts/activity");
      if (!res.ok) throw new Error("Failed to fetch");
      const data: ActivityData = await res.json();
      setLiveData(data);
      setLastRefresh(data.fetchedAt);
      localStorage.setItem("sage-contact-activity", JSON.stringify(data));
    } catch (e) {
      console.error("Activity refresh failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount: load from cache immediately, then auto-fetch if absent or stale.
  useEffect(() => {
    const cached = localStorage.getItem("sage-contact-activity");
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        setLiveData(parsed);
        setLastRefresh(parsed.fetchedAt);
        // Background-refresh if cache is stale
        const age = Date.now() - new Date(parsed.fetchedAt).getTime();
        if (age > STALE_MS) refreshActivity();
      } catch {
        refreshActivity(); // corrupt cache → re-fetch
      }
    } else {
      // No cache at all → fetch immediately
      refreshActivity();
    }
  }, [refreshActivity]);

  const enriched = useMemo(() => {
    return staticContacts
      .map((c) => {
        const liveActivity = liveData?.activity.find(
          (a) => a.contactId === c.id
        );
        const lastInteraction =
          liveActivity?.lastInteraction || c.lastInteraction || null;
        const days = lastInteraction
          ? Math.floor(
              (Date.now() - new Date(lastInteraction).getTime()) / 86400000
            )
          : BUCKET_DAYS.noSignal;
        return {
          ...c,
          lastInteraction,
          days,
          liveActivity,
          bucket: bucketFor(days),
        };
      })
      .sort((a, b) => b.days - a.days); // stale first
  }, [liveData]);

  const groupedByBucket = useMemo(() => {
    const g: Record<Bucket, typeof enriched> = {
      cold: [],
      drifting: [],
      loop: [],
      unknown: [],
    };
    for (const c of enriched) g[c.bucket].push(c);
    return g;
  }, [enriched]);

  // The 2 stalest real-contacts (have interaction data) — these get featured cards.
  const needsAttention = useMemo(
    () => [...groupedByBucket.cold, ...groupedByBucket.drifting].slice(0, 2),
    [groupedByBucket]
  );

  return (
    <Card className="border-[oklch(0.72_0.15_85)]/30">
      <CardHeader className="flex flex-row items-start justify-between pb-3 gap-3">
        <div className="space-y-1">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Flame className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
            Who needs you this week
          </CardTitle>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
            Basil tracks how recently you&apos;ve been in contact with key people —
            via Calendar, Gmail, Slack, Zoom, and Google Docs — and flags
            relationships that are cooling off.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowExplainer((v) => !v)}
            aria-label="How this works"
            className="text-muted-foreground/60 hover:text-foreground transition-colors"
            title="How this works"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          {liveData && (
            <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[12px] gap-1">
              <Wifi className="h-2.5 w-2.5" /> Live
            </Badge>
          )}
          <button
            onClick={refreshActivity}
            disabled={loading}
            className="text-muted-foreground/60 hover:text-[oklch(0.72_0.15_85)] transition-colors"
            title="Refresh from Calendar, Gmail & Slack"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* First-load skeleton — shown when fetching with no cached data */}
        {loading && !liveData && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[40, 56, 48, 44, 52, 36].map((w, i) => (
                <Skeleton key={i} className={`h-6 w-${w < 45 ? "14" : w < 50 ? "16" : "20"} rounded-full`} />
              ))}
            </div>
          </div>
        )}

        {/* Explainer (collapsible) */}
        {showExplainer && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1.5">
            <p>
              Each person&apos;s status reflects their most recent interaction
              across your connected channels:
            </p>
            <ul className="space-y-1 pl-2">
              {(["loop", "drifting", "cold"] as Bucket[]).map((k) => {
                const s = BUCKET_STYLE[k];
                return (
                  <li key={k} className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                    <span className={`font-medium ${s.text}`}>{s.label}</span>
                    <span>— {s.hint}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Featured: who needs you first */}
        {needsAttention.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {needsAttention.map((c) => {
              const s = BUCKET_STYLE[c.bucket];
              return (
                <div
                  key={c.id}
                  className={`relative rounded-lg ring-1 ring-inset ring-border ${s.bg} p-3 flex items-center gap-3`}
                >
                  <Avatar className={`h-10 w-10 ring-2 ${s.ring}`}>
                    <AvatarFallback
                      className={`text-xs text-white font-medium ${c.color}`}
                    >
                      {c.initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium truncate">{c.name}</p>
                      <span
                        className={`text-[12px] font-semibold uppercase tracking-wider ${s.text}`}
                      >
                        {s.label}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      Last contact {daysLabel(c.days)}
                      {c.title ? ` · ${c.title}` : ""}
                    </p>
                    {c.liveActivity?.recentItems[0] && (
                      <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">
                        {c.liveActivity.recentItems[0]}
                      </p>
                    )}
                  </div>
                  <Link
                    href={`/dashboard/chat?q=${encodeURIComponent(`Draft a check-in message to ${c.name}`)}`}
                    className="shrink-0 inline-flex items-center gap-1 rounded-md bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-[12px] font-semibold px-2.5 py-1.5 hover:brightness-105 transition"
                    title={`Ask Basil to draft a check-in to ${c.name}`}
                  >
                    <MessageSquare className="h-3 w-3" />
                    Reach out
                  </Link>
                </div>
              );
            })}
          </div>
        )}

        {/* Bucketed avatar rows */}
        <div className="space-y-2.5">
          {(["cold", "drifting", "loop", "unknown"] as Bucket[])
            .filter((b) => groupedByBucket[b].length > 0)
            .map((bucket) => {
              const s = BUCKET_STYLE[bucket];
              const list = groupedByBucket[bucket];
              return (
                <div key={bucket} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                    <p
                      className={`text-[12px] font-semibold uppercase tracking-[0.18em] ${s.text}`}
                    >
                      {s.label}
                    </p>
                    <p className="text-[12px] text-muted-foreground">
                      {s.hint}
                    </p>
                    <span className="text-[12px] font-mono text-muted-foreground ml-auto tabular-nums">
                      {list.length}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pl-4">
                    {list.map((c) => (
                      <Tooltip key={c.id}>
                        <TooltipTrigger asChild>
                          <Link
                            href="/dashboard/contacts"
                            className={`inline-flex items-center gap-1.5 rounded-full ring-1 ${s.ring} bg-background pr-2.5 transition-all hover:shadow-sm`}
                          >
                            <Avatar className="h-6 w-6">
                              <AvatarFallback
                                className={`text-[12px] text-white font-medium ${c.color}`}
                              >
                                {c.initials}
                              </AvatarFallback>
                            </Avatar>
                            <span className="text-[12px] font-medium pr-0.5">
                              {c.name.split(" ")[0]}
                            </span>
                            <ArrowUpRight className="h-2.5 w-2.5 text-muted-foreground/60" />
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent
                          side="bottom"
                          className="text-xs max-w-52"
                        >
                          <p className="font-medium">{c.name}</p>
                          <p className="text-muted-foreground">
                            {daysLabel(c.days)}
                            {c.liveActivity?.sources.length
                              ? ` · ${c.liveActivity.sources.join(", ")}`
                              : ""}
                          </p>
                          {c.liveActivity?.recentItems[0] && (
                            <p className="text-muted-foreground mt-0.5 truncate">
                              {c.liveActivity.recentItems[0]}
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>

        {/* Footer meta */}
        {lastRefresh && (
          <div className="pt-1 border-t border-border/70 flex items-center justify-between text-[12px] text-muted-foreground">
            <span>
              {liveData?.dataSources
                ? [
                    `${liveData.dataSources.calendarEvents} cal`,
                    `${liveData.dataSources.emails} mail`,
                    `${liveData.dataSources.slackMessages} slack`,
                    liveData.dataSources.driveFiles !== undefined
                      ? `${liveData.dataSources.driveFiles} docs`
                      : null,
                    liveData.dataSources.zoomMeetings !== undefined && liveData.dataSources.zoomMeetings > 0
                      ? `${liveData.dataSources.zoomMeetings} zoom`
                      : null,
                    liveData.dataSources.linearItems !== undefined && liveData.dataSources.linearItems > 0
                      ? `${liveData.dataSources.linearItems} linear`
                      : null,
                  ].filter(Boolean).join(" · ")
                : "calendar · email · slack · docs"}
            </span>
            <span>
              Updated{" "}
              {new Date(lastRefresh).toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Europe/London",
              })}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
