/**
 * GET /api/zoom/meetings
 *
 * Returns processed Zoom meeting intelligence:
 * - Recent meeting summaries from Gmail (processed by extractZoomMeeting)
 * - Per-attendee participation data from the memory store
 * - Action items and decisions extracted from meetings (from stores)
 * - Meeting cadence metrics per contact
 *
 * Used by the dashboard to surface Zoom insights in contacts, signals,
 * and the meeting prep flow.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listMemories } from "@/lib/memory/store";
import { listActions } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  try {
    const [memories, actions, decisions] = await Promise.all([
      listMemories(username),
      listActions(username),
      listDecisions(username),
    ]);

    // ── Meeting summaries from memory store ──────────────────────────────────
    // Context memories with Zoom prefix represent processed meeting summaries.
    const meetingSummaries = memories
      .filter(
        (m) =>
          m.kind === "context" &&
          m.content.startsWith("[Zoom meeting") &&
          new Date(m.updatedAt) > thirtyDaysAgo
      )
      .sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
      .slice(0, 20)
      .map((m) => {
        // Extract title from "[Zoom meeting — Title]"
        const titleMatch = m.content.match(/\[Zoom meeting — ([^\]]+)\]/);
        // Extract attendees from "Attendees: A, B, C."
        const attendeesMatch = m.content.match(/Attendees: ([^.]+)\./);
        const summaryText = m.content
          .replace(/\[Zoom meeting[^\]]*\][^.]*\.\s*/, "")
          .replace(/Attendees:[^.]*\.\s*/, "")
          .trim();
        return {
          id: m.id,
          title: titleMatch?.[1] ?? "Zoom Meeting",
          attendees: attendeesMatch
            ? attendeesMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          summary: summaryText,
          date: m.updatedAt,
          sourceRef: m.sourceRef,
        };
      });

    // ── Per-attendee participation ────────────────────────────────────────────
    // Person memories represent confirmed Zoom participants.
    const participantMemories = memories.filter(
      (m) =>
        m.kind === "person" &&
        m.entity &&
        /^Zoom meeting participant:/i.test(m.content) &&
        new Date(m.updatedAt) > thirtyDaysAgo
    );

    // Aggregate by attendee name: count meetings, collect dates
    const attendeeMap = new Map<
      string,
      { name: string; meetingCount: number; dates: string[]; meetings: string[] }
    >();

    for (const mem of participantMemories) {
      if (!mem.entity) continue;
      const existing = attendeeMap.get(mem.entity) ?? {
        name: mem.entity,
        meetingCount: 0,
        dates: [],
        meetings: [],
      };
      const dateMatch = mem.content.match(/on (\d{4}-\d{2}-\d{2})\./);
      const titleMatch = mem.content.match(/participant: "([^"]+)"/);
      if (dateMatch) existing.dates.push(dateMatch[1]);
      if (titleMatch) existing.meetings.push(titleMatch[1]);
      existing.meetingCount++;
      attendeeMap.set(mem.entity, existing);
    }

    const attendees = Array.from(attendeeMap.values())
      .sort((a, b) => b.meetingCount - a.meetingCount)
      .map((a) => ({
        ...a,
        cadence:
          a.meetingCount >= 8
            ? "2×/week"
            : a.meetingCount >= 4
            ? "weekly"
            : a.meetingCount >= 2
            ? "bi-weekly"
            : "monthly",
        lastSeen: a.dates.sort().reverse()[0] ?? null,
      }));

    // ── Meeting-sourced actions and decisions ─────────────────────────────────
    const meetingActions = actions
      .filter((a) => a.source === "meeting" && new Date(a.createdAt) > thirtyDaysAgo)
      .slice(0, 20)
      .map((a) => ({
        id: a.id,
        text: a.text,
        owner: a.owner,
        status: a.status,
        priority: a.priority,
        dueDate: a.dueDate,
        sourceRef: a.sourceRef,
        createdAt: a.createdAt,
      }));

    const meetingDecisions = decisions
      .filter((d) => d.source === "meeting" && new Date(d.createdAt) > thirtyDaysAgo)
      .slice(0, 20)
      .map((d) => ({
        id: d.id,
        title: d.title,
        text: d.text,
        decidedBy: d.decidedBy,
        date: d.date,
        sourceRef: d.sourceRef,
        createdAt: d.createdAt,
      }));

    // ── Summary stats ──────────────────────────────────────────────────────────
    const stats = {
      meetingsLast30d: meetingSummaries.length,
      uniqueAttendeesLast30d: attendees.length,
      actionsExtracted: meetingActions.length,
      decisionsExtracted: meetingDecisions.length,
      openMeetingActions: meetingActions.filter((a) => a.status === "open").length,
    };

    return NextResponse.json({
      meetings: meetingSummaries,
      attendees,
      actions: meetingActions,
      decisions: meetingDecisions,
      stats,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[zoom/meetings] fetch failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch Zoom meeting data" },
      { status: 500 }
    );
  }
}
