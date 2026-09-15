"use client";

/**
 * Every thread awaiting a reply — the full queue behind the Today panel.
 *
 * Today shows the top four and links here. Until 2026-09-15 this page did not
 * exist: "All threads" and the "Awaiting your reply" tile were both 404s from
 * the primary dashboard. The list is the same feed with the display cap off
 * (`/api/today?full=1`), so the count here is the count Today shows.
 */

import useSWR from "swr";
import Link from "next/link";
import type { TodayFeedResponse, TodayFollowupItem } from "@/lib/today/types";
import { Card, Empty, Failed, Loading, Panel, Unavailable } from "@/components/today/primitives";

async function swrFetch(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function waiting(hours: number): string {
  return hours >= 24 ? `${Math.floor(hours / 24)}d waiting` : `${hours}h waiting`;
}

export default function ThreadsPage() {
  const { data, error, isLoading } = useSWR<TodayFeedResponse>(
    "/api/today?full=1", swrFetch, { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
  const threads = (data?.items ?? []).filter((i): i is TodayFollowupItem => i.kind === "followup");
  const mailConnected = !!data?.sources.followups.gmail || !!data?.sources.followups.slack;
  const count = data?.totals?.followups ?? threads.length;

  return (
    <main className="wire min-h-full">
      <div className="mx-auto w-full max-w-[52rem] px-4 sm:px-6 py-4 sm:py-6">
        <Panel
          title="Awaiting your reply"
          id="threads-h"
          action={
            data ? (
              <span className="wire-data text-[0.75rem] text-[color:var(--w-ink-soft)]">
                {count} thread{count === 1 ? "" : "s"}
              </span>
            ) : undefined
          }
        >
          {error ? (
            <Failed what="Your threads" onRetry={() => location.reload()} />
          ) : isLoading ? (
            <Loading label="Reading your threads…" rows={4} />
          ) : !mailConnected ? (
            <Unavailable what="Threads" why="Gmail and Slack are not connected, so Basil cannot see what is waiting." />
          ) : threads.length === 0 ? (
            <Empty>Nobody is waiting on a reply from you.</Empty>
          ) : (
            <Card>
              <ul className="divide-y divide-[var(--w-rule)]">
                {threads.map((i) => (
                  <li key={i.id}>
                    <Link
                      href={i.href ?? "#"}
                      className="block min-h-[44px] px-3.5 py-2.5 hover:bg-[var(--w-tray)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      <p className="truncate text-[0.875rem] font-medium text-[color:var(--w-ink)]">{i.title}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-[0.75rem] text-[color:var(--w-ink-soft)]">
                        <span className="truncate">{i.followup.fromName}</span>
                        <span className="truncate">{i.followup.subject}</span>
                        <span className="wire-data shrink-0 text-[color:var(--w-manila)]">{waiting(i.followup.hoursWaiting)}</span>
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </Panel>

        <p className="mt-6 text-[0.8125rem] text-[color:var(--w-ink-soft)]">
          <Link href="/dashboard" className="font-semibold underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>
            ← Today
          </Link>
        </p>
      </div>
    </main>
  );
}
