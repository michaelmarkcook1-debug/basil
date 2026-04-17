"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Calendar, Mail, Hash, Flame } from "lucide-react";
import { cn } from "@/lib/utils";

type Pulse = {
  meetings: number;
  unread: number;
  dms: number;
  mentions: number;
  stale: number;
};

interface PulseTileProps {
  label: string;
  value: number;
  accent?: string;
  hint?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  loading?: boolean;
}

function PulseTile({ label, value, accent, hint, href, icon: Icon, loading }: PulseTileProps) {
  return (
    <Link
      href={href}
      className="group relative overflow-hidden rounded-xl basil-card ring-1 ring-foreground/[0.06] p-4 transition-all hover:ring-foreground/[0.12] hover:-translate-y-0.5"
    >
      <div
        aria-hidden
        className="absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-0 group-hover:opacity-60 transition-opacity"
        style={{
          background:
            "radial-gradient(circle, oklch(0.72 0.15 85 / 0.18), transparent 70%)",
        }}
      />
      <div className="relative flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </p>
          <p
            className={cn(
              "basil-display text-3xl leading-none tracking-tight",
              accent ?? "text-foreground",
              loading && "text-muted-foreground/30"
            )}
          >
            {loading ? "—" : value}
          </p>
          {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
        </div>
        <Icon className="h-4 w-4 text-muted-foreground/50 group-hover:text-[oklch(0.72_0.15_85)] transition-colors" />
      </div>
    </Link>
  );
}

export function PulseStrip() {
  const [pulse, setPulse] = useState<Pulse>({
    meetings: 0,
    unread: 0,
    dms: 0,
    mentions: 0,
    stale: 0,
  });
  const [loaded, setLoaded] = useState({
    cal: false,
    mail: false,
    slack: false,
    act: false,
  });

  useEffect(() => {
    // Fetch independently so one slow/rate-limited endpoint doesn't block others
    fetch("/api/calendar")
      .then((r) => r.json())
      .then((cal) => {
        const meetings =
          cal?.events?.filter((e: { isAllDay?: boolean }) => !e.isAllDay).length ?? 0;
        setPulse((p) => ({ ...p, meetings }));
      })
      .catch(() => {})
      .finally(() => setLoaded((l) => ({ ...l, cal: true })));

    fetch("/api/email")
      .then((r) => r.json())
      .then((mail) => {
        const unread = mail?.emails?.filter((e: { unread?: boolean }) => e.unread).length ?? 0;
        setPulse((p) => ({ ...p, unread }));
      })
      .catch(() => {})
      .finally(() => setLoaded((l) => ({ ...l, mail: true })));

    fetch("/api/slack")
      .then((r) => r.json())
      .then((slack) => {
        const messages = slack?.messages ?? [];
        const dms = messages.filter(
          (m: { channel: string }) =>
            m.channel.startsWith("DM:") || m.channel === "Group DM"
        ).length;
        const mentions = messages.filter(
          (m: { isMention?: boolean }) => m.isMention
        ).length;
        setPulse((p) => ({ ...p, dms, mentions }));
      })
      .catch(() => {})
      .finally(() => setLoaded((l) => ({ ...l, slack: true })));

    fetch("/api/contacts/activity")
      .then((r) => r.json())
      .then((act) => {
        const stale = (act?.activity ?? []).filter(
          (a: { lastInteraction?: string | null }) => {
            if (!a.lastInteraction) return true;
            const days =
              (Date.now() - new Date(a.lastInteraction).getTime()) / 86400000;
            return days > 10;
          }
        ).length;
        setPulse((p) => ({ ...p, stale }));
      })
      .catch(() => {})
      .finally(() => setLoaded((l) => ({ ...l, act: true })));
  }, []);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <PulseTile
        label="Today"
        value={pulse.meetings}
        hint={pulse.meetings === 1 ? "meeting" : "meetings"}
        href="/dashboard/schedule"
        icon={Calendar}
        accent="text-foreground"
        loading={!loaded.cal}
      />
      <PulseTile
        label="Unread"
        value={pulse.unread}
        hint="in inbox"
        href="/dashboard/chat"
        icon={Mail}
        accent="text-[oklch(0.72_0.15_85)]"
        loading={!loaded.mail}
      />
      <PulseTile
        label="Slack"
        value={pulse.dms + pulse.mentions}
        hint={`${pulse.dms} DMs · ${pulse.mentions} mentions`}
        href="/dashboard/chat"
        icon={Hash}
        accent="text-foreground"
        loading={!loaded.slack}
      />
      <PulseTile
        label="Need attention"
        value={pulse.stale}
        hint="contacts going cold"
        href="/dashboard/contacts"
        icon={Flame}
        accent={pulse.stale > 0 ? "text-red-500" : "text-foreground"}
        loading={!loaded.act}
      />
    </div>
  );
}
