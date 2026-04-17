import { NextResponse } from "next/server";
import { createEvent, hasExternalId } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import type { IngestPayload } from "@/lib/events/types";
import { getTodayEvents } from "@/lib/google/calendar";
import { getRecentEmails } from "@/lib/google/gmail";
import { getRecentSlackMessages } from "@/lib/slack/client";
import { isSelf } from "@/lib/self-identity";

/**
 * POST /api/events/poll-ingest
 *
 * Pulls recent signal from the working integrations (Gmail, Slack, Calendar)
 * and runs each item through the rules engine to create Basil events. Dedupes
 * against previously-seen externalIds so repeated polling is idempotent.
 *
 * This exists because real webhook subscriptions (Gmail Pub/Sub, Slack Events
 * API, Calendar events.watch) aren't registered yet. Polling bridges the gap
 * so "Basil is watching" actually has something to watch.
 */
export async function POST() {
  const payloads: IngestPayload[] = [];

  // Parallel fetch, each source failing softly so a broken integration
  // doesn't poison the whole poll.
  const [emails, slacks, calEvents] = await Promise.all([
    getRecentEmails(20).catch(() => []),
    getRecentSlackMessages(30).catch(() => []),
    getTodayEvents().catch(() => []),
  ]);

  for (const e of emails) {
    payloads.push({
      source: "email",
      externalId: `gmail:${e.id}`,
      title: e.subject || "(no subject)",
      body: e.snippet || "",
      from: e.from,
      hints: {
        isDM: false,
      },
    });
  }

  // Skip self-authored messages (nothing to draft a reply to our own message)
  // and known bot/integration DMs (Google Calendar notifications, Slackbot, etc.
  // don't need a Basil event — they're not people Michael is in conversation with).
  const BOT_CHANNEL_NAMES = [
    "google calendar",
    "slackbot",
    "notion",
    "linear",
    "github",
    "loom",
    "zoom",
    "claude",
    "reclaim",
    "asana",
  ];
  const isBotChannel = (channel: string) => {
    const c = channel.toLowerCase();
    return BOT_CHANNEL_NAMES.some((n) => c.includes(`dm: ${n}`));
  };

  for (const m of slacks) {
    if (isSelf(m.author)) continue;
    if (isBotChannel(m.channel)) continue;
    const isDM = m.channel.startsWith("DM:");
    const isGroupDM = m.channel.startsWith("Group DM");
    payloads.push({
      source: "slack",
      externalId: `slack:${m.channelId || m.channel}:${m.id}`,
      title: `${m.channel} — ${m.author}`,
      body: m.text,
      from: m.author,
      channel: m.channel,
      hints: {
        isDM,
        isGroupDM,
        isMention: m.isMention,
      },
    });
  }

  for (const c of calEvents) {
    payloads.push({
      source: "calendar",
      externalId: `calendar:${c.id}`,
      title: c.summary,
      body: `${c.dateLabel || "Today"} — ${c.attendees.join(", ") || "no attendees listed"}`,
      from: c.attendees[0],
    });
  }

  // Dedupe + persist
  let ingested = 0;
  for (const p of payloads) {
    if (p.externalId && (await hasExternalId(p.externalId))) continue;
    const shaped = eventFromIngest(p);
    const event = await createEvent(shaped);
    publish(event);
    ingested++;
  }

  return NextResponse.json({
    ingested,
    scanned: payloads.length,
    sources: {
      email: emails.length,
      slack: slacks.length,
      calendar: calEvents.length,
    },
  });
}
