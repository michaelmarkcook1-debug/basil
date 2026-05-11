/**
 * GET /api/memory/recent-meetings
 *
 * Returns the 20 most-recent Zoom meeting summary memories (kind:"context"
 * with a sourceRef starting "gmail:" that mention a meeting title or Zoom).
 * Used by the Meetings tab to surface past meeting intelligence alongside the
 * Google Calendar upcoming events list.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listMemories } from "@/lib/memory/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let all;
  try {
    all = await listMemories(username);
  } catch (err) {
    console.error("[recent-meetings] failed to load memories:", err);
    return NextResponse.json({ memories: [] });
  }

  // Filter for Zoom meeting context memories — they have:
  //   kind: "context"
  //   sourceRef starting with "gmail:" (Zoom emails) or source: "inferred"
  //   content containing a Zoom meeting marker
  const meetingMemories = all
    .filter(
      (m) =>
        m.kind === "context" &&
        (m.sourceRef?.startsWith("gmail:") || m.source === "inferred") &&
        (m.content.includes("[Zoom meeting") ||
          m.content.includes("Zoom meeting") ||
          m.content.includes("meeting recap") ||
          m.content.startsWith("[Slack") === false) // exclude pure-Slack context
    )
    .filter((m) => m.content.includes("[Zoom meeting") || m.content.toLowerCase().includes("zoom"))
    .sort((a, b) => {
      // Sort by createdAt descending
      const ta = a.createdAt || "0";
      const tb = b.createdAt || "0";
      return tb.localeCompare(ta);
    })
    .slice(0, 20)
    .map((m) => ({
      id: m.id,
      content: m.content,
      entity: m.entity,
      createdAt: m.createdAt,
      sourceRef: m.sourceRef,
      eventId: m.eventId,
    }));

  return NextResponse.json({ memories: meetingMemories });
}
