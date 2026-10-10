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
import { useEffect, useState } from "react";
import { EmailPanel } from "@/components/email/email-panel";
import { gmailIdOf, preloadEmails } from "@/components/email/use-email";
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
  // Replied from here → off the list now, not at the next refresh.
  const [replied, setReplied] = useState<Set<string>>(new Set());
  const mailConnected = !!data?.sources.followups.gmail || !!data?.sources.followups.slack;
  const count = data?.totals?.followups ?? threads.length;
  // Emails open in place. ?open=gmail:<id> (the link Today's feed carries) opens one on arrival.
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("open");
    if (wanted) setOpenId(wanted);
  }, []);
  const emailIds = threads.flatMap((t) => gmailIdOf(t.followup.id) ?? []).slice(0, 12).join(",");
  useEffect(() => {
    if (emailIds) preloadEmails(emailIds.split(","));
  }, [emailIds]);

  return (
    <div className="wire min-h-full">
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
                {threads.filter((i) => !replied.has(i.id)).map((i) => {
                  const messageId = gmailIdOf(i.followup.id);
                  const reading = openId === i.followup.id;
                  const row = (
                    <>
                      <p className="truncate text-[0.875rem] font-medium text-[color:var(--w-ink)]">{i.title}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-[0.75rem] text-[color:var(--w-ink-soft)]">
                        <span className="truncate">{i.followup.fromName}</span>
                        <span className="truncate">{i.followup.subject}</span>
                        <span className="wire-data shrink-0 text-[color:var(--w-manila)]">{waiting(i.followup.hoursWaiting)}</span>
                      </p>
                    </>
                  );
                  const rowClass = "block min-h-[44px] w-full min-w-0 px-3.5 py-2.5 text-left hover:bg-[var(--w-tray)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
                  return (
                    <li key={i.id}>
                      {messageId ? (
                        <button type="button" className={rowClass} aria-expanded={reading} onClick={() => setOpenId(reading ? null : i.followup.id)}>
                          {row}
                        </button>
                      ) : (
                        <Link href={i.href ?? "#"} className={rowClass}>{row}</Link>
                      )}
                      {messageId && reading && (
                        <div className="border-t border-[var(--w-rule)] px-3.5 py-3">
                          <EmailPanel
                            messageId={messageId}
                            onSent={() => { setReplied((s) => new Set(s).add(i.id)); setOpenId(null); }}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
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
    </div>
  );
}
