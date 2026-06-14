"use client";

import { useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  Calendar,
  MessageSquare,
  Clock,
  ArrowRight,
  Zap,
  AlertCircle,
  CheckCircle2,
  FileText,
  Newspaper,
  Users,
  ExternalLink,
  Video,
  Mail,
  Hash,
  TrendingUp,
  TrendingDown,
  Minus,
  Brain,
  Shield,
  Maximize2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getNow } from "@/lib/datetime";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getGreeting(hour: number): string {
  if (hour < 5)  return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

function relTime(dateStr: string): string {
  const delta = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(delta / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtEventTime(dateStr: string, tz?: string): string {
  return new Date(dateStr).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: tz ?? undefined,
  }).toUpperCase();
}

function durationMins(start: string, end: string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
}

function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string; summary: string; start: string; end: string;
  isAllDay?: boolean; hasVideo?: boolean; attendeeCount?: number;
  attendees?: Array<{ name?: string; email?: string }>;
}
interface ActionItem {
  id: string; title: string; dueDate?: string; status: string;
  priority?: string; owner?: string;
}
interface RankedSignal {
  id: string; title: string; snippet: string; source: string;
  occurredAt: string; ranking: { score: number };
  participants?: Array<{ name: string; canonicalId?: string }>;
}
interface RelContact {
  contactId: string; name: string;
  lastInteraction: string | null; sources: string[];
  trend?: "strengthening" | "cooling" | "stable" | "at-risk";
  recentItems?: string[];
}
interface BriefingData {
  id?: string; summary?: string; generatedAt?: string; status?: string;
  // Real briefing fields from /api/generate/briefing
  criticalToday?:       string | null;
  projectRadar?:        string | null;
  followUps?:           string | null;
  decisionsToWatch?:    string | null;
  meetingsNeedingPrep?: string | null;
  peopleAndAccounts?:   string | null;
  inboxSlack?:          string | null;
}

// ── Cinematic hero atmosphere — convergent horizon light ─────────────────────
function HeroLight() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 0 }}>

      {/* ── Deep environmental base — warm black ground ── */}
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(160deg, rgba(18,12,6,0.95) 0%, rgba(8,6,4,0.6) 50%, rgba(4,6,12,0.9) 100%)",
      }} />

      {/* ── Focal light source — warm gold origin point ── */}
      {/* Outer atmospheric bloom */}
      <div style={{
        position: "absolute", top: "-30px", right: "18%",
        width: "520px", height: "300px",
        background: "radial-gradient(ellipse 55% 55% at 65% 28%, rgba(210,160,55,0.22) 0%, rgba(180,120,30,0.10) 38%, rgba(120,70,10,0.04) 60%, transparent 80%)",
        filter: "blur(32px)",
      }} />
      {/* Core focal warmth */}
      <div style={{
        position: "absolute", top: "18px", right: "28%",
        width: "220px", height: "140px",
        background: "radial-gradient(ellipse 50% 60% at 58% 38%, rgba(255,220,130,0.72) 0%, rgba(230,175,70,0.38) 28%, rgba(180,120,30,0.12) 55%, transparent 75%)",
        filter: "blur(18px)",
      }} />
      {/* Inner hot point */}
      <div style={{
        position: "absolute", top: "44px", right: "33%",
        width: "80px", height: "60px",
        background: "radial-gradient(ellipse at 50% 40%, rgba(255,240,180,0.90) 0%, rgba(240,195,100,0.55) 40%, transparent 75%)",
        filter: "blur(8px)",
      }} />

      {/* ── Horizon atmosphere — layered fog between light bands ── */}
      <div style={{
        position: "absolute", top: "60px", left: "0", right: "0",
        height: "180px",
        background: "linear-gradient(180deg, transparent 0%, rgba(24,16,6,0.25) 40%, rgba(14,10,4,0.45) 70%, rgba(6,5,3,0.65) 100%)",
      }} />

      {/* ── Convergent light streams — sweep from left toward focal point ── */}
      {/* The focal point is at approximately (right:30%, top:60px) of the hero */}
      <svg
        aria-hidden
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        viewBox="0 0 1320 320" fill="none" preserveAspectRatio="xMidYMid meet"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Gradient: dims at left edge, peaks near focal point, fades right */}
          <linearGradient id="hs-l1" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor="#D4A845" stopOpacity="0" />
            <stop offset="45%"  stopColor="#D4A845" stopOpacity="0.38" />
            <stop offset="72%"  stopColor="#F0CB70" stopOpacity="0.65" />
            <stop offset="88%"  stopColor="#F5D885" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#D4A845" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="hs-l2" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor="#C8983A" stopOpacity="0" />
            <stop offset="40%"  stopColor="#C8983A" stopOpacity="0.22" />
            <stop offset="70%"  stopColor="#DEB85A" stopOpacity="0.42" />
            <stop offset="90%"  stopColor="#C8983A" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#C8983A" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="hs-l3" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor="#B88030" stopOpacity="0" />
            <stop offset="35%"  stopColor="#B88030" stopOpacity="0.14" />
            <stop offset="68%"  stopColor="#CCA050" stopOpacity="0.28" />
            <stop offset="88%"  stopColor="#B88030" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#B88030" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="hs-l4" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor="#A87030" stopOpacity="0" />
            <stop offset="30%"  stopColor="#A87030" stopOpacity="0.08" />
            <stop offset="66%"  stopColor="#B88840" stopOpacity="0.18" />
            <stop offset="85%"  stopColor="#A87030" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#A87030" stopOpacity="0" />
          </linearGradient>
          <filter id="hs-glow">
            <feGaussianBlur stdDeviation="1.8" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* PRIMARY stream — brightest, closest to focal center */}
        <path
          d="M 0 195 C 200 190, 480 165, 680 138 C 820 118, 920 90, 940 72"
          stroke="url(#hs-l1)" strokeWidth="1.8" fill="none"
          filter="url(#hs-glow)"
        />
        {/* SECONDARY stream — slightly above */}
        <path
          d="M 0 168 C 180 164, 420 148, 620 126 C 760 110, 880 86, 940 72"
          stroke="url(#hs-l2)" strokeWidth="1.2" fill="none"
        />
        {/* TERTIARY stream */}
        <path
          d="M 0 222 C 220 216, 500 194, 700 166 C 840 145, 920 100, 940 72"
          stroke="url(#hs-l3)" strokeWidth="0.9" fill="none"
        />
        {/* QUATERNARY — wider sweep */}
        <path
          d="M 0 140 C 150 136, 380 124, 570 108 C 720 95, 870 80, 940 72"
          stroke="url(#hs-l3)" strokeWidth="0.7" fill="none"
        />
        {/* DEEP stream — distant, barely visible */}
        <path
          d="M 0 248 C 240 242, 540 220, 740 192 C 870 172, 930 112, 940 72"
          stroke="url(#hs-l4)" strokeWidth="0.65" fill="none"
        />
        {/* UPPER stream — tighter curve */}
        <path
          d="M 80 108 C 280 105, 530 94, 700 82 C 820 73, 900 68, 940 72"
          stroke="url(#hs-l4)" strokeWidth="0.5" fill="none"
        />
        {/* FAR stream */}
        <path
          d="M 0 278 C 260 272, 570 248, 760 218 C 880 197, 932 126, 940 72"
          stroke="url(#hs-l4)" strokeWidth="0.4" fill="none" opacity="0.6"
        />

        {/* Focal point — the horizon sun */}
        <circle cx={940} cy={72} r={3}   fill="#FFF0C0" opacity={0.92} />
        <circle cx={940} cy={72} r={9}   fill="#F5D070" opacity={0.30} />
        <circle cx={940} cy={72} r={20}  fill="#D4A845" opacity={0.10} />
        <circle cx={940} cy={72} r={40}  fill="#C89030" opacity={0.045} />
        <circle cx={940} cy={72} r={80}  fill="#B07820" opacity={0.018} />
      </svg>

      {/* ── Shadow vignette — grounds the environment ── */}
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(90deg, rgba(4,3,2,0.55) 0%, transparent 45%, transparent 70%, rgba(2,3,6,0.30) 100%)",
      }} />
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: "60%",
        background: "linear-gradient(0deg, rgba(6,5,4,0.65) 0%, transparent 100%)",
      }} />
    </div>
  );
}

// ── AI Confidence widget ──────────────────────────────────────────────────────

function AiConfidenceWidget({ signalCount, contactCount }: { signalCount: number; contactCount: number }) {
  // Signals are required for meaningful confidence — contacts alone can't max out the score.
  // Signal weight: up to 3 pts (60%), contact weight: up to 2 pts (40%)
  const sigScore = Math.min(3, (signalCount / 20) * 3);
  const ctxScore = Math.min(2, (contactCount / 15) * 2);
  const score = Math.min(5, Math.max(1, Math.round(sigScore + ctxScore)));
  const label = score >= 4 ? "High" : score >= 3 ? "Medium" : "Low";
  const color = score >= 4 ? "#1F8A70" : score >= 3 ? "#D9A441" : "#D96C5F";

  return (
    <div className="shrink-0 flex flex-col items-start sm:items-end gap-1">
      <p className="text-[9px] uppercase tracking-[0.22em] text-[#AAB3C5]/50 font-semibold">
        AI Confidence
      </p>
      <div className="flex items-center gap-2">
        <div className="flex gap-0.5">
          {[1,2,3,4,5].map(i => (
            <div
              key={i}
              className="h-2 w-2 rounded-full"
              style={{
                background: i <= score ? color : "rgba(170,179,197,0.15)",
                boxShadow: i <= score ? `0 0 4px ${color}50` : "none",
              }}
            />
          ))}
        </div>
        <span className="text-[13px] font-semibold" style={{ color }}>{label}</span>
      </div>
      <p className="text-xs text-[#AAB3C5]/40">
        {signalCount > 0 ? `${signalCount} signal${signalCount === 1 ? "" : "s"} indexed` : "No signals yet"}
      </p>
    </div>
  );
}

