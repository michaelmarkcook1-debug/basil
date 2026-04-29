"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getGreeting } from "@/lib/utils";
import { NowPanel } from "./components/now-panel";
import { PulseStrip } from "./components/pulse-strip";
import { DayTimeline } from "./components/day-timeline";
import { SignalsFeed } from "./components/signals-feed";
import { RelationshipCard } from "./components/relationship-card";
import { QuickActions } from "./components/quick-actions";
import { BasilWatching } from "./components/basil-watching";
import { MemoryPanel } from "./components/memory-panel";
import { Search } from "lucide-react";

export default function DashboardPage() {
  const greeting = getGreeting();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  // Hydration-safe date: initialise empty, set on client only so server and
  // client always render the same initial HTML.
  const [today, setToday] = useState("");
  useEffect(() => {
    setToday(
      new Date().toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    );
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    router.push(`/dashboard/chat?q=${encodeURIComponent(searchQuery.trim())}`);
  }

  return (
    <div className="p-4 sm:p-6 lg:p-10 space-y-8 max-w-[1400px] mx-auto">
      {/* ── Hero: compact greeting + "Now" focus card ── */}
      <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
        <div className="space-y-5">
          <div className="space-y-2">
            <p className="basil-eyebrow">{today}</p>
            <h1 className="basil-display text-3xl sm:text-4xl lg:text-[44px] leading-[1.05] text-foreground">
              {greeting},{" "}
              <span className="italic text-[oklch(0.72_0.15_85)]">Michael</span>
              <span className="text-[oklch(0.72_0.15_85)]">.</span>
            </h1>
            <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
              Here&apos;s your executive briefing — what&apos;s next, what&apos;s
              live, and who needs you today.
            </p>
          </div>

          <form onSubmit={handleSearch} className="relative group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70 group-focus-within:text-[oklch(0.72_0.15_85)] transition-colors" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Ask Basil anything — search, draft, schedule…"
              className="w-full h-12 rounded-xl border border-border bg-card/60 backdrop-blur pl-11 pr-4 md:pr-20 text-[16px] sm:text-sm placeholder:text-muted-foreground/60 shadow-sm focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40 focus:ring-4 focus:ring-[oklch(0.72_0.15_85)]/10 transition-all"
            />
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden md:inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[12px] font-mono text-muted-foreground">
              ⏎
            </kbd>
          </form>
        </div>

        <NowPanel />
      </div>

      {/* ── Pulse: at-a-glance metrics ── */}
      <PulseStrip />

      {/* ── Quick actions ── */}
      <QuickActions />

      {/* ── Proactive Basil: what Basil is watching across your inputs ── */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <p className="basil-eyebrow">Proactive</p>
          <div className="h-px flex-1 ml-4 bg-gradient-to-r from-border to-transparent" />
        </div>
        <BasilWatching />
      </section>

      {/* ── Main split: timeline + signals + memory ── */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <p className="basil-eyebrow">Your Day</p>
          <div className="h-px flex-1 ml-4 bg-gradient-to-r from-border to-transparent" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr_320px]">
          <DayTimeline />
          <SignalsFeed />
          <MemoryPanel />
        </div>
      </section>

      {/* ── Relationships ── */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <p className="basil-eyebrow">Relationships</p>
          <div className="h-px flex-1 ml-4 bg-gradient-to-r from-border to-transparent" />
        </div>
        <RelationshipCard />
      </section>
    </div>
  );
}
