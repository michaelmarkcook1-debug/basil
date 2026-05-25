"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getGreeting } from "@/lib/utils";
import { getNow } from "@/lib/datetime";
import { NowPanel } from "./components/now-panel";
import { SignalsFeed } from "./components/signals-feed";
import { AttentionLayer } from "./components/attention-layer";
import { ReadinessCard } from "./components/readiness-card";
import { WhatChangedWidget } from "./components/what-changed";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export default function DashboardPage() {
  const greeting = getGreeting();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [firstName, setFirstName] = useState("");
  const [today, setToday] = useState("");

  useEffect(() => {
    const now = getNow();
    const userTz =
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined;
    setToday(
      now.toLocaleDateString("en-GB", {
        timeZone: userTz,
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    );
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.name) setFirstName(d.name.split(" ")[0]);
      })
      .catch(() => {});
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    router.push(`/dashboard/chat?q=${encodeURIComponent(searchQuery.trim())}`);
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-[1400px] mx-auto space-y-8">

      {/* ── System health alert (only renders when there are blockers) ─── */}
      <ReadinessCard />

      {/* ── Page header: date / greeting / search ────────────────────── */}
      <header className="flex flex-col sm:flex-row sm:items-end gap-4 justify-between">
        {/* Left: date + greeting */}
        <div className="space-y-1">
          <p className="basil-eyebrow" suppressHydrationWarning>
            {today}
          </p>
          <h1
            className="basil-display text-2xl sm:text-3xl lg:text-[36px] leading-[1.1] text-foreground"
            suppressHydrationWarning
          >
            {greeting},{" "}
            <span className="italic text-[oklch(0.72_0.15_85)]">
              {firstName || "there"}
            </span>
            <span className="text-[oklch(0.72_0.15_85)]">.</span>
          </h1>
        </div>

        {/* Right: search */}
        <form
          onSubmit={handleSearch}
          className="relative group sm:w-[280px] lg:w-[320px] shrink-0"
        >
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 group-focus-within:text-[oklch(0.72_0.15_85)] transition-colors" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search or ask Basil…"
            className={cn(
              "w-full h-9 rounded-lg border border-border/60 bg-card/40",
              "pl-9 pr-10 text-sm placeholder:text-muted-foreground/40",
              "focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40",
              "focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/10 transition-all"
            )}
          />
          <kbd className="absolute right-2 top-1/2 -translate-y-1/2 hidden md:inline-flex items-center rounded border border-border bg-background px-1 py-0.5 text-[10px] font-mono text-muted-foreground/50">
            ⏎
          </kbd>
        </form>
      </header>

      {/* ── Attention Layer — operational core ───────────────────────── */}
      {/*
        This is the primary surface. Every render decision here is driven
        by urgency: overdue commitments, blockers, approvals, stakeholder
        silence, imminent meetings. No passive counts. No ambient data.
      */}
      <section>
        {/* Section rule — thin, directional */}
        <div className="flex items-center gap-4 mb-4">
          <div className="h-px w-4 bg-[oklch(0.72_0.15_85)]/40 shrink-0" />
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground/50 shrink-0">
            Attention
          </p>
          <div className="h-px flex-1 bg-gradient-to-r from-border/40 to-transparent" />
        </div>
        <AttentionLayer />
      </section>

      {/* ── Context row: calendar + signals ──────────────────────────── */}
      {/*
        Supporting context. The NowPanel shows what's on deck.
        Signals surfaces incoming mail, Slack, and Linear.
        Both are secondary to the Attention Layer above.
      */}
      <section className="grid gap-5 lg:grid-cols-[340px_1fr] items-start">
        <NowPanel />
        <SignalsFeed />
      </section>

      {/* ── What changed — delta strip ────────────────────────────────── */}
      {/*
        Surfaced last because it's retrospective, not prospective.
        Shows recent changes Basil noticed: relationship shifts, new
        decisions, status changes.
      */}
      <section>
        <WhatChangedWidget />
      </section>

    </div>
  );
}
