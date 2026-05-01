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
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

type Tab = "priority" | "mail" | "slack";

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

type SlackChannelKind = "dm" | "group" | "channel";

interface UnifiedSignal {
  id: string;
  kind: "mail" | "slack";
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
  /** Pinned slot label (e.g. "Malcolm", "Ed", "#exec") */
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
}

// Top-of-feed slots: always surface latest message from each, regardless of age.
// Matching prefers `channelMembers` (resolved names) over fuzzy text so the
// "Michael + Malcolm + Ed" group DM can be uniquely identified.
const PINNED_SLOTS: Array<{
  label: string;
  matches: (m: SlackMessage) => boolean;
}> = [
  {
    label: "Malcolm",
    matches: (m) => {
      if (!m.channel.startsWith("DM:")) return false;
      if (m.channelMembers?.length === 1) {
        return m.channelMembers[0].includes("malcolm");
      }
      return /malcolm/i.test(m.channel);
    },
  },
  {
    label: "Ed",
    matches: (m) => {
      if (!m.channel.startsWith("DM:")) return false;
      if (m.channelMembers?.length === 1) {
        return m.channelMembers[0] === "ed" || m.channelMembers[0].startsWith("ed");
      }
      return /\bed\b/i.test(m.channel);
    },
  },
  {
    label: "Malcolm + Ed",
    matches: (m) => {
      // Group DM with both Malcolm and Ed (2 others = 3-way with Michael)
      if (!m.channelMembers || m.channelMembers.length !== 2) return false;
      const joined = m.channelMembers.join(" ");
      return /malcolm/i.test(joined) && /\bed\b/i.test(joined);
    },
  },
  {
    label: "#exec",
    matches: (m) => /^#exec\b/i.test(m.channel),
  },
];

/** Cap overly long signal bodies so one wall-of-text message can't dominate
 *  the feed. The row itself uses `truncate` CSS for single-line collapse, but
 *  expanded Slack history wraps — and we'd rather show "…" than 5 lines. */
function clipSignal(text: string, max = 220): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + "…";
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
        {/* Connection status dot — only shown for source tabs (Mail / Slack) */}
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
        {connected === false && (
          <span className="text-[10px] font-normal text-muted-foreground/60">
            (disconnected)
          </span>
        )}
      </span>
      {typeof count === "number" && count > 0 && (
        <span
          className={cn(
            "ml-1 inline-flex items-center justify-center h-4 min-w-4 rounded-full px-1 text-[12px] font-mono tabular-nums",
            active
              ? "bg-[oklch(0.72_0.15_85)]/15 text-[oklch(0.72_0.15_85)]"
              : "bg-muted text-muted-foreground"
          )}
        >
          {count}
        </span>
      )}
      {active && (
        <span className="absolute -bottom-[1px] left-2 right-2 h-[2px] bg-[oklch(0.72_0.15_85)] rounded-full" />
      )}
    </button>
  );
}

export function SignalsFeed() {
  const [mail, setMail] = useState<{ connected: boolean; emails: Email[] } | null>(null);
  const [slack, setSlack] = useState<{ connected: boolean; messages: SlackMessage[] } | null>(null);
  const [tab, setTab] = useState<Tab>("priority");

  useEffect(() => {
    Promise.all([
      fetch("/api/email").then((r) => r.json()).catch(() => null),
      fetch("/api/slack").then((r) => r.json()).catch(() => null),
    ]).then(([m, s]) => {
      setMail(m);
      setSlack(s);
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
      priority: e.unread,
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
      return {
        id: `slack-${m.id}`,
        kind: "slack",
        title: m.author,
        subtitle: m.channel,
        body: clipSignal(m.text),
        date: m.date,
        priority: m.isMention || isDM || isGroup,
        isDM,
        isGroup,
        isMention: m.isMention,
        channelKind,
        analysed: m.analysed,
        materialized: m.materialized,
      };
    });

    return [...mailSignals, ...slackSignals].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }, [mail, slack]);

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
    if (all.length === 0) return [];
    const mpimSlots = new Set(["Malcolm + Ed"]);
    return PINNED_SLOTS.flatMap(({ label, matches }) => {
      const latest = all
        .filter(matches)
        .sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        )[0];
      if (!latest) return [];
      const isGroup = mpimSlots.has(label) || latest.channel.startsWith("Group DM");
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
  }, [slack, lastSeenByChannel]);

  const priority = signals.filter((s) => s.priority);
  const mailOnly = signals.filter((s) => s.kind === "mail");
  const slackOnly = signals.filter((s) => s.kind === "slack");

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
        : [
            ...pinnedSignals,
            ...slackOnly.filter((s) => !pinnedSourceIds.has(s.id)),
          ];

  const loading = mail === null || slack === null;
  const mailConnected = mail?.connected;
  const slackConnected = slack?.connected;
  const bothDisconnected = !mailConnected && !slackConnected;

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
        </div>
      </CardHeader>
      <CardContent className="pt-3">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        ) : bothDisconnected ? (
          <div className="flex flex-col items-center py-8 text-center">
            <Unplug className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">Connect Gmail or Slack to see signals.</p>
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
              {tab === "priority" ? "Inbox zero. Nothing urgent." : "Nothing new."}
            </p>
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
        )}
      </CardContent>
    </Card>
  );
}

// ── Single signal row. Pinned Slack rows expand on click to show last 10 msgs. ──
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

  const Icon =
    s.kind === "mail"
      ? Mail
      : s.channelKind === "dm"
        ? MessageSquare
        : s.channelKind === "group"
          ? Users
          : Hash;
  const iconColor =
    s.kind === "mail"
      ? "text-blue-500/70"
      : s.channelKind === "dm"
        ? "text-blue-500"
        : s.channelKind === "group"
          ? "text-violet-500"
          : "text-amber-500/80";

  const canExpand = s.pinned && s.kind === "slack" && !!s.channelId;

  const toggle = async () => {
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
        canExpand && "cursor-pointer",
        s.pinned && "bg-[oklch(0.72_0.15_85)]/[0.04]"
      )}
      onClick={toggle}
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      onKeyDown={
        canExpand
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