// ── Metric bar ────────────────────────────────────────────────────────────────

function MetricBar({ metrics, loading }: {
  metrics: Array<{ label: string; sublabel: string; value: number | null; color: string; href: string; icon: React.ReactNode }>;
  loading: boolean;
}) {
  return (
    <div className="relative flex items-stretch overflow-x-auto overflow-y-hidden snap-x snap-mandatory" style={{
      background: "linear-gradient(180deg, rgba(14,11,8,0.90) 0%, rgba(10,8,6,0.85) 100%)",
      border: "1px solid rgba(180,140,55,0.10)",
      borderRadius: "10px",
      boxShadow: "0 0 0 1px rgba(0,0,0,0.5) inset, 0 8px 32px rgba(0,0,0,0.40)",
    }}>
      {metrics.map((m, i) => (
        <div key={m.label} className="relative flex items-stretch flex-1 min-w-[128px] snap-start">
          {i > 0 && (
            <div className="absolute left-0 top-[15%] bottom-[15%]" style={{ width: 1, background: "rgba(180,140,55,0.09)" }} />
          )}
          <Link href={m.href} className="group flex-1 flex flex-col justify-between py-5 px-5 transition-all duration-200" style={{ gap: "10px" }}>
            {/* Icon + label row */}
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center h-6 w-6 rounded-md transition-all duration-200 group-hover:scale-105"
                style={{ background: `${m.color}18`, color: m.color, boxShadow: `0 0 12px ${m.color}20` }}>
                {m.icon}
              </div>
              <p style={{ fontSize: "9px", fontWeight: 700, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(170,148,95,0.55)" }}>
                {m.label}
              </p>
            </div>
            {/* Number */}
            {loading ? (
              <div className="h-9 w-12 rounded bg-white/[0.05] animate-pulse" />
            ) : (
              <p style={{
                fontSize: "2.6rem",
                fontWeight: 800,
                lineHeight: 1,
                letterSpacing: "-0.04em",
                fontVariantNumeric: "tabular-nums",
                color: m.value && m.value > 0 ? m.color : "rgba(220,200,160,0.14)",
                textShadow: m.value && m.value > 0 ? `0 0 28px ${m.color}40` : "none",
                transition: "color 0.2s, text-shadow 0.2s",
              }}>
                {m.value ?? "—"}
              </p>
            )}
            {/* Sublabel + link */}
            <div>
              <p style={{ fontSize: "9.5px", color: "rgba(150,130,85,0.40)", lineHeight: 1.3 }}>{m.sublabel}</p>
            </div>
          </Link>
        </div>
      ))}
    </div>
  );
}

// ── Panel wrapper ─────────────────────────────────────────────────────────────

function Panel({ title, href, linkLabel = "View all", children, className, onExpand }: {
  title: string; href?: string; linkLabel?: string;
  children: React.ReactNode; className?: string;
  onExpand?: () => void;
}) {
  return (
    <div
      className={cn("flex flex-col overflow-hidden", className)}
      style={{
        background: "linear-gradient(180deg, rgba(16,13,10,0.88) 0%, rgba(10,9,7,0.82) 100%)",
        border: "1px solid rgba(180,140,60,0.12)",
        borderRadius: "10px",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.6) inset, 0 24px 64px rgba(0,0,0,0.55), 0 1px 0 rgba(220,175,85,0.08) inset",
      }}
    >
      {/* Ultra-thin luminous top edge */}
      <div style={{
        height: "1px",
        background: "linear-gradient(90deg, transparent 0%, rgba(210,165,70,0.25) 25%, rgba(235,190,95,0.32) 50%, rgba(210,165,70,0.25) 75%, transparent 100%)",
        marginBottom: 0,
      }} />
      <div className="flex items-center justify-between px-5 pt-3.5 pb-3" style={{ borderBottom: "1px solid rgba(180,140,60,0.07)" }}>
        <h2 style={{ fontSize: "9px", fontWeight: 700, letterSpacing: "0.30em", textTransform: "uppercase", color: "rgba(190,155,80,0.50)" }}>
          {title}
        </h2>
        <div className="flex items-center gap-2.5">
          {onExpand && (
            <button
              onClick={onExpand}
              className="transition-all duration-200 p-0.5 rounded"
              style={{ color: "rgba(160,130,60,0.28)" }}
              onMouseEnter={e => (e.currentTarget.style.color = "rgba(210,170,80,0.75)")}
              onMouseLeave={e => (e.currentTarget.style.color = "rgba(160,130,60,0.28)")}
              aria-label={`Expand ${title}`}
            >
              <Maximize2 size={10} />
            </button>
          )}
          {href && (
            <Link
              href={href}
              className="flex items-center gap-1 transition-all duration-200"
              style={{ fontSize: "9px", color: "rgba(200,160,65,0.48)", letterSpacing: "0.04em" }}
              onMouseEnter={e => (e.currentTarget.style.color = "rgba(220,180,85,0.88)")}
              onMouseLeave={e => (e.currentTarget.style.color = "rgba(200,160,65,0.48)")}
            >
              {linkLabel} <ArrowRight size={8} />
            </Link>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

// ── Panel modal overlay ───────────────────────────────────────────────────────

function PanelModal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
      style={{ background: "rgba(4,11,22,0.90)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={cn("w-full flex flex-col rounded-2xl overflow-hidden", wide ? "max-w-4xl" : "max-w-2xl")}
        style={{
          maxHeight: "88vh",
          background: "linear-gradient(175deg, rgba(13,26,52,0.98) 0%, rgba(7,17,31,0.96) 100%)",
          border: "1px solid rgba(200,169,107,0.18)",
          boxShadow: "0 32px 96px rgba(0,0,0,0.65), 0 1px 0 rgba(243,239,231,0.05) inset",
        }}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gold/10 shrink-0">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.18em] text-[#AAB3C5]/70">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded-lg flex items-center justify-center text-[#AAB3C5]/40 hover:text-[#F3EFE7] hover:bg-white/[0.05] transition-all"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto basil-scroll">
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Today's Briefing panel ────────────────────────────────────────────────────

const BRIEFING_SECTIONS: Array<{ key: keyof BriefingData; label: string; color: string }> = [
  { key: "criticalToday",       label: "Critical Today",      color: "#D96C5F" },
  { key: "meetingsNeedingPrep", label: "Meeting Prep",        color: "#D9A441" },
  { key: "projectRadar",        label: "Project Radar",       color: "#C8A96B" },
  { key: "followUps",           label: "Follow-ups",          color: "#1F8A70" },
  { key: "inboxSlack",          label: "Inbox & Slack",       color: "#5CB8FF" },
];

function BriefingPanel({ briefing, loading, briefingLoading, onExpand }: {
  briefing: BriefingData | null;
  loading: boolean;
  briefingLoading: boolean;
  onExpand?: () => void;
}) {
  const activeSections = briefing
    ? BRIEFING_SECTIONS.filter(s => {
        const val = briefing[s.key];
        return typeof val === "string" && val.length > 0;
      })
    : [];

  const isLoading = loading || briefingLoading;

  return (
    <Panel title="Today's Briefing" href="/dashboard/briefing" linkLabel="Full briefing →" onExpand={onExpand}>
      <div className="px-4 py-3 space-y-2.5">
        {isLoading ? (
          <div className="space-y-3">
            {[1,2,3].map(i => (
              <div key={i} className="flex gap-3">
                <div className="h-2.5 w-2.5 rounded-full bg-white/10 animate-pulse shrink-0 mt-1" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 w-3/4 rounded bg-white/10 animate-pulse" />
                  <div className="h-2 w-1/2 rounded bg-white/[0.06] animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : activeSections.length === 0 ? (
          <div className="py-6 text-center">
            <Newspaper size={20} className="text-[#AAB3C5]/20 mx-auto mb-2" />
            {briefing?.generatedAt ? (
              <>
                <p className="text-xs text-[#AAB3C5]/40">Briefing ready</p>
                <Link href="/dashboard/briefing" className="mt-2 inline-flex items-center gap-1 text-xs text-gold/70 hover:text-gold">
                  Read full briefing <ArrowRight size={9} />
                </Link>
              </>
            ) : (
              <>
                <p className="text-xs text-[#AAB3C5]/40">No briefing yet</p>
                <Link href="/dashboard/briefing" className="mt-2 inline-flex items-center gap-1 text-xs text-gold/70 hover:text-gold">
                  Generate briefing <ArrowRight size={9} />
                </Link>
              </>
            )}
          </div>
        ) : (
          activeSections.slice(0, 4).map((s) => {
            const content = briefing![s.key] as string;
            // Take first sentence or first 120 chars as the preview
            const preview = content.split(/\n/)[0].slice(0, 130).trim();
            return (
              <div key={s.key} className="flex items-start gap-2.5">
                <div className="h-1.5 w-1.5 rounded-full mt-[5px] shrink-0" style={{ background: s.color }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold uppercase tracking-[0.18em] mb-0.5" style={{ color: `${s.color}99` }}>{s.label}</p>
                  <p className="text-[11.5px] text-[#AAB3C5]/65 leading-snug line-clamp-2">{preview}</p>
                </div>
              </div>
            );
          })
        )}
        {briefing?.generatedAt && !isLoading && (
          <p className="text-[9px] text-[#AAB3C5]/25 pt-1 border-t border-gold/[0.05]">
            Generated {relTime(briefing.generatedAt)}
          </p>
        )}
      </div>
    </Panel>
  );
}

// ── Upcoming Schedule panel ───────────────────────────────────────────────────

function SchedulePanel({ events, loading, onExpand }: { events: CalendarEvent[]; loading: boolean; onExpand?: () => void }) {
  const tz  = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  const now = Date.now();

  const todayEvents = useMemo(() => {
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const endOfDay   = new Date(); endOfDay.setHours(23,59,59,999);
    return events
      .filter(e => !e.isAllDay && new Date(e.start) >= startOfDay && new Date(e.start) <= endOfDay)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      .slice(0, 6);
  }, [events]);

  return (
    <Panel title="Upcoming Schedule" href="/dashboard/schedule" linkLabel="Prepare for next →" onExpand={onExpand}>
      <div className="divide-y divide-gold/[0.07]">
        {loading ? (
          <div className="px-4 py-3 space-y-3">
            {[1,2,3].map(i => (
              <div key={i} className="flex gap-3">
                <div className="h-8 w-10 rounded bg-white/[0.04] animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 w-3/4 rounded bg-white/[0.06] animate-pulse" />
                  <div className="h-2 w-1/2 rounded bg-white/[0.04] animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : todayEvents.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <Calendar size={20} className="text-[#AAB3C5]/20 mx-auto mb-2" />
            <p className="text-xs text-[#AAB3C5]/40">Schedule is clear</p>
          </div>
        ) : (
          todayEvents.map(ev => {
            const isPast    = new Date(ev.end).getTime() < now;
            const isCurrent = new Date(ev.start).getTime() <= now && new Date(ev.end).getTime() > now;
            const dur       = durationMins(ev.start, ev.end);
            return (
              <div
                key={ev.id}
                className={cn(
                  "flex items-start gap-3 px-4 py-2.5",
                  isCurrent && "bg-gold/[0.05]"
                )}
              >
                <div className="shrink-0 text-right w-14">
                  <p className={cn("text-xs font-medium tabular-nums leading-none", isCurrent ? "text-gold" : isPast ? "text-[#AAB3C5]/30" : "text-[#AAB3C5]/65")}>
                    {fmtEventTime(ev.start, tz)}
                  </p>
                  {dur > 0 && (
                    <p className="text-[9px] text-[#AAB3C5]/30 leading-none mt-0.5">{dur}m</p>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {isCurrent && <span className="h-1.5 w-1.5 rounded-full bg-gold animate-pulse shrink-0" />}
                    {ev.hasVideo && <Video size={10} className="shrink-0 text-[#5CB8FF]/60" />}
                    <p className={cn(
                      "text-[12px] font-medium leading-none truncate",
                      isPast ? "text-[#F3EFE7]/30 line-through" : "text-[#F3EFE7]/85"
                    )}>
                      {ev.summary}
                    </p>
                  </div>
                  {(ev.attendeeCount ?? 0) > 1 && (
                    <p className="text-xs text-[#AAB3C5]/35 mt-0.5">{ev.attendeeCount} attendees</p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

// ── Signal Radar panel ────────────────────────────────────────────────────────

const SIGNAL_SOURCES = [
  { key: "email",    label: "Email",    color: "#5CB8FF", angle: 40  },
  { key: "slack",    label: "Slack",    color: "#1F8A70", angle: 100 },
  { key: "linear",   label: "Linear",   color: "#C8A96B", angle: 162 },
  { key: "calendar", label: "Calendar", color: "#D9A441", angle: 224 },
  { key: "other",    label: "Other",    color: "#D96C5F", angle: 288 },
] as const;

// Radar dimensions
const R_SIZE = 172;
const R_CX   = R_SIZE / 2;
const R_CY   = R_SIZE / 2;
const R_MAX  = (R_SIZE / 2) - 10; // outer ring radius
const R_RINGS = [0.30, 0.58, 0.86]; // concentric ring fractions

/** Normalise a raw SignalEvent source to a radar bucket key. */
function radarKey(source: string): string {
  if (source === "gmail" || source === "email" || source === "zoom_email") return "email";
  if (source === "slack") return "slack";
  if (source === "linear") return "linear";
  if (source === "calendar") return "calendar";
  return "other";
}

/** Decode HTML entities in a snippet string (e.g. &lt; → <). */
function decodeHtml(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function SignalRadarPanel({ signals, loading, onExpand }: { signals: RankedSignal[]; loading: boolean; onExpand?: () => void }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = { email: 0, slack: 0, linear: 0, calendar: 0, other: 0 };
    for (const s of signals) {
      const key = radarKey(s.source);
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [signals]);

  // Plot up to 30 signals as dots
  const dots = useMemo(() =>
    signals.slice(0, 30).map((s, i) => {
      const src    = SIGNAL_SOURCES.find(x => x.key === radarKey(s.source)) ?? SIGNAL_SOURCES[4];
      const score  = s.ranking?.score ?? 0.5;
      const jitter = ((i * 43 + i * i * 7) % 40) - 20;
      const ang    = ((src.angle + jitter) * Math.PI) / 180;
      const r      = R_MAX * (0.18 + (1 - score) * 0.76);
      return { x: R_CX + Math.cos(ang) * r, y: R_CY + Math.sin(ang) * r,
               color: src.color, score, id: s.id, urgent: score > 0.72 };
    }),
  [signals]);

  // 6 subtle sector lines
  const sectors = Array.from({ length: 6 }, (_, i) => {
    const a = (i * 60 * Math.PI) / 180;
    return { x2: R_CX + Math.cos(a) * R_MAX, y2: R_CY + Math.sin(a) * R_MAX };
  });

  const svgId = "radar-svg";

  return (
    <Panel title="Signal Radar" onExpand={onExpand}>
      <div className="px-3 py-2">
        {/* Radar SVG */}
        <div className="flex items-center justify-center mb-2">
          <svg width={R_SIZE} height={R_SIZE} viewBox={`0 0 ${R_SIZE} ${R_SIZE}`} className="shrink-0" style={{ overflow: "visible" }}>
            <defs>
              {/* Atmospheric glow filter */}
              <filter id={`${svgId}-glow`} x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feColorMatrix in="blur" type="matrix"
                  values="1 0 0 0 0.78  0 1 0 0 0.66  0 0 1 0 0.42  0 0 0 0.6 0" />
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              {/* Sweep gradient — gold wedge fade */}
              <radialGradient id={`${svgId}-sweep`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#C8A96B" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#C8A96B" stopOpacity="0" />
              </radialGradient>
              {/* Center ambient glow */}
              <radialGradient id={`${svgId}-ambient`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#C8A96B" stopOpacity="0.06" />
                <stop offset="60%" stopColor="#C8A96B" stopOpacity="0.02" />
                <stop offset="100%" stopColor="#C8A96B" stopOpacity="0" />
              </radialGradient>
              {/* Dot glow filters per color */}
              <filter id={`${svgId}-dot-glow`} x="-150%" y="-150%" width="400%" height="400%">
                <feGaussianBlur stdDeviation="2.5" result="blur" />
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            {/* Ambient background glow */}
            <circle cx={R_CX} cy={R_CY} r={R_MAX}
              fill={`url(#${svgId}-ambient)`} />

            {/* Sector grid lines — hairline, barely visible */}
            {sectors.map((s, i) => (
              <line key={i} x1={R_CX} y1={R_CY} x2={s.x2} y2={s.y2}
                stroke="rgba(200,169,107,0.055)" strokeWidth="0.8" />
            ))}

            {/* Concentric rings — innermost warm, outer progressively cooler */}
            <circle cx={R_CX} cy={R_CY} r={R_MAX * 0.28}
              fill="none" stroke="rgba(220,175,90,0.14)" strokeWidth="0.8"
              strokeDasharray="2 5" />
            <circle cx={R_CX} cy={R_CY} r={R_MAX * 0.54}
              fill="none" stroke="rgba(200,160,80,0.10)" strokeWidth="1"
              strokeDasharray="3 4" />
            <circle cx={R_CX} cy={R_CY} r={R_MAX * 0.80}
              fill="none" stroke="rgba(180,145,70,0.07)" strokeWidth="1" />
            {/* Outer boundary ring with subtle glow */}
            <circle cx={R_CX} cy={R_CY} r={R_MAX}
              fill="none" stroke="rgba(200,169,107,0.13)" strokeWidth="1.2"
              filter={`url(#${svgId}-glow)`} />

            {/* Animated sweep — sonar-style rotating wedge */}
            <g>
              <path
                d={`M ${R_CX} ${R_CY} L ${R_CX + R_MAX} ${R_CY} A ${R_MAX} ${R_MAX} 0 0 1 ${R_CX + R_MAX * Math.cos(0.52)} ${R_CY + R_MAX * Math.sin(0.52)} Z`}
                fill="url(#radar-svg-sweep)"
                opacity="0.7"
              >
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from={`0 ${R_CX} ${R_CY}`}
                  to={`360 ${R_CX} ${R_CY}`}
                  dur="12s"
                  repeatCount="indefinite"
                />
              </path>
              {/* Sweep leading edge line */}
              <line x1={R_CX} y1={R_CY} x2={R_CX + R_MAX} y2={R_CY}
                stroke="rgba(200,169,107,0.22)" strokeWidth="0.8">
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from={`0 ${R_CX} ${R_CY}`}
                  to={`360 ${R_CX} ${R_CY}`}
                  dur="12s"
                  repeatCount="indefinite"
                />
              </line>
            </g>

            {loading ? (
              // Scanning state: pulsing rings
              <>
                {[0.28, 0.54, 0.80].map((frac, i) => (
                  <circle key={i} cx={R_CX} cy={R_CY} r={R_MAX * frac}
                    fill="none" stroke="rgba(200,169,107,0.12)" strokeWidth="1">
                    <animate attributeName="opacity" values="0.4;0.12;0.4"
                      dur={`${2.2 + i * 0.5}s`} repeatCount="indefinite" />
                  </circle>
                ))}
                <text x={R_CX} y={R_CY + 4} textAnchor="middle"
                  fill="rgba(200,169,107,0.35)" fontSize="8" fontFamily="system-ui"
                  letterSpacing="0.1em">
                  scanning
                  <animate attributeName="opacity" values="0.6;0.2;0.6" dur="2s" repeatCount="indefinite" />
                </text>
              </>
            ) : signals.length === 0 ? (
              <text x={R_CX} y={R_CY + 4} textAnchor="middle"
                fill="rgba(170,179,197,0.30)" fontSize="9" fontFamily="system-ui">
                no signals yet
              </text>
            ) : (
              <>
                {/* Orbital drift wrapper — very slow rotation of dot field */}
                <g>
                  <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from={`0 ${R_CX} ${R_CY}`}
                    to={`360 ${R_CX} ${R_CY}`}
                    dur="180s"
                    repeatCount="indefinite"
                  />
                  {dots.map((dot) => (
                    <g key={dot.id}>
                      {/* Outer ambient halo */}
                      <circle cx={dot.x} cy={dot.y} r={dot.urgent ? 10 : 6}
                        fill={dot.color} opacity="0.07" />
                      {/* Mid glow ring */}
                      <circle cx={dot.x} cy={dot.y} r={dot.urgent ? 5.5 : 3.5}
                        fill={dot.color} opacity={dot.urgent ? 0.18 : 0.10} />
                      {/* Solid core */}
                      <circle cx={dot.x} cy={dot.y} r={dot.urgent ? 2.8 : 1.9}
                        fill={dot.color} opacity="0.92"
                        filter={dot.urgent ? `url(#${svgId}-dot-glow)` : undefined} />
                      {/* Urgent pulse ring */}
                      {dot.urgent && (
                        <circle cx={dot.x} cy={dot.y} r="5.5"
                          fill="none" stroke={dot.color} strokeWidth="0.8" opacity="0">
                          <animate attributeName="r" values="5.5;10;5.5" dur="2.8s" repeatCount="indefinite" />
                          <animate attributeName="opacity" values="0.5;0;0.5" dur="2.8s" repeatCount="indefinite" />
                        </circle>
                      )}
                    </g>
                  ))}
                </g>

                {/* Centre badge — sits above orbital drift */}
                <circle cx={R_CX} cy={R_CY} r={17}
                  fill="rgba(8,7,5,0.92)" stroke="rgba(200,169,107,0.20)" strokeWidth="1" />
                <circle cx={R_CX} cy={R_CY} r={17}
                  fill="none" stroke="rgba(200,169,107,0.06)" strokeWidth="4" />
                <text x={R_CX} y={R_CY - 0.5} textAnchor="middle"
                  fill="#F0E8D4" fontSize="11" fontWeight="700" fontFamily="system-ui">
                  {signals.length}
                </text>
                <text x={R_CX} y={R_CY + 9} textAnchor="middle"
                  fill="rgba(170,179,197,0.50)" fontSize="6" fontFamily="system-ui"
                  letterSpacing="0.08em">
                  LIVE
                </text>
              </>
            )}
          </svg>
        </div>

        {/* Source legend */}
        <div className="space-y-1 mt-1">
          {SIGNAL_SOURCES.map(src => {
            const n = counts[src.key] ?? 0;
            if (n === 0 && !loading) return null;
            return (
              <div key={src.key} className="flex items-center gap-2.5">
                <div className="h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ background: src.color, boxShadow: `0 0 5px ${src.color}80` }} />
                <span className="text-xs text-[#AAB3C5]/48 flex-1 leading-none tracking-[0.01em]">{src.label}</span>
                <span className="text-xs font-semibold tabular-nums" style={{ color: `${src.color}CC` }}>{n}</span>
              </div>
            );
          })}
          {!loading && signals.length === 0 && (
            <p className="text-xs text-[#AAB3C5]/30 text-center py-1">Connect your accounts to begin</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ── Recent Threads panel ──────────────────────────────────────────────────────

const SOURCE_ICON: Record<string, React.ReactNode> = {
  email:    <Mail size={11} />,
  slack:    <Hash size={11} />,
  calendar: <Calendar size={11} />,
  linear:   <FileText size={11} />,
};
const SOURCE_COLOR: Record<string, string> = {
  email: "#5CB8FF", slack: "#1F8A70", calendar: "#C8A96B", linear: "#D9A441",
};

function ThreadsPanel({ signals, loading, onExpand }: { signals: RankedSignal[]; loading: boolean; onExpand?: () => void }) {
  const threads = signals.slice(0, 5);

  return (
    <Panel title="Recent Threads" onExpand={onExpand}>
      <div className="divide-y divide-gold/[0.07]">
        {loading ? (
          <div className="px-4 py-3 space-y-3">
            {[1,2,3].map(i => (
              <div key={i} className="flex gap-3">
                <div className="h-6 w-6 rounded-full bg-white/[0.04] animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 w-3/4 rounded bg-white/[0.06] animate-pulse" />
                  <div className="h-2 w-1/2 rounded bg-white/[0.04] animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : threads.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <MessageSquare size={20} className="text-[#AAB3C5]/20 mx-auto mb-2" />
            <p className="text-xs text-[#AAB3C5]/40">No threads yet — connect your accounts</p>
          </div>
        ) : (
          threads.map(s => {
            const srcKey   = radarKey(s.source);
            const srcColor = SOURCE_COLOR[srcKey] ?? "#AAB3C5";
            const srcIcon  = SOURCE_ICON[srcKey]  ?? <Zap size={11} />;
            return (
              <div key={s.id} className="flex items-start gap-3 px-4 py-3 hover:bg-gold/[0.03] transition-colors">
                <div
                  className="shrink-0 h-6 w-6 rounded-md flex items-center justify-center mt-0.5"
                  style={{ background: `${srcColor}15`, color: srcColor }}
                >
                  {srcIcon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-[#F3EFE7]/85 leading-snug line-clamp-1">{s.title}</p>
                  {s.snippet && (
                    <p className="text-[10.5px] text-[#AAB3C5]/45 leading-snug mt-0.5 line-clamp-1">{decodeHtml(s.snippet)}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    {s.participants?.[0]?.name && (
                      <span className="text-[9px] text-[#AAB3C5]/35">{s.participants[0].name}</span>
                    )}
                    <span className="text-[9px] text-[#AAB3C5]/25">{relTime(s.occurredAt)}</span>
                  </div>
                </div>
                {s.ranking?.score > 0.7 && (
                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide chip-gold px-1.5 py-0.5 rounded-full">
                    High
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

// ── Relationship Insights panel ───────────────────────────────────────────────

const TREND_META = {
  strengthening: { color: "#1F8A70", label: "Strengthening", points: "0,28 10,24 20,20 30,16 40,14 50,10 60,8" },
  cooling:       { color: "#D9A441", label: "Cooling",       points: "0,10 10,12 20,16 30,18 40,22 50,25 60,28" },
  "at-risk":     { color: "#D96C5F", label: "At risk",       points: "0,14 10,10 20,18 30,12 40,24 50,20 60,28" },
  stable:        { color: "#7A8899", label: "Stable",        points: "0,18 10,17 20,19 30,17 40,18 50,17 60,18" },
};

function TrendSparkline({ trend, color }: { trend: string; color: string }) {
  const meta = TREND_META[trend as keyof typeof TREND_META] ?? TREND_META.stable;
  const pts  = meta.points.split(" ").map(p => p.split(",").map(Number));
  const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
  return (
    <svg width="62" height="30" viewBox="0 0 62 30" fill="none" style={{ overflow: "visible" }}>
      <path d={pathD} stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.70" />
      {/* End dot */}
      {pts[pts.length - 1] && (
        <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.2" fill={color} opacity="0.85" />
      )}
    </svg>
  );
}

function RelationshipsPanel({ contacts, loading, onExpand }: { contacts: RelContact[]; loading: boolean; onExpand?: () => void }) {
  const items = contacts.filter(c => c.lastInteraction).slice(0, 5);

  return (
    <Panel title="Relationship Insights" href="/dashboard/contacts" linkLabel="View all relationships" onExpand={onExpand}>
      <div>
        {loading ? (
          <div className="px-4 py-3 space-y-3.5">
            {[1,2,3].map(i => (
              <div key={i} className="flex gap-3 items-center">
                <div className="h-7 w-7 rounded-full bg-white/[0.04] animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 w-1/2 rounded bg-white/[0.06] animate-pulse" />
                  <div className="h-2 w-1/3 rounded bg-white/[0.04] animate-pulse" />
                </div>
                <div className="h-5 w-14 rounded bg-white/[0.03] animate-pulse" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <Users size={20} style={{ color: "rgba(150,130,80,0.20)" }} className="mx-auto mb-2" />
            <p style={{ fontSize: "11px", color: "rgba(150,130,80,0.35)" }}>No relationship data yet</p>
          </div>
        ) : (
          items.map((c, idx) => {
            const trend = c.trend ?? "stable";
            const meta  = TREND_META[trend as keyof typeof TREND_META] ?? TREND_META.stable;
            const days  = c.lastInteraction
              ? Math.floor((Date.now() - new Date(c.lastInteraction).getTime()) / 86400000)
              : null;
            return (
              <div
                key={c.contactId}
                className="flex items-center gap-3 px-4 py-2.5 transition-all duration-150"
                style={{
                  borderBottom: idx < items.length - 1 ? "1px solid rgba(180,140,55,0.06)" : "none",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(210,168,70,0.028)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                {/* Avatar */}
                <div
                  className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center"
                  style={{
                    background: `${meta.color}18`,
                    border: `1px solid ${meta.color}30`,
                    color: meta.color,
                  }}
                >
                  <span style={{ fontSize: "10px", fontWeight: 700 }}>{initials(c.name)}</span>
                </div>
                {/* Name + timing */}
                <div className="flex-1 min-w-0">
                  <p style={{ fontSize: "12px", fontWeight: 500, color: "rgba(235,220,185,0.82)", lineHeight: 1.2, letterSpacing: "0.01em" }} className="truncate">
                    {c.name}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span style={{ fontSize: "9px", color: meta.color, fontWeight: 600 }}>{meta.label}</span>
                    <span style={{ fontSize: "8.5px", color: "rgba(140,120,75,0.40)" }}>·</span>
                    <span style={{ fontSize: "9px", color: "rgba(140,120,75,0.42)" }}>
                      {days === null ? "No record" : days === 0 ? "Today" : `${days}d ago`}
                    </span>
                  </div>
                </div>
                {/* Sparkline trend */}
                <div className="shrink-0">
                  <TrendSparkline trend={trend} color={meta.color} />
                </div>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

// ── Basil Intelligence panel ──────────────────────────────────────────────────

function IntelligencePanel({ signals, actions, loading, onExpand }: {
  signals: RankedSignal[]; actions: ActionItem[]; loading: boolean; onExpand?: () => void;
}) {
  const insights = useMemo(() => computeInsights(signals, actions, 5), [signals, actions]);
  const typeColor = { warning: "#D9A441", info: "#5CB8FF", positive: "#1F8A70", neutral: "#AAB3C5" };

  return (
    <Panel title="Basil Intelligence" onExpand={onExpand}>
      <div className="px-4 py-3 space-y-2.5">
        <div className="flex items-center gap-2 mb-3 pb-2.5 border-b border-gold/[0.07]">
          <div className="h-6 w-6 rounded-md bg-gold/12 flex items-center justify-center">
            <Brain size={13} className="text-gold" />
          </div>
          <p className="text-xs text-[#AAB3C5]/50">
            {loading ? "Analysing..." : `${insights.length} insight${insights.length !== 1 ? "s" : ""} detected`}
          </p>
        </div>

        {loading ? (
          <div className="space-y-2.5">
            {[1,2,3].map(i => (
              <div key={i} className="flex gap-2.5">
                <div className="h-1.5 w-1.5 rounded-full bg-white/10 animate-pulse shrink-0 mt-1.5" />
                <div className="h-2.5 flex-1 rounded bg-white/[0.06] animate-pulse" />
              </div>
            ))}
          </div>
        ) : insights.length === 0 ? (
          <div className="py-4 text-center">
            <Shield size={18} className="text-[#AAB3C5]/20 mx-auto mb-2" />
            <p className="text-xs text-[#AAB3C5]/40">All clear — no alerts</p>
          </div>
        ) : (
          insights.map((ins, i) => (
            <Link
              key={i}
              href={ins.href}
              className="flex items-start gap-2.5 rounded-lg px-2 py-1 -mx-2 hover:bg-white/[0.04] transition-colors group"
            >
              <div
                className="h-1.5 w-1.5 rounded-full mt-1.5 shrink-0 transition-transform group-hover:scale-125"
                style={{ background: typeColor[ins.type], boxShadow: `0 0 4px ${typeColor[ins.type]}50` }}
              />
              <p className="text-[11.5px] text-[#F3EFE7]/65 leading-snug group-hover:text-[#F3EFE7]/90 transition-colors">{ins.text}</p>
            </Link>
          ))
        )}
      </div>
    </Panel>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

type InsightType = "warning" | "info" | "positive" | "neutral";
interface Insight { text: string; type: InsightType; href: string; }

function computeInsights(signals: RankedSignal[], actions: ActionItem[], limit?: number): Insight[] {
  const items: Insight[] = [];
  const overdue = actions.filter(a => a.status !== "done" && a.dueDate && new Date(a.dueDate) < new Date());
  if (overdue.length > 0)
    items.push({ text: `${overdue.length} action${overdue.length > 1 ? "s are" : " is"} overdue — review now`, type: "warning", href: "/dashboard/actions?filter=overdue" });
  const highSignals = signals.filter(s => s.ranking?.score > 0.7);
  if (highSignals.length > 0)
    items.push({ text: `${highSignals.length} high-priority signal${highSignals.length > 1 ? "s need" : " needs"} attention`, type: "warning", href: "/dashboard" });
  if (signals.some(s => s.source === "email"))
    items.push({ text: "Email activity detected across active threads", type: "info", href: "/dashboard" });
  if (signals.some(s => s.source === "slack"))
    items.push({ text: "Slack conversations with open items", type: "info", href: "/dashboard" });
  const waiting = actions.filter(a => a.status === "waiting" || a.status === "blocked");
  if (waiting.length > 0)
    items.push({ text: `Waiting on ${waiting.length} response${waiting.length > 1 ? "s" : ""}`, type: "neutral", href: "/dashboard/actions?filter=open" });
  const done = actions.filter(a => a.status === "done" || a.status === "completed");
  if (done.length > 0)
    items.push({ text: `${done.length} action${done.length > 1 ? "s" : ""} completed this period`, type: "positive", href: "/dashboard/actions?filter=done" });
  const urgent = actions.filter(a => a.priority === "urgent" && a.status !== "done");
  if (urgent.length > 0)
    items.push({ text: `${urgent.length} urgent action${urgent.length > 1 ? "s" : ""} require immediate attention`, type: "warning", href: "/dashboard/actions?filter=open" });
  const actionsDue = actions.filter(a => a.status !== "done" && a.dueDate && new Date(a.dueDate) <= new Date(Date.now() + 86400000));
  if (actionsDue.length > 0)
    items.push({ text: `${actionsDue.length} action${actionsDue.length > 1 ? "s" : ""} due in the next 24 hours`, type: "info", href: "/dashboard/actions?filter=open" });
  return limit ? items.slice(0, limit) : items;
}

// ── Expanded panel content components ─────────────────────────────────────────

function ExpandedBriefingContent({ briefing }: { briefing: BriefingData | null }) {
  const ALL_SECTIONS: Array<{ key: keyof BriefingData; label: string; color: string }> = [
    { key: "criticalToday",       label: "Critical Today",      color: "#D96C5F" },
    { key: "meetingsNeedingPrep", label: "Meetings Needing Prep", color: "#D9A441" },
    { key: "projectRadar",        label: "Project Radar",       color: "#C8A96B" },
    { key: "followUps",           label: "Follow-ups",          color: "#1F8A70" },
    { key: "decisionsToWatch",    label: "Decisions to Watch",  color: "#7B68EE" },
    { key: "peopleAndAccounts",   label: "People & Accounts",   color: "#5CB8FF" },
    { key: "inboxSlack",          label: "Inbox & Slack",       color: "#AAB3C5" },
  ];
  if (!briefing) return (
    <div className="px-6 py-12 text-center">
      <Newspaper size={28} className="text-[#AAB3C5]/20 mx-auto mb-3" />
      <p className="text-[13px] text-[#AAB3C5]/40">No briefing generated yet</p>
      <Link href="/dashboard/briefing" className="mt-3 inline-flex items-center gap-1.5 text-xs text-gold/70 hover:text-gold">
        Generate briefing <ArrowRight size={10} />
      </Link>
    </div>
  );
  const active = ALL_SECTIONS.filter(s => {
    const v = briefing[s.key];
    return typeof v === "string" && v.length > 0;
  });
  return (
    <div className="px-6 py-5 space-y-5">
      {briefing.summary && (
        <p className="text-[14px] text-[#F3EFE7]/75 leading-relaxed border-l-2 border-gold/30 pl-4">
          {briefing.summary}
        </p>
      )}
      {active.length === 0 ? (
        <p className="text-[12px] text-[#AAB3C5]/40">Briefing loaded — open full view for details.</p>
      ) : (
        <div className="space-y-5">
          {active.map(s => (
            <div key={s.key} className="flex gap-4">
              <div className="shrink-0 mt-1.5 h-2 w-2 rounded-full" style={{ background: s.color }} />
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] mb-1.5" style={{ color: `${s.color}AA` }}>{s.label}</p>
                <p className="text-[12px] text-[#AAB3C5]/70 leading-relaxed whitespace-pre-line">
                  {(briefing[s.key] as string).slice(0, 400)}
                  {(briefing[s.key] as string).length > 400 && "…"}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      {briefing.generatedAt && (
        <p className="text-xs text-[#AAB3C5]/25 pt-2 border-t border-gold/[0.06]">
          Generated {relTime(briefing.generatedAt)}
        </p>
      )}
    </div>
  );
}

function ExpandedScheduleContent({ events }: { events: CalendarEvent[] }) {
  const tz  = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  const now = Date.now();
  const sorted = [...events]
    .filter(e => !e.isAllDay)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  const today    = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const nextWeek = new Date(today); nextWeek.setDate(today.getDate() + 7);

  const groups: Array<{ label: string; events: CalendarEvent[] }> = [
    { label: "Today",    events: sorted.filter(e => { const d = new Date(e.start); return d >= today && d < tomorrow; }) },
    { label: "Tomorrow", events: sorted.filter(e => { const d = new Date(e.start); return d >= tomorrow && d < new Date(tomorrow.getTime() + 86400000); }) },
    { label: "This week",events: sorted.filter(e => { const d = new Date(e.start); return d >= new Date(tomorrow.getTime() + 86400000) && d < nextWeek; }) },
  ].filter(g => g.events.length > 0);

  if (sorted.length === 0) return (
    <div className="px-6 py-12 text-center">
      <Calendar size={28} className="text-[#AAB3C5]/20 mx-auto mb-3" />
      <p className="text-[13px] text-[#AAB3C5]/40">No upcoming events</p>
    </div>
  );

  return (
    <div className="px-6 py-4 space-y-5">
      {groups.map(({ label, events: grpEvents }) => (
        <div key={label}>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-gold/50 mb-2">{label}</p>
          <div className="space-y-1">
            {grpEvents.map(ev => {
              const isPast    = new Date(ev.end ?? ev.start).getTime() < now;
              const isCurrent = new Date(ev.start).getTime() <= now && new Date(ev.end ?? ev.start).getTime() > now;
              const dur       = ev.end ? durationMins(ev.start, ev.end) : 0;
              return (
                <div key={ev.id} className={cn(
                  "flex items-start gap-4 rounded-xl px-4 py-3",
                  isCurrent ? "bg-gold/[0.07]" : "hover:bg-white/[0.02]"
                )}>
                  <div className="shrink-0 w-16 text-right">
                    <p className={cn("text-[12px] font-medium tabular-nums", isCurrent ? "text-gold" : isPast ? "text-[#AAB3C5]/30" : "text-[#AAB3C5]/65")}>
                      {fmtEventTime(ev.start, tz)}
                    </p>
                    {dur > 0 && <p className="text-xs text-[#AAB3C5]/30">{dur}m</p>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {isCurrent && <span className="h-1.5 w-1.5 rounded-full bg-gold animate-pulse shrink-0" />}
                      {ev.hasVideo && <Video size={11} className="shrink-0 text-[#5CB8FF]/60" />}
                      <p className={cn("text-[13px] font-medium truncate", isPast ? "text-[#F3EFE7]/30 line-through" : "text-[#F3EFE7]/85")}>
                        {ev.summary}
                      </p>
                    </div>
                    {ev.attendees && ev.attendees.length > 0 && (
                      <p className="text-[10.5px] text-[#AAB3C5]/40 mt-0.5">
                        {ev.attendees.slice(0, 4).join(", ")}
                        {ev.attendees.length > 4 && ` +${ev.attendees.length - 4} more`}
                      </p>
                    )}
                    {!ev.attendees && ev.attendeeCount && ev.attendeeCount > 1 && (
                      <p className="text-[10.5px] text-[#AAB3C5]/40 mt-0.5">{ev.attendeeCount} attendees</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

const R_MODAL_SIZE = 260;
const R_MODAL_CX   = R_MODAL_SIZE / 2;
const R_MODAL_CY   = R_MODAL_SIZE / 2;
const R_MODAL_MAX  = (R_MODAL_SIZE / 2) - 16;

function ExpandedRadarContent({ signals }: { signals: RankedSignal[] }) {
  const sectors = Array.from({ length: 8 }, (_, i) => {
    const a = (i * 45 * Math.PI) / 180;
    return { x2: R_MODAL_CX + Math.cos(a) * R_MODAL_MAX, y2: R_MODAL_CY + Math.sin(a) * R_MODAL_MAX };
  });
  const dots = signals.slice(0, 40).map((s, i) => {
    const src    = SIGNAL_SOURCES.find(x => x.key === radarKey(s.source)) ?? SIGNAL_SOURCES[4];
    const score  = s.ranking?.score ?? 0.5;
    const jitter = ((i * 43 + i * i * 7) % 36) - 18;
    const ang    = ((src.angle + jitter) * Math.PI) / 180;
    const r      = R_MODAL_MAX * (0.18 + (1 - score) * 0.76);
    return { x: R_MODAL_CX + Math.cos(ang) * r, y: R_MODAL_CY + Math.sin(ang) * r, color: src.color, score, id: s.id };
  });
  const sorted = [...signals].sort((a, b) => (b.ranking?.score ?? 0) - (a.ranking?.score ?? 0));

  return (
    <div className="px-6 py-5">
      <div className="flex flex-col sm:flex-row gap-6 items-start">
        {/* Radar */}
        <div className="shrink-0 flex items-center justify-center">
          <svg width={R_MODAL_SIZE} height={R_MODAL_SIZE} viewBox={`0 0 ${R_MODAL_SIZE} ${R_MODAL_SIZE}`}>
            {sectors.map((s, i) => (
              <line key={i} x1={R_MODAL_CX} y1={R_MODAL_CY} x2={s.x2} y2={s.y2}
                stroke="rgba(200,169,107,0.08)" strokeWidth="1" />
            ))}
            {[0.28, 0.54, 0.80].map((frac, i) => (
              <circle key={i} cx={R_MODAL_CX} cy={R_MODAL_CY} r={R_MODAL_MAX * frac}
                fill="none" stroke={i === 2 ? "rgba(200,169,107,0.14)" : "rgba(200,169,107,0.07)"}
                strokeWidth={i === 2 ? "1.5" : "1"} strokeDasharray={i < 2 ? "4 5" : undefined} />
            ))}
            {SIGNAL_SOURCES.map(src => {
              const ang = (src.angle * Math.PI) / 180;
              const lx  = R_MODAL_CX + Math.cos(ang) * (R_MODAL_MAX + 12);
              const ly  = R_MODAL_CY + Math.sin(ang) * (R_MODAL_MAX + 12);
              return (
                <text key={src.key} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
                  fill={src.color} fontSize="9" opacity="0.65" fontFamily="system-ui">
                  {src.label}
                </text>
              );
            })}
            {signals.length === 0 ? (
              <text x={R_MODAL_CX} y={R_MODAL_CY + 4} textAnchor="middle"
                fill="#AAB3C5" fontSize="11" fontFamily="system-ui" opacity="0.3">no signals</text>
            ) : (
              <>
                {dots.map(dot => (
                  <g key={dot.id}>
                    <circle cx={dot.x} cy={dot.y} r={dot.score > 0.7 ? 9 : 6}
                      fill={dot.color} opacity={dot.score > 0.7 ? 0.18 : 0.09} />
                    <circle cx={dot.x} cy={dot.y} r={dot.score > 0.7 ? 4 : 2.8}
                      fill={dot.color} opacity={0.9} />
                  </g>
                ))}
                <circle cx={R_MODAL_CX} cy={R_MODAL_CY} r={18}
                  fill="rgba(7,17,31,0.90)" stroke="rgba(200,169,107,0.20)" strokeWidth="1" />
                <text x={R_MODAL_CX} y={R_MODAL_CY - 1} textAnchor="middle"
                  fill="#F3EFE7" fontSize="13" fontWeight="700" fontFamily="system-ui">
                  {signals.length}
                </text>
                <text x={R_MODAL_CX} y={R_MODAL_CY + 10} textAnchor="middle"
                  fill="#AAB3C5" fontSize="7" fontFamily="system-ui" opacity="0.5">signals</text>
              </>
            )}
          </svg>
        </div>

        {/* Signal list */}
        <div className="flex-1 min-w-0 space-y-1 max-h-72 overflow-y-auto basil-scroll">
          {sorted.length === 0 ? (
            <p className="text-[12px] text-[#AAB3C5]/40 py-6 text-center">No signals indexed yet</p>
          ) : (
            sorted.map(s => {
              const src = SIGNAL_SOURCES.find(x => x.key === radarKey(s.source)) ?? SIGNAL_SOURCES[4];
              const score = Math.round((s.ranking?.score ?? 0) * 100);
              return (
                <div key={s.id} className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-white/[0.03] transition-colors">
                  <div className="shrink-0 h-5 w-5 rounded flex items-center justify-center mt-0.5"
                    style={{ background: `${src.color}18`, color: src.color }}>
                    <span className="text-[8px] font-bold">{src.label.slice(0,2).toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-[#F3EFE7]/80 truncate">{s.title}</p>
                    <p className="text-xs text-[#AAB3C5]/40 truncate">{decodeHtml(s.snippet ?? "")}</p>
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-0.5">
                    <span className="text-xs font-bold tabular-nums" style={{ color: score > 70 ? "#D96C5F" : score > 40 ? "#D9A441" : "#AAB3C5" }}>
                      {score}
                    </span>
                    <span className="text-[9px] text-[#AAB3C5]/30">{relTime(s.occurredAt)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function ExpandedThreadsContent({ signals }: { signals: RankedSignal[] }) {
  if (signals.length === 0) return (
    <div className="px-6 py-12 text-center">
      <MessageSquare size={28} className="text-[#AAB3C5]/20 mx-auto mb-3" />
      <p className="text-[13px] text-[#AAB3C5]/40">No threads yet — connect your accounts</p>
    </div>
  );
  return (
    <div className="divide-y divide-gold/[0.07]">
      {signals.map(s => {
        const srcKey   = radarKey(s.source);
        const srcColor = SOURCE_COLOR[srcKey] ?? "#AAB3C5";
        const srcIcon  = SOURCE_ICON[srcKey]  ?? <Zap size={12} />;
        const score    = s.ranking?.score ?? 0;
        return (
          <div key={s.id} className="flex items-start gap-4 px-6 py-3.5 hover:bg-gold/[0.03] transition-colors">
            <div className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center mt-0.5"
              style={{ background: `${srcColor}15`, color: srcColor }}>
              {srcIcon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-[#F3EFE7]/85 leading-snug">{s.title}</p>
              {s.snippet && <p className="text-xs text-[#AAB3C5]/45 mt-0.5 line-clamp-2 leading-snug">{decodeHtml(s.snippet)}</p>}
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {s.participants?.slice(0, 3).map((p, pi) =>
                  p.canonicalId ? (
                    <Link key={pi} href={`/dashboard/contacts?highlight=${p.canonicalId}`}
                      className="text-xs text-gold/60 hover:text-gold transition-colors">
                      {p.name}
                    </Link>
                  ) : (
                    <span key={pi} className="text-xs text-[#AAB3C5]/40">{p.name}</span>
                  )
                )}
                <span className="text-xs text-[#AAB3C5]/25">{relTime(s.occurredAt)}</span>
                <span className="text-xs capitalize" style={{ color: srcColor + "99" }}>{srcKey}</span>
              </div>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1">
              {score > 0.7 && (
                <span className="text-[9px] font-semibold uppercase tracking-wide chip-gold px-1.5 py-0.5 rounded-full">High</span>
              )}
              <span className="text-xs font-bold tabular-nums" style={{ color: score > 0.7 ? "#D96C5F" : score > 0.4 ? "#D9A441" : "#AAB3C5" }}>
                {Math.round(score * 100)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExpandedRelationshipsContent({ contacts }: { contacts: RelContact[] }) {
  const sorted = [...contacts].sort((a, b) => {
    if (!a.lastInteraction) return 1;
    if (!b.lastInteraction) return -1;
    return new Date(b.lastInteraction).getTime() - new Date(a.lastInteraction).getTime();
  });
  if (sorted.length === 0) return (
    <div className="px-6 py-12 text-center">
      <Users size={28} className="text-[#AAB3C5]/20 mx-auto mb-3" />
      <p className="text-[13px] text-[#AAB3C5]/40">No relationships tracked yet</p>
    </div>
  );
  return (
    <div className="divide-y divide-gold/[0.07]">
      {sorted.map(c => {
        const trend = c.trend ?? "stable";
        const meta  = TREND_META[trend] ?? TREND_META.stable;
        const days  = c.lastInteraction
          ? Math.floor((Date.now() - new Date(c.lastInteraction).getTime()) / 86400000)
          : null;
        return (
          <div key={c.contactId} className="flex items-center gap-4 px-6 py-3 hover:bg-gold/[0.03] transition-colors">
            <div className="shrink-0 h-9 w-9 rounded-full flex items-center justify-center border"
              style={{ background: `${meta.color}12`, borderColor: `${meta.color}25`, color: meta.color }}>
              <span className="text-xs font-bold">{initials(c.name)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-[#F3EFE7]/82 truncate">{c.name}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-[10.5px] text-[#AAB3C5]/35">
                  {days === null ? "No record" : days === 0 ? "Active today" : `${days}d ago`}
                </p>
                {c.sources.length > 0 && (
                  <div className="flex items-center gap-1">
                    {c.sources.slice(0, 3).map(src => (
                      <span key={src} className="text-[9px] px-1 py-0.5 rounded"
                        style={{ background: `${SOURCE_COLOR[src] ?? "#AAB3C5"}18`, color: `${SOURCE_COLOR[src] ?? "#AAB3C5"}AA` }}>
                        {src}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* Recent activity items */}
              {c.recentItems && c.recentItems.length > 0 && (
                <div className="mt-1.5 space-y-0.5">
                  {c.recentItems.slice(0, 3).map((item, i) => (
                    <p key={i} className="text-xs text-[#AAB3C5]/40 truncate leading-snug">{item}</p>
                  ))}
                </div>
              )}
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1">
              <TrendSparkline trend={trend} color={meta.color} />
              <span className="text-[9.5px] font-medium" style={{ color: meta.color }}>{meta.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExpandedIntelligenceContent({ signals, actions }: { signals: RankedSignal[]; actions: ActionItem[] }) {
  const insights = computeInsights(signals, actions);
  const typeColor: Record<InsightType, string> = { warning: "#D9A441", info: "#5CB8FF", positive: "#1F8A70", neutral: "#AAB3C5" };
  const typeIcon:  Record<InsightType, React.ReactNode> = {
    warning:  <AlertCircle size={14} />,
    info:     <Brain size={14} />,
    positive: <CheckCircle2 size={14} />,
    neutral:  <Minus size={14} />,
  };
  if (insights.length === 0) return (
    <div className="px-6 py-12 text-center">
      <Shield size={28} className="text-[#AAB3C5]/20 mx-auto mb-3" />
      <p className="text-[13px] text-[#AAB3C5]/40">All clear — no alerts</p>
    </div>
  );
  return (
    <div className="px-6 py-5 space-y-3">
      {insights.map((ins, i) => (
        <Link
          key={i}
          href={ins.href}
          className="flex items-start gap-4 rounded-xl px-4 py-3.5 transition-all hover:brightness-125 active:scale-[0.99] block"
          style={{ background: `${typeColor[ins.type]}0A`, border: `1px solid ${typeColor[ins.type]}18` }}
        >
          <div className="flex items-start gap-4">
            <div className="shrink-0 mt-0.5" style={{ color: typeColor[ins.type] }}>
              {typeIcon[ins.type]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] text-[#F3EFE7]/75 leading-snug">{ins.text}</p>
              <p className="text-xs text-[#AAB3C5]/35 mt-1 font-mono">{ins.href}</p>
            </div>
            <ArrowRight size={12} className="shrink-0 mt-1 text-[#AAB3C5]/30" />
          </div>
        </Link>
      ))}
    </div>
  );
}

// ── SWR fetcher ───────────────────────────────────────────────────────────────
// Plain GET fetcher — returns null on non-2xx so callers can distinguish
// "loading" (undefined) from "unavailable" (null).
const swrFetch = (url: string) =>
  fetch(url).then(r => (r.ok ? r.json() : null));

// Shared SWR options: keep cache for 2 min, don't revalidate on window focus
// so navigating between pages doesn't trigger unnecessary refetches.
// ── LinearPanel — top Linear issues, lives on the home page ──────────────────

interface LinearIssueLite {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  state: { name: string; type: string };
  team?: { name: string };
  dueDate?: string | null;
  url: string;
  assignee?: { id: string; name: string } | null;
}

function LinearPanel({
  issues,
  loading,
  connected,
  onExpand,
}: {
  issues: LinearIssueLite[];
  loading: boolean;
  connected: boolean;
  onExpand?: () => void;
}) {
  // Sort by priority (1=Urgent → 4=Low; 0=None pushed last), then due date.
  const sorted = useMemo(() => {
    const score = (p: number) => (p === 0 ? 99 : p);
    return [...issues]
      .filter((i) => i.state.type !== "completed" && i.state.type !== "canceled")
      .sort((a, b) => {
        const pa = score(a.priority);
        const pb = score(b.priority);
        if (pa !== pb) return pa - pb;
        // Earlier due date wins; missing due date sorts last
        const da = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
        const db = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
        return da - db;
      })
      .slice(0, 6);
  }, [issues]);

  // Priority dot colour — matches the engineering signal language: red urgent → blue low.
  const PRIORITY_COLOUR: Record<number, string> = {
    1: "bg-[#D96C5F]",   // urgent
    2: "bg-gold-muted",   // high
    3: "bg-[#5CB8FF]/70",// normal
    4: "bg-[#AAB3C5]/50",// low
    0: "bg-white/15",    // none
  };

  return (
    <Panel
      title="Linear"
      href="/dashboard/linear"
      linkLabel="Open Linear →"
      onExpand={onExpand}
    >
      {!connected ? (
        <div className="px-4 py-6 text-center space-y-2">
          <Zap size={20} className="text-[#AAB3C5]/25 mx-auto" />
          <p className="text-xs text-[#AAB3C5]/50">Linear not connected</p>
          <Link
            href="/dashboard/settings"
            className="inline-block text-xs text-gold hover:underline"
          >
            Connect in Settings →
          </Link>
        </div>
      ) : loading ? (
        <div className="px-4 py-3 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-3">
              <div className="h-2 w-2 rounded-full bg-white/[0.06] animate-pulse shrink-0 mt-1.5" />
              <div className="flex-1 space-y-1.5">
                <div className="h-2.5 w-3/4 rounded bg-white/[0.06] animate-pulse" />
                <div className="h-2 w-1/2 rounded bg-white/[0.04] animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <CheckCircle2 size={20} className="text-[#1F8A70]/40 mx-auto mb-2" />
          <p className="text-xs text-[#AAB3C5]/40">No open issues</p>
        </div>
      ) : (
        <div className="divide-y divide-gold/[0.07]">
          {sorted.map((issue) => (
            <a
              key={issue.id}
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors group"
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full shrink-0 mt-1.5",
                  PRIORITY_COLOUR[issue.priority] ?? PRIORITY_COLOUR[0]
                )}
                title={`Priority ${issue.priority}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-[#AAB3C5]/55 shrink-0">
                    {issue.identifier}
                  </span>
                  <p className="text-[12px] font-medium leading-none truncate text-[#F3EFE7]/85 group-hover:text-[#F3EFE7]">
                    {issue.title}
                  </p>
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs text-[#AAB3C5]/40">
                  <span className="truncate">{issue.state.name}</span>
                  {issue.team?.name && <span>· {issue.team.name}</span>}
                  {issue.dueDate && (
                    <span className="text-gold-muted/70">· due {issue.dueDate}</span>
                  )}
                </div>
              </div>
              <ExternalLink size={11} className="text-[#AAB3C5]/20 group-hover:text-[#AAB3C5]/50 shrink-0 mt-1" />
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}

const SWR_OPTS = {
  revalidateOnFocus:    false,
  dedupingInterval:     300_000, // 5 min
  revalidateIfStale:    true,    // silently refresh stale data in background
} as const;

// ── Main Page ─────────────────────────────────────────────────────────────────

type PanelId = "briefing" | "schedule" | "radar" | "threads" | "relationships" | "intelligence" | "linear";

export default function DashboardPage() {
  // ── Clock state (local only, never fetched) ─────────────────────────────
  const [hour,          setHour]          = useState(new Date().getHours());
  const [dateLabel,     setDateLabel]     = useState("");
  const [expandedPanel, setExpandedPanel] = useState<PanelId | null>(null);

  useEffect(() => {
    const now = getNow();
    const tz  = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
    setHour(now.getHours());
    setDateLabel(now.toLocaleDateString("en-GB", {
      timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric",
    }));
  }, []);

  // Close modal on Escape
  useEffect(() => {
    if (!expandedPanel) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setExpandedPanel(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expandedPanel]);

  // ── SWR data hooks — cache persists across unmount/remount ──────────────
  const { data: settings }     = useSWR("/api/settings",                            swrFetch, SWR_OPTS);
  const { data: actionsData }  = useSWR("/api/actions",                             swrFetch, SWR_OPTS);
  const { data: signalsData }  = useSWR("/api/signals/ranked?tier=all&limit=50", swrFetch, SWR_OPTS);
  const { data: calendarData } = useSWR("/api/calendar",                            swrFetch, SWR_OPTS);
  const { data: contactsData } = useSWR("/api/contacts/activity",                   swrFetch, SWR_OPTS);
  const { data: briefingData } = useSWR("/api/generate/briefing",                   swrFetch, {
    ...SWR_OPTS,
    dedupingInterval: 300_000, // 5 min — avoid triggering generation too often
  });
  // Linear lives on the home page, not in nav — top open issues by priority.
  const { data: linearData }   = useSWR("/api/linear",                              swrFetch, SWR_OPTS);

  // ── Derived values ──────────────────────────────────────────────────────
  const firstName = settings?.name?.split(" ")[0] ?? "";

  const actionsRaw = actionsData
    ? (Array.isArray(actionsData) ? actionsData : (actionsData.actions ?? []))
    : undefined;

  const actions:  ActionItem[]    = actionsRaw    ?? [];
  const signals:  RankedSignal[]  = signalsData?.signals  ?? [];
  const events:   CalendarEvent[] = calendarData?.events   ?? [];
  const linearIssues: LinearIssueLite[] = linearData?.issues ?? [];
  // The /api/linear endpoint returns `{ connected: false }` when the user
  // hasn't linked Linear yet, so we trust the explicit flag when present.
  const linearConnected: boolean = linearData?.connected !== false;
  // Derive relationship trend from activity data — ContactActivity doesn't include trend,
  // so we compute it client-side from interaction recency and frequency.
  const contacts: RelContact[] = useMemo(() => {
    const raw = contactsData?.activity ?? [];
    return raw.map((c: { contactId: string; name: string; lastInteraction: string | null; sources: string[]; totalInteractionCount?: number; recentItems?: string[] }) => {
      const daysSince = c.lastInteraction
        ? Math.floor((Date.now() - new Date(c.lastInteraction).getTime()) / 86400000)
        : 999;
      const count = c.totalInteractionCount ?? 0;
      let trend: RelContact["trend"] = "stable";
      if (daysSince > 14)        trend = "at-risk";
      else if (count >= 10)      trend = "strengthening";
      else if (count <= 2)       trend = "cooling";
      return { contactId: c.contactId, name: c.name, lastInteraction: c.lastInteraction, sources: c.sources, trend, recentItems: c.recentItems };
    });
  }, [contactsData]);

  const briefing: BriefingData | null = briefingData ?? null;

  // "loading" is true only on the very first fetch (data is undefined).
  // briefingLoading tracked separately so the briefing panel shows skeleton while fetching.
  const loading =
    settings     === undefined ||
    actionsData  === undefined ||
    signalsData  === undefined ||
    calendarData === undefined;
  const briefingLoading = briefingData === undefined;

  // ── Derived counts ──────────────────────────────────────────────────────────
  const meetingsToday = useMemo(() => {
    const s = new Date(); s.setHours(0,0,0,0);
    const e = new Date(); e.setHours(23,59,59,999);
    return events.filter(ev => !ev.isAllDay && new Date(ev.start) >= s && new Date(ev.start) <= e).length;
  }, [events]);

  const actionsDue = useMemo(() => {
    const today = new Date(); today.setHours(23,59,59,999);
    return actions.filter(a => a.status !== "done" && a.dueDate && new Date(a.dueDate) <= today).length;
  }, [actions]);

  const criticalCount = useMemo(() =>
    actions.filter(a => a.priority === "urgent" || a.priority === "high").length +
    signals.filter(s => (s.ranking?.score ?? 0) > 0.70).length,
    [actions, signals]
  );
  const unreadThreads  = signals.length;
  const waitingOnCount = actions.filter(a => a.status === "waiting" || a.status === "blocked").length;
  const risksDetected  = signals.filter(s => (s.ranking?.score ?? 0) > 0.3).length;

  return (
    <div className="min-h-full">

      {/* ── Hero header ──────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden px-5 sm:px-8 pt-10 sm:pt-14 pb-8 sm:pb-12">
        <HeroLight />

        <div className="relative flex flex-col sm:flex-row items-start sm:justify-between gap-6" style={{ zIndex: 1 }}>
          <div>
            {/* Greeting eyebrow */}
            <div className="flex items-center gap-2.5 mb-5" suppressHydrationWarning>
              <div style={{ width: 20, height: 1, background: "rgba(210,168,70,0.45)" }} />
              <p style={{ fontSize: "9px", fontWeight: 700, letterSpacing: "0.46em", textTransform: "uppercase", color: "rgba(210,168,70,0.55)" }}>
                {getGreeting(hour)}
              </p>
            </div>
            {/* Main name — editorial, dominant */}
            <h1
              style={{
                fontFamily: "var(--font-fraunces), serif",
                fontStyle: "italic",
                fontSize: "clamp(3.5rem, 6vw, 5.5rem)",
                lineHeight: 0.88,
                letterSpacing: "-0.028em",
                color: "#F5EEE0",
                marginBottom: "1.4rem",
                textShadow: "0 4px 60px rgba(210,168,70,0.20), 0 1px 0 rgba(255,240,200,0.08)",
              }}
              suppressHydrationWarning
            >
              {firstName || "Welcome"}.
            </h1>
            {/* Tagline */}
            <p style={{ fontSize: "14px", color: "rgba(160,148,128,0.70)", letterSpacing: "0.01em", lineHeight: 1.5, marginBottom: "0.5rem" }}>
              Here&rsquo;s what matters most today.
            </p>
            {/* Date */}
            <p style={{ fontSize: "10.5px", color: "rgba(130,115,90,0.42)", letterSpacing: "0.06em", fontVariantNumeric: "tabular-nums" }} suppressHydrationWarning>
              {dateLabel}
            </p>
          </div>

          {!loading && (
            <AiConfidenceWidget signalCount={signals.length} contactCount={contacts.length} />
          )}
        </div>
      </div>

      <div className="px-7 pb-8 space-y-4">

        {/* ── Atmospheric metrics bar ──────────────────────────────────────────── */}
        <MetricBar
          loading={loading}
          metrics={[
            { label: "Critical",  sublabel: "Actions + signals",  value: loading ? null : criticalCount,  color: "#D96C5F", href: "/dashboard/actions",  icon: <AlertCircle size={13} /> },
            { label: "Meetings",  sublabel: "On your calendar",   value: loading ? null : meetingsToday,  color: "#C8A96B", href: "/dashboard/schedule", icon: <Calendar size={13} /> },
            { label: "Threads",   sublabel: "Across all sources", value: loading ? null : unreadThreads,  color: "#5CB8FF", href: "/dashboard",  icon: <MessageSquare size={13} /> },
            { label: "Waiting",   sublabel: "Blocked actions",    value: loading ? null : waitingOnCount, color: "#D9A441", href: "/dashboard/actions",  icon: <Clock size={13} /> },
            { label: "Risks",     sublabel: "High-score signals", value: loading ? null : risksDetected,  color: "#D96C5F", href: "/dashboard",  icon: <Zap size={13} /> },
          ]}
        />

        {/* ── Main row: Briefing · Schedule · Radar ───────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1.2fr_1fr] gap-4">
          <BriefingPanel    briefing={briefing} loading={loading} briefingLoading={briefingLoading} onExpand={() => setExpandedPanel("briefing")} />
          <SchedulePanel    events={events}     loading={loading} onExpand={() => setExpandedPanel("schedule")} />
          <SignalRadarPanel signals={signals}   loading={loading} onExpand={() => setExpandedPanel("radar")}   />
        </div>

        {/* ── Bottom row: Threads · Relationships · Intelligence ──────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ThreadsPanel       signals={signals}   loading={loading} onExpand={() => setExpandedPanel("threads")}       />
          <RelationshipsPanel contacts={contacts} loading={loading} onExpand={() => setExpandedPanel("relationships")} />
          <IntelligencePanel  signals={signals}   actions={actions} loading={loading} onExpand={() => setExpandedPanel("intelligence")} />
        </div>

        {/* ── Linear row — top open issues. Stand-alone so it can stretch wide. ── */}
        <LinearPanel
          issues={linearIssues}
          loading={loading && linearConnected}
          connected={linearConnected}
          onExpand={() => setExpandedPanel("linear")}
        />

      </div>

      {/* ── Pop-out modals ─────────────────────────────────────────────────────── */}
      {expandedPanel === "briefing" && (
        <PanelModal title="Today's Briefing" onClose={() => setExpandedPanel(null)}>
          <ExpandedBriefingContent briefing={briefing} />
        </PanelModal>
      )}
      {expandedPanel === "schedule" && (
        <PanelModal title="Upcoming Schedule" onClose={() => setExpandedPanel(null)}>
          <ExpandedScheduleContent events={events} />
        </PanelModal>
      )}
      {expandedPanel === "radar" && (
        <PanelModal title="Signal Radar" onClose={() => setExpandedPanel(null)} wide>
          <ExpandedRadarContent signals={signals} />
        </PanelModal>
      )}
      {expandedPanel === "threads" && (
        <PanelModal title="Recent Threads" onClose={() => setExpandedPanel(null)}>
          <ExpandedThreadsContent signals={signals} />
        </PanelModal>
      )}
      {expandedPanel === "relationships" && (
        <PanelModal title="Relationship Insights" onClose={() => setExpandedPanel(null)}>
          <ExpandedRelationshipsContent contacts={contacts} />
        </PanelModal>
      )}
      {expandedPanel === "intelligence" && (
        <PanelModal title="Basil Intelligence" onClose={() => setExpandedPanel(null)}>
          <ExpandedIntelligenceContent signals={signals} actions={actions} />
        </PanelModal>
      )}

    </div>
  );
}
