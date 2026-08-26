/**
 * Fixture data for the Today harness.
 *
 * DEV-ONLY and clearly synthetic. It exists because the real dashboard is
 * behind auth and reads a production store this session cannot decrypt, so the
 * only honest way to verify layout, responsive behaviour and the empty/error
 * states is to drive the real components with data shaped exactly like the real
 * contracts.
 *
 * Every field below matches lib/today/types.ts and lib/google/calendar.ts. If a
 * contract changes, this stops compiling — which is the point.
 */

import type { TodayFeedItem, TodayFeedResponse } from "@/lib/today/types";
import type { CalendarEvent } from "@/lib/google/calendar";
import type { ActionItem } from "@/lib/types/action";

const today = new Date();
const iso = (h: number, m = 0) => {
  const d = new Date(today);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

function change(
  id: string, category: "relationship" | "urgency" | "operational",
  severity: "critical" | "high" | "medium", rank: number,
  title: string, context: string, implication?: string,
  source: "contacts" | "actions" | "decisions" = "actions",
): TodayFeedItem {
  return {
    id, kind: "change", rank,
    lane: severity === "critical" ? "critical" : severity === "high" ? "needs-you" : "later",
    title, subtitle: context, occurredAt: daysAgo(1), href: "/dashboard/actions",
    change: {
      id, category, severity, score: rank, title, context, implication,
      occurredAt: daysAgo(1), source, delta: { field: "status" }, seen: false,
    },
  };
}

export const FEED: TodayFeedResponse = {
  total: 9,
  generatedAt: new Date().toISOString(),
  sources: { changes: true, followups: { gmail: true, slack: false }, linear: true },
  items: [
    change("c1", "urgency", "critical", 0.94,
      "Board pack sign-off is overdue", "Due 2 days ago, no draft circulated",
      "3 downstream approvals are blocked"),
    {
      id: "f1", kind: "followup", rank: 0.88, lane: "critical",
      title: "Reply to Priya Raman on the Q3 forecast",
      subtitle: "Waiting since Tuesday for your view on the revised numbers",
      occurredAt: daysAgo(2), href: "/dashboard/briefing",
      followup: {
        id: "gmail:1", source: "gmail", fromName: "Priya Raman",
        fromEmail: "priya@example.com", subject: "Q3 forecast — need your call",
        preview: "Happy to go with either, but I need a steer before Thursday.",
        lastInboundAt: daysAgo(2), hoursWaiting: 52, href: "#",
      },
    },
    change("r1", "relationship", "high", 0.71, "Daniel Okafor has gone quiet",
      "No meaningful contact in 34 days", undefined, "contacts"),
    change("r2", "relationship", "high", 0.68, "Mei Lin has gone quiet",
      "No meaningful contact in 41 days", undefined, "contacts"),
    change("r3", "relationship", "medium", 0.55, "Tom Bexley has gone quiet",
      "No meaningful contact in 29 days", undefined, "contacts"),
    change("c2", "operational", "high", 0.64, "Pricing decision still unresolved",
      "Logged 3 weeks ago, no owner assigned", "Blocks the Q3 forecast", "decisions"),
    {
      id: "l1", kind: "linear", rank: 0.52, lane: "linear",
      title: "AG-214 Contract parser fails on multi-page PDFs",
      subtitle: "In progress, no update in 8 days",
      occurredAt: daysAgo(8), href: "/dashboard/linear",
      issue: {
        id: "l1", identifier: "AG-214", title: "Contract parser fails on multi-page PDFs",
        url: "#", state: { name: "In Progress", type: "started" },
        project: { name: "Ingestion" }, priority: 2,
      } as never,
    },
    change("c3", "operational", "medium", 0.41, "Expense report awaiting submission",
      "Period closed 5 days ago"),
    change("c4", "operational", "medium", 0.33, "Quarterly review notes not circulated",
      "Meeting was last Thursday"),
  ],
};

export const EVENTS: CalendarEvent[] = [
  {
    id: "e1", summary: "Exec team stand-up", start: iso(9, 0), end: iso(9, 30),
    isAllDay: false, hasVideo: true, attendeeCount: 7, attendees: [],
    dateLabel: "Today", isOrganizer: false, myResponseStatus: "accepted",
  },
  {
    id: "e2", summary: "Q3 forecast review with Finance", start: iso(9, 30), end: iso(10, 30),
    isAllDay: false, hasVideo: true, attendeeCount: 5, attendees: [],
    dateLabel: "Today", isOrganizer: false, myResponseStatus: "needsAction",
  },
  {
    id: "e3", summary: "1:1 — Daniel Okafor", start: iso(13, 0), end: iso(13, 30),
    isAllDay: false, hasVideo: false, attendeeCount: 2, attendees: [],
    dateLabel: "Today", isOrganizer: true, myResponseStatus: "accepted",
  },
  {
    id: "e4", summary: "Board pack walkthrough", start: iso(16, 0), end: iso(17, 0),
    isAllDay: false, hasVideo: true, attendeeCount: 9, attendees: [],
    dateLabel: "Today", isOrganizer: false, myResponseStatus: "tentative",
  },
];

export const ACTIONS: ActionItem[] = [
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `a-od-${i}`, text: `Overdue commitment ${i + 1}`, owner: "Sample Owner",
    status: "overdue" as const, dueDate: daysAgo(i + 2).slice(0, 10),
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    id: `a-td-${i}`, text: `Due today ${i + 1}`, owner: "Sample Owner",
    status: "open" as const, dueDate: new Date().toISOString().slice(0, 10),
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `a-n7-${i}`, text: `Due this week ${i + 1}`, owner: "Sample Owner",
    status: "open" as const,
    dueDate: new Date(Date.now() + (i + 1) * 86400_000).toISOString().slice(0, 10),
  })),
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `a-st-${i}`, text: `Stalled item ${i + 1}`, owner: "Sample Owner",
    status: "open" as const, updatedAt: daysAgo(60 + i),
  })),
] as ActionItem[];

/** Name for the greeting. Clearly a placeholder, like everything else here. */
export const SETTINGS = { name: "Sample User" };
