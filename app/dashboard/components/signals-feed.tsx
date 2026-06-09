"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Mail,
  Hash,
  AtSign,
  Inbox,
  Sparkles,
  Unplug,
  MessageSquare,
  Users,
  Pin,
  CircleDot,
  Zap,
  TrendingUp,
  AlertCircle,
  CheckSquare,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { basilFetch, BasilFetchError } from "@/lib/basil-fetch";
import { DataState } from "@/components/ui/data-state";
import { ConfidenceMeter } from "@/components/ui/trust-ui";

type Tab = "priority" | "mail" | "slack" | "linear" | "ranked";

// ── Ranked signal view (from /api/signals/ranked) ─────────────────────────────

interface RankedParticipant {
  name: string;
  email?: string;
  role: string;
  canonicalId?: string;
}

interface RankedSignalRanking {
  score: number;
  urgency: number;
  hierarchy: number;
  commercialImpact: number;
  relationshipWeight: number;
  commitmentRisk: number;
  meetingProximity: number;
  explanation: string[];
  rankedAt: string;
}

interface RankedSignalView {
  id: string;
  sourceRef: string;
  source: string;
  title: string;
  snippet: string;
  category: string;
  occurredAt: string;
  participants: RankedParticipant[];
  actionCount: number;
  decisionCount: number;
  ranking: RankedSignalRanking;
}

interface RankedResponse {
  signals: RankedSignalView[];
  total: number;
  thresholds: { surface: number; digest: number };
  flagsActive: { signalEvent_active: boolean; ranking_active: boolean };
  hint?: string;
}

interface Email {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  analysed?: boolean;
  materialized?: boolean;
}

interface SlackMessage {
  id: string;
  channel: string;
  channelId?: string;
  channelMembers?: string[];
  author: string;
  text: string;
  date: string;
  isMention: boolean;
  analysed?: boolean;
  materialized?: boolean;
}

interface LinearIssueData {
  id: string;
  identifier: string;   // e.g. "ENG-42"
  title: string;
  priority: number;     // 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low
  state: { name: string; type: string };
  team: { name: string };
  project?: { name: string } | null;
  dueDate?: string | null;
  url: string;
  updatedAt: string;
  analysed?: boolean;
  materialized?: boolean;
}

type SlackChannelKind = "dm" | "group" | "channel";

interface UnifiedSignal {
  id: string;
  kind: "mail" | "slack" | "linear";
  title: string;
  subtitle: string;
  body: string;
  date: string;
  priority: boolean;
  isDM?: boolean;
  isGroup?: boolean;
  isMention?: boolean;
  unread?: boolean;
  /** Raw slack channel kind for icon/badge rendering */
  channelKind?: SlackChannelKind;
  /** Pinned slot label from user settings (e.g. "Alice", "Alice + Bob", "#announcements") */
  pinnedLabel?: string;
  pinned?: boolean;
  /** Slack channel id — for click-to-expand history */
  channelId?: string;
  /** For Slack pinned rows: true if there are newer messages since last seen */
  hasUnreadSince?: boolean;
  /** Whether Basil has analysed this signal (cross-referenced from events store) */
  analysed?: boolean;
  /** Whether Basil extracted something actionable (action/decision/memory created) */
  materialized?: boolean;
  /** Linear issue priority (0–4) */
  linearPriority?: number;
  /** Linear deep link */
  linearUrl?: string;
}

// ── Pinned-slot matcher builder ───────────────────────────────────────────────
// Builds a matcher function from a plain-text name string stored in user settings.
// Supported formats:
//   "Alice"           → DM with that person
//   "Alice + Bob"     → group DM containing all listed names
//   "#general"        → Slack channel reference
function buildPinnedSlotMatcher(name: string): (m: SlackMessage) => boolean {
  // Channel reference (e.g. "#exec")
  if (name.startsWith("#")) {
    const ch = name.slice(1).trim();
    return (m) => new RegExp(`^#${ch}\\b`, "i").test(m.channel);
  }
  // Group DM (e.g. "Alice + Bob")
  if (name.includes("+")) {
    const parts = name.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
    return (m) => {
      if (!m.channelMembers || m.channelMembers.length !== parts.length) return false;
      const joined = m.channelMembers.join(" ").toLowerCase();
      return parts.every((p) => joined.includes(p));
    };
  }
  // Single DM — match channelMembers first (more reliable), then fall back to channel text
  const lower = name.trim().toLowerCase();
  return (m) => {
    if (!m.channel.startsWith("DM:")) return false;
    if (m.channelMembers?.length === 1) {
      return m.channelMembers[0].toLowerCase().includes(lower);
    }
    return new RegExp(`\\b${lower}\\b`, "i").test(m.channel);
  };
}

