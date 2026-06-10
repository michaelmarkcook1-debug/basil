"use client";

import { useEffect, useState } from "react";

/**
 * Thin "first sync in progress" strip shown across the dashboard while a day-0
 * backfill is running for the just-connected user. Polls the sync-status
 * endpoint and renders nothing once the sync window has elapsed. Sets the
 * expectation that data is on its way instead of showing bare empty states.
 */
export function SyncBanner() {
  const [syncing, setSyncing] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch("/api/onboarding/sync-status", { cache: "no-store" });
        const data = (await res.json()) as { syncing?: boolean };
        if (!active) return;
        setSyncing(!!data.syncing);
        if (data.syncing) timer = setTimeout(poll, 15_000);
      } catch {
        // Transient — stop polling; not worth surfacing.
      }
    };
    poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!syncing || dismissed) return null;

  return (
    <div className="sticky top-0 z-30 flex items-center gap-2.5 px-4 py-2 text-[0.8125rem] border-b border-[#C8A96B]/25 bg-[#0B1730]/95 backdrop-blur supports-[backdrop-filter]:bg-[#0B1730]/80">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#C8A96B] opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#C8A96B]" />
      </span>
      <span className="text-foreground/80">
        Basil is pulling in your recent activity — your first briefing will appear here shortly.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-auto shrink-0 text-foreground/40 transition-colors hover:text-foreground/70"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
