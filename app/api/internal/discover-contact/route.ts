import { NextRequest, NextResponse } from "next/server";
import { getUserProfile, searchSlackMessages } from "@/lib/slack/client";
import { searchDriveFiles } from "@/lib/google/drive";
import { getRecentEmails } from "@/lib/google/gmail";

/**
 * GET /api/internal/discover-contact?email=robin@example.com&name=Robin
 *
 * Dev-only discovery helper — pulls whatever signal we have on a person from
 * Slack profile, Slack message history, Drive files, and recent email so we
 * can build a real persona for them in contacts-data.ts.
 */
export async function GET(req: NextRequest) {
  // Dev-only: pulls raw signal from Slack/Drive/Gmail for persona-building.
  // Unauthenticated; do not expose in production.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const email = searchParams.get("email") || undefined;
  const name = searchParams.get("name") || undefined;
  const queries = [email, name].filter(Boolean) as string[];

  // Dev-only route — caller must supply ?username= to identify whose tokens to use.
  const devUsername = searchParams.get("username") || process.env.ADMIN_USERNAME;
  if (!devUsername) {
    return NextResponse.json(
      { error: "Provide ?username= or set ADMIN_USERNAME" },
      { status: 400 }
    );
  }

  const profile = email ? await getUserProfile(devUsername, email) : null;

  const slackResults: Record<string, unknown> = {};
  for (const q of queries) {
    try {
      const msgs = await searchSlackMessages(devUsername, q, 20);
      slackResults[q] = msgs.map((m) => ({
        channel: m.channel,
        author: m.author,
        date: m.date,
        text: m.text,
      }));
    } catch (e) {
      slackResults[q] = `error: ${e instanceof Error ? e.message : e}`;
    }
  }

  const driveResults: Record<string, unknown> = {};
  for (const q of queries) {
    try {
      const files = await searchDriveFiles(devUsername, q, 10);
      driveResults[q] = files;
    } catch (e) {
      driveResults[q] = `error: ${e instanceof Error ? e.message : e}`;
    }
  }

  const emails = await getRecentEmails(devUsername, 100).catch(() => []);
  const matchedEmails = emails
    .filter((e) => {
      const hay = `${e.from} ${e.subject} ${e.snippet}`.toLowerCase();
      return queries.some((q) => hay.includes(q.toLowerCase()));
    })
    .slice(0, 20)
    .map((e) => ({ from: e.from, date: e.date, subject: e.subject, snippet: e.snippet }));

  return NextResponse.json({
    profile,
    slack: slackResults,
    drive: driveResults,
    emails: matchedEmails,
  });
}