/**
 * Strip Slack's mrkdwn formatting codes so raw API text is readable in the feed.
 * Handles: <!date^ts^fmt|fallback>, <url|label>, <@USERID>, <!channel>, *bold*, _italic_
 */
function stripSlackFormatting(text: string): string {
  return text
    // Date tokens: <!date^unix^format|fallback> → use the human fallback
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, "$1")
    // Special commands: <!channel>, <!here>, <!everyone>
    .replace(/<!(\w+)>/g, "@$1")
    // User/channel mentions: <@USERID> or <#CHANID|name>
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    // Labelled URLs: <https://...|label> → label
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, "$1")
    // Bare URLs: <https://...> → strip angle brackets
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    // Bold/italic mrkdwn
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    // Multiple spaces/newlines → single space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Known Slack bot usernames / display names that should NOT be treated as
 * human DMs even though they arrive in a "DM:" channel.
 */
const SLACK_BOT_NAMES = /^(google calendar|slackbot|workflow builder|zapier|github|jira|asana|linear|notion|zoom|calendly|intercom|datadog|pagerduty|sentry|stripe|heroku|jenkins|circleci|hubspot|salesforce)$/i;

/** Cap overly long signal bodies. */
function clipSignal(text: string, max = 220): string {
  if (!text) return "";
  const cleaned = stripSlackFormatting(text);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1).trimEnd() + "…";
}

function relTime(d: string): string {
  try {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  } catch {
    return relativeTime(d);
  }
}

function TabButton({
  label,
  count,
  active,
  onClick,
  connected,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  /** undefined = loading/unknown, true = connected, false = disconnected */
  connected?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative px-3 py-1.5 text-xs font-medium tracking-tight transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      <span className="flex items-center gap-1.5">
        {/* Connection status dot — only shown for source tabs (Mail / Slack / Linear) */}
        {connected !== undefined && (
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full shrink-0",
              connected ? "bg-emerald-500" : "bg-red-400"
            )}
            title={connected ? `${label} connected` : `${label} not connected`}
          />
        )}
        {label}
        {typeof count === "number" && count > 0 && (
          <span
            className={cn(
              "inline-flex items-center justify-center h-4 min-w-4 rounded-full px-1 text-[12px] font-mono tabular-nums",
              active
                ? "bg-[oklch(0.72_0.15_85)]/15 text-[oklch(0.72_0.15_85)]"
                : "bg-muted text-muted-foreground"
            )}
          >
            {count}
          </span>
        )}
        {connected === false && (
          <span className="text-xs font-normal text-muted-foreground/60">
            (disconnected)
          </span>
        )}
      </span>
      {active && (
        <span className="absolute -bottom-[1px] left-2 right-2 h-[2px] bg-[oklch(0.72_0.15_85)] rounded-full" />
      )}
    </button>
  );
}

export function SignalsFeed() {
  const [mail, setMail] = useState<{ connected: boolean; emails: Email[] } | null>(null);
  const [slack, setSlack] = useState<{ connected: boolean; messages: SlackMessage[] } | null>(null);
  const [linear, setLinear] = useState<{ connected: boolean; issues: LinearIssueData[] } | null>(null);
  const [ranked, setRanked] = useState<RankedResponse | null>(null);
  const [tab, setTab] = useState<Tab>("priority");
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<BasilFetchError | Error | null>(null);
  /** Pinned-slot config built from user settings. Empty by default — no hardcoded contacts. */
  const [pinnedSlots, setPinnedSlots] = useState<Array<{ label: string; matches: (m: SlackMessage) => boolean }>>([]);

  // Fetch settings once to build pinned slots from the user's configured contact names
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.ok ? r.json() : null)
      .then((s: { pinnedSlackContacts?: string[] } | null) => {
        const names = s?.pinnedSlackContacts ?? [];
        setPinnedSlots(
          names.map((name) => ({ label: name, matches: buildPinnedSlotMatcher(name) }))
        );
      })
      .catch(() => { /* silently ignore — feed still works without pins */ });
  }, []);

  useEffect(() => {
    setLoading(true);
    setFetchError(null);
    Promise.allSettled([
      basilFetch<{ connected: boolean; emails: Email[] }>("/api/email", { component: "SignalsFeed" }),
      basilFetch<{ connected: boolean; messages: SlackMessage[] }>("/api/slack", { component: "SignalsFeed" }),
      basilFetch<{ connected: boolean; issues: LinearIssueData[] }>("/api/linear", { component: "SignalsFeed" }),
      basilFetch<RankedResponse>("/api/signals/ranked?tier=digest&limit=25", { component: "SignalsFeed" }),
    ]).then(([mResult, sResult, lResult, rResult]) => {
      // Apply each result independently — one failed endpoint shouldn't blank the others
      if (mResult.status === "fulfilled") setMail(mResult.value);
      if (sResult.status === "fulfilled") setSlack(sResult.value);
      if (lResult.status === "fulfilled") setLinear(lResult.value);
      if (rResult.status === "fulfilled") setRanked(rResult.value);

      // Only surface an error if ALL four failed (partial data is still useful)
      if (
        mResult.status === "rejected" && sResult.status === "rejected" &&
        lResult.status === "rejected" && rResult.status === "rejected"
      ) {
        setFetchError(mResult.reason instanceof Error ? mResult.reason : new Error("Failed to load signals"));
      }
      setLoading(false);
    });
  }, []);

  const signals: UnifiedSignal[] = useMemo(() => {
    const mailSignals: UnifiedSignal[] = (mail?.emails ?? []).map((e) => ({
      id: `mail-${e.id}`,
      kind: "mail",
      title: e.from,
      subtitle: e.subject,
      body: clipSignal(e.snippet),
      date: e.date,
      // Use server-computed priority (filters marketing/automated emails).
      // Fall back to unread for backwards-compatibility if the field is absent.
      priority: (e as { priority?: boolean }).priority ?? e.unread,
      unread: e.unread,
      analysed: e.analysed,
      materialized: e.materialized,
    }));

    const slackSignals: UnifiedSignal[] = (slack?.messages ?? []).map((m) => {
      const isGroup = m.channel === "Group DM";
      const isDM = m.channel.startsWith("DM:");
      const channelKind: SlackChannelKind = isGroup
        ? "group"
        : isDM
          ? "dm"
          : "channel";
      // Bots (Google Calendar, Slackbot, etc.) arrive as DMs but are not human —
      // exclude them from priority even though isDM is true.
      const isBot = SLACK_BOT_NAMES.test(m.author.trim());
      return {
        id: `slack-${m.id}`,
        kind: "slack",
        title: m.author,
        subtitle: m.channel,
        body: clipSignal(m.text),
        date: m.date,
        priority: !isBot && (m.isMention || isDM || isGroup),
        isDM,
        isGroup,
        isMention: m.isMention,
        channelKind,
        analysed: m.analysed,
        materialized: m.materialized,
      };
    });

    const linearSignals: UnifiedSignal[] = (linear?.issues ?? []).map((issue) => {
      const metaParts: string[] = [issue.state.name, issue.team.name];
      if (issue.project?.name) metaParts.push(issue.project.name);
      if (issue.dueDate) metaParts.push(`Due ${issue.dueDate}`);
      return {
        id: `linear-${issue.id}`,
        kind: "linear",
        title: issue.identifier,      // e.g. "ENG-42"
        subtitle: issue.title,        // human-readable title
        body: metaParts.join(" · "),  // "In Progress · Engineering · Platform"
        date: issue.updatedAt,
        priority: issue.priority === 1 || issue.priority === 2,
        analysed: issue.analysed,
        materialized: issue.materialized,
        linearPriority: issue.priority,
        linearUrl: issue.url,
      };
    });

    return [...mailSignals, ...slackSignals, ...linearSignals].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }, [mail, slack, linear]);

  // Track last-seen timestamps per pinned channel so we can show "new" dots
  const [lastSeenByChannel, setLastSeenByChannel] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem("sage-slack-pinned-lastseen");
      if (raw) setLastSeenByChannel(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const markSeen = useCallback((channelId: string, ts: string) => {
    setLastSeenByChannel((prev) => {
      const next = { ...prev, [channelId]: ts };
      try {
        localStorage.setItem("sage-slack-pinned-lastseen", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Pinned rows: latest Slack message matching each slot.
  // Surfaced at top of Priority and Slack tabs regardless of age.
  const pinnedSignals: UnifiedSignal[] = useMemo(() => {
    const all = slack?.messages ?? [];
    if (all.length === 0 || pinnedSlots.length === 0) return [];
    return pinnedSlots.flatMap(({ label, matches }) => {
      const latest = all
        .filter(matches)
        .sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        )[0];
      if (!latest) return [];
      // A slot label containing "+" indicates a group DM (e.g. "Alice + Bob")
      const isGroup = label.includes("+") || latest.channel.startsWith("Group DM");
      const isDM = latest.channel.startsWith("DM:") && !isGroup;
      const channelKind: SlackChannelKind = isGroup
        ? "group"
        : isDM
          ? "dm"
          : "channel";
      const seen = latest.channelId ? lastSeenByChannel[latest.channelId] : undefined;
      const hasUnreadSince = seen
        ? new Date(latest.date).getTime() > new Date(seen).getTime()
        : true;
      return [
        {
          id: `pin-${label}-${latest.id}`,
          kind: "slack" as const,
          title: latest.author,
          subtitle: latest.channel,
          body: clipSignal(latest.text),
          date: latest.date,
          priority: true,
          isDM,
          isGroup,
          isMention: latest.isMention,
          channelKind,
          pinned: true,
          pinnedLabel: label,
          channelId: latest.channelId,
          hasUnreadSince,
        },
      ];
    });
  }, [slack, lastSeenByChannel, pinnedSlots]);

  const priority = signals.filter((s) => s.priority);
  const mailOnly = signals.filter((s) => s.kind === "mail");
  const slackOnly = signals.filter((s) => s.kind === "slack");
  const linearOnly = signals.filter((s) => s.kind === "linear");

  // Dedupe: if a signal is already pinned, don't repeat it below the pinned block
  const pinnedSourceIds = new Set(
    pinnedSignals.map((p) => p.id.replace(/^pin-[^-]+-/, "slack-"))
  );
  const shown =
    tab === "priority"
      ? [
          ...pinnedSignals,
          ...priority.filter((s) => !pinnedSourceIds.has(s.id)),
        ]
      : tab === "mail"
        ? mailOnly
        : tab === "slack"
          ? [
              ...pinnedSignals,
              // Only show signals relevant to the user: DMs, mentions, group DMs.
              // Channel noise (posts in channels the user doesn't participate in)
              // and bot DMs (Google Calendar, Slackbot, etc.) are excluded.
              ...slackOnly.filter((s) => s.priority && !pinnedSourceIds.has(s.id)),
            ]
          : linearOnly;

  const mailConnected = mail?.connected;
  const slackConnected = slack?.connected;
  const linearConnected = linear?.connected;
  const allDisconnected = !mailConnected && !slackConnected && !linearConnected;

  const rankedSignals = ranked?.signals ?? [];
  const rankedActive = ranked?.flagsActive?.ranking_active ?? false;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Inbox className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
            Signals
          </CardTitle>
          <p className="text-[12px] text-muted-foreground font-mono">Unified feed</p>
        </div>
        <div className="flex items-center gap-1 border-b border-border mt-2 -mx-4 px-4">
          <TabButton
            label="Priority"
            count={priority.length}
            active={tab === "priority"}
            onClick={() => setTab("priority")}
          />
          <TabButton
            label="Mail"
            count={mailOnly.filter((s) => s.unread).length}
            active={tab === "mail"}
            onClick={() => setTab("mail")}
            connected={mail === null ? undefined : !!mail.connected}
          />
          <TabButton
            label="Slack"
            count={slackOnly.filter((s) => s.priority).length}
            active={tab === "slack"}
            onClick={() => setTab("slack")}
            connected={slack === null ? undefined : !!slack.connected}
          />
          <TabButton
            label="Issues"
            count={linearOnly.filter((s) => s.priority).length}
            active={tab === "linear"}
            onClick={() => setTab("linear")}
            connected={linear === null ? undefined : !!linear.connected}
          />
          <TabButton
            label="Ranked"
            count={rankedActive ? rankedSignals.length : undefined}
            active={tab === "ranked"}
            onClick={() => setTab("ranked")}
          />
        </div>
      </CardHeader>
      <CardContent className="pt-3">
        {/* ── Ranked tab has its own render path ─────────────────────────── */}
        {tab === "ranked" ? (
          loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          ) : !rankedActive ? (
            <div className="py-8 text-center">
              <TrendingUp className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {ranked?.hint ?? "Enable ranking_active flag to see Basil's scored signals."}
              </p>
            </div>
          ) : rankedSignals.length === 0 ? (
            <div className="py-8 text-center">
              <Sparkles className="h-6 w-6 text-[oklch(0.72_0.15_85)]/60 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No signals above score threshold yet.</p>
            </div>
          ) : (
            <div className="space-y-0.5 max-h-[380px] overflow-y-auto -mx-2 pr-1">
              {rankedSignals.map((s) => (
                <RankedSignalRow key={s.id} signal={s} />
              ))}
            </div>
          )
        ) : (
          /* ── Standard tabs ──────────────────────────────────────────────── */
          loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          ) : fetchError ? (
            <DataState error={fetchError} fill />
          ) : allDisconnected ? (
            <div className="flex flex-col items-center py-8 text-center">
              <Unplug className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">Connect Gmail, Slack, or Linear to see signals.</p>
              <Link
                href="/dashboard/settings"
                className="text-xs text-[oklch(0.72_0.15_85)] hover:underline mt-2"
              >
                Settings →
              </Link>
            </div>
          ) : shown.length === 0 ? (
            <div className="py-8 text-center">
              <Sparkles className="h-6 w-6 text-[oklch(0.72_0.15_85)]/60 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {tab === "priority"
                  ? "Inbox zero. Nothing urgent."
                  : tab === "linear" && !linearConnected
                    ? "Connect Linear in Settings to see issues."
                    : "Nothing new."}
              </p>
              {tab === "linear" && !linearConnected && (
                <Link
                  href="/dashboard/settings"
                  className="text-xs text-[oklch(0.72_0.15_85)] hover:underline mt-2 inline-block"
                >
                  Settings →
                </Link>
              )}
            </div>
          ) : (
            <div className="space-y-0.5 max-h-[380px] overflow-y-auto -mx-2 pr-1">
              {shown.slice(0, 14).map((s) => (
                <SignalRow
                  key={s.id}
                  signal={s}
                  onExpand={(ts) => s.channelId && markSeen(s.channelId, ts)}
                />
              ))}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

// ── Single signal row ──────────────────────────────────────────────────────────
// Pinned Slack rows expand on click to show last 10 msgs.
// Linear rows open the issue URL in a new tab on click.
function SignalRow({
  signal: s,
  onExpand,
}: {
  signal: UnifiedSignal;
  onExpand: (latestTs: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<SlackMessage[] | null>(null);
  const [loadingHist, setLoadingHist] = useState(false);

  const isLinear = s.kind === "linear";
  const canExpand = s.pinned && s.kind === "slack" && !!s.channelId;
  const isClickable = isLinear || canExpand;

  const Icon =
    s.kind === "mail"
      ? Mail
      : s.kind === "linear"
        ? CircleDot
        : s.channelKind === "dm"
          ? MessageSquare
          : s.channelKind === "group"
            ? Users
            : Hash;

  const iconColor =
    s.kind === "mail"
      ? "text-blue-500/70"
      : s.kind === "linear"
        ? s.linearPriority === 1
          ? "text-red-500"
          : s.linearPriority === 2
            ? "text-orange-500"
            : s.linearPriority === 3
              ? "text-violet-500/70"
              : "text-muted-foreground/50"
        : s.channelKind === "dm"
          ? "text-blue-500"
          : s.channelKind === "group"
            ? "text-violet-500"
            : "text-amber-500/80";

  const toggle = async () => {
    // Linear: open issue in new tab
    if (isLinear && s.linearUrl) {
      window.open(s.linearUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (!canExpand) return;
    const next = !expanded;
    setExpanded(next);
    if (next && !history) {
      setLoadingHist(true);
      try {
        const res = await fetch(
          `/api/slack/history?channelId=${encodeURIComponent(s.channelId!)}&limit=10`
        );
        const data = await res.json();
        setHistory(data.messages || []);
        onExpand(s.date);
      } catch {
        setHistory([]);
      } finally {
        setLoadingHist(false);
      }
    } else if (next) {
      onExpand(s.date);
    }
  };

  return (
    <div
      className={cn(
        "group relative rounded-md px-2 py-2 hover:bg-accent/40 transition-colors",
        isClickable && "cursor-pointer",
        s.pinned && "bg-[oklch(0.72_0.15_85)]/[0.04]"
      )}
      onClick={toggle}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
              }
            }
          : undefined
      }
    >
      {(s.priority || s.pinned) && (
        <span className="absolute left-0 top-2.5 h-[calc(100%-1.25rem)] w-[2px] rounded-r-full bg-[oklch(0.72_0.15_85)]" />
      )}
      <div className="flex items-center gap-2 mb-0.5">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />
        <span className="text-xs font-medium truncate">{s.title}</span>
        {/* Slack pinned label */}
        {s.pinned && s.pinnedLabel && (
          <span className="inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-wider text-[oklch(0.58_0.15_85)] shrink-0">
            <Pin className="h-2.5 w-2.5" />
            {s.pinnedLabel}
          </span>
        )}
        {s.hasUnreadSince && s.pinned && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-[oklch(0.72_0.15_85)] shrink-0"
            title="New since you last looked"
            aria-label="Unread"
          />
        )}
        {/* Slack badges */}
        {s.isMention && (
          <AtSign className="h-3 w-3 text-[oklch(0.72_0.15_85)] shrink-0" />
        )}
        {s.channelKind === "dm" && (
          <span className="rounded-sm bg-blue-500/10 text-blue-600 text-[12px] font-mono uppercase tracking-wider px-1.5 py-0.5 shrink-0">
            DM
          </span>
        )}
        {s.channelKind === "group" && (
          <span className="rounded-sm bg-violet-500/10 text-violet-600 text-[12px] font-mono uppercase tracking-wider px-1.5 py-0.5 shrink-0">
            Group
          </span>
        )}
        {/* Linear priority badges */}
        {s.kind === "linear" && s.linearPriority === 1 && (
          <span className="rounded-sm bg-red-500/10 text-red-600 text-[12px] font-mono uppercase tracking-wider px-1.5 py-0.5 shrink-0">
            Urgent
          </span>
        )}
        {s.kind === "linear" && s.linearPriority === 2 && (
          <span className="rounded-sm bg-orange-500/10 text-orange-600 text-[12px] font-mono uppercase tracking-wider px-1.5 py-0.5 shrink-0">
            High
          </span>
        )}
        {/* Analysis status dots */}
        {s.materialized === true && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0"
            title="Basil extracted an action, decision, or memory from this"
          />
        )}
        {s.analysed === true && s.materialized !== true && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0"
            title="Basil analysed this but found nothing to extract"
          />
        )}
        <span className="text-[12px] font-mono text-muted-foreground ml-auto shrink-0 tabular-nums">
          {relTime(s.date)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground truncate pl-5">
        <span className="text-foreground/80">{s.subtitle}</span>
        <span className="mx-1.5 text-muted-foreground/40">·</span>
        <span>{s.body}</span>
      </p>
      {/* Slack channel history expansion */}
      {expanded && (
        <div className="mt-2 ml-5 pl-3 border-l border-border/70 space-y-1.5">
          {loadingHist ? (
            <>
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </>
          ) : !history || history.length === 0 ? (
            <p className="text-[12px] text-muted-foreground italic">
              No recent messages.
            </p>
          ) : (
            history.map((m) => (
              <div key={m.id} className="text-[12px] leading-snug">
                <div className="flex items-baseline gap-1.5">
                  <span className="font-medium text-foreground/90">
                    {m.author}
                  </span>
                  <span className="text-[12px] font-mono text-muted-foreground tabular-nums">
                    {relTime(m.date)}
                  </span>
                </div>
                <p className="text-muted-foreground">{clipSignal(m.text, 320)}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Ranked signal row ─────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  action_required:    "Action",
  decision_made:      "Decision",
  relationship_signal:"Relation",
  commercial_signal:  "Commercial",
  meeting_intelligence:"Meeting",
  document_activity:  "Document",
  issue_update:       "Issue",
  low_value_noise:    "Noise",
  unknown:            "Unknown",
};

const SCORE_COLOR = (score: number) =>
  score >= 0.70 ? "text-[oklch(0.72_0.15_85)] bg-[oklch(0.72_0.15_85)]/10"
  : score >= 0.50 ? "text-amber-600 bg-amber-500/10"
  : "text-muted-foreground bg-muted";

const SOURCE_ICON: Record<string, React.ReactNode> = {
  gmail:    <Mail className="h-3.5 w-3.5 text-blue-500/70" />,
  outlook:  <Mail className="h-3.5 w-3.5 text-blue-600/70" />,
  slack:    <Hash className="h-3.5 w-3.5 text-amber-500/80" />,
  teams:    <Hash className="h-3.5 w-3.5 text-violet-500/70" />,
  linear:   <CircleDot className="h-3.5 w-3.5 text-violet-500/70" />,
};

function RankedSignalRow({ signal: s }: { signal: RankedSignalView }) {
  const score = s.ranking.score;
  const isUrgent = s.ranking.urgency >= 0.7;

  return (
    <div className="group relative rounded-md px-2 py-2 hover:bg-accent/40 transition-colors">
      {/* Left accent: gold for surface-tier, muted for digest-tier */}
      {score >= 0.70 && (
        <span className="absolute left-0 top-2.5 h-[calc(100%-1.25rem)] w-[2px] rounded-r-full bg-[oklch(0.72_0.15_85)]" />
      )}
      <div className="flex items-center gap-2 mb-0.5">
        {/* Source icon */}
        <span className="shrink-0">
          {SOURCE_ICON[s.source] ?? <Zap className="h-3.5 w-3.5 text-muted-foreground/50" />}
        </span>
        {/* Title */}
        <span className="text-xs font-medium truncate">{s.title}</span>
        {/* Urgency flash */}
        {isUrgent && (
          <span title="High urgency">
            <AlertCircle className="h-3 w-3 text-red-500 shrink-0" />
          </span>
        )}
        {/* Category badge */}
        <span className="rounded-sm bg-muted text-muted-foreground text-xs font-mono uppercase tracking-wider px-1.5 py-0.5 shrink-0">
          {CATEGORY_LABELS[s.category] ?? s.category}
        </span>
        {/* Score — compact meter replaces raw number */}
        <span className="ml-auto shrink-0 w-14">
          <ConfidenceMeter value={score} showLabel={false} />
        </span>
        <span className="text-[12px] font-mono text-muted-foreground shrink-0 tabular-nums">
          {relTime(s.occurredAt)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground truncate pl-5">
        <span className="text-foreground/80">{s.snippet}</span>
      </p>
      {/* Action / decision counts */}
      {(s.actionCount > 0 || s.decisionCount > 0) && (
        <div className="flex items-center gap-2 mt-1 pl-5">
          {s.actionCount > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
              <CheckSquare className="h-2.5 w-2.5" />
              {s.actionCount} action{s.actionCount !== 1 ? "s" : ""}
            </span>
          )}
          {s.decisionCount > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
              <Zap className="h-2.5 w-2.5" />
              {s.decisionCount} decision{s.decisionCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
