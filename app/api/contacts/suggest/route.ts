import { NextResponse } from "next/server";
import { getRecentEmails } from "@/lib/google/gmail";
import { getRecentSlackMessages } from "@/lib/slack/client";
import { contacts } from "@/lib/contacts-data";
import { isSelf } from "@/lib/self-identity";
import { findContactByName } from "@/lib/contacts-lookup";
import type { ContactSuggestion } from "@/lib/types/contact";

/**
 * GET /api/contacts/suggest
 *
 * Scans recent email senders and Slack authors, filters out Michael himself
 * and known bots, de-dupes against existing contacts, and returns the top
 * people Michael is interacting with who aren't yet tracked in Contacts.
 *
 * Returned shape:
 *   suggestions: [{
 *     id, displayName, email?, slackChannels[], emailCount, slackCount,
 *     lastSeen, sample, signalSources[]
 *   }]
 */

const BOT_PATTERNS = [
  /^base44\s*slack\s*integration$/i,
  /^slackbot$/i,
  /^google\s+calendar$/i,
  /^notion$/i,
  /^linear$/i,
  /^github$/i,
  /^loom$/i,
  /^zoom$/i,
  /^claude$/i,
  /^posthog$/i,
  /^reclaim/i,
  /^asana$/i,
  /noreply/i,
  /no-reply/i,
  /^mailer-?daemon/i,
  /automation/i,
  /notifications?@/i,
  /\bbot\b/i,
];

function isBotIdentity(s: string): boolean {
  return BOT_PATTERNS.some((p) => p.test(s));
}

/** Parse a raw Gmail "From" header into { name, email }. */
function parseFromHeader(raw: string): { name: string; email?: string } {
  const m = raw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    return { name: m[1].replace(/^"|"$/g, "").trim() || m[2], email: m[2].trim().toLowerCase() };
  }
  if (raw.includes("@")) return { name: raw.trim(), email: raw.trim().toLowerCase() };
  return { name: raw.trim() };
}

function slugify(source: string): string {
  return source
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function GET() {
  const [emails, slacks] = await Promise.all([
    getRecentEmails(100).catch(() => []),
    getRecentSlackMessages(100).catch(() => []),
  ]);

  // Keyed by a stable identity — email when we have it, else slugified name.
  const byKey = new Map<string, ContactSuggestion>();

  const bump = (
    key: string,
    patch: Partial<ContactSuggestion> & { displayName: string; date: string; sample: string; source: "email" | "slack" }
  ) => {
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        id: key,
        displayName: patch.displayName,
        email: patch.email,
        slackChannels: patch.source === "slack" && patch.slackChannels ? [...patch.slackChannels] : [],
        emailCount: patch.source === "email" ? 1 : 0,
        slackCount: patch.source === "slack" ? 1 : 0,
        lastSeen: patch.date,
        sample: patch.sample,
        signalSources: [patch.source],
      });
      return;
    }
    if (patch.source === "email") existing.emailCount++;
    if (patch.source === "slack") {
      existing.slackCount++;
      if (patch.slackChannels) {
        for (const ch of patch.slackChannels) {
          if (!existing.slackChannels.includes(ch)) existing.slackChannels.push(ch);
        }
      }
    }
    if (new Date(patch.date) > new Date(existing.lastSeen)) {
      existing.lastSeen = patch.date;
      existing.sample = patch.sample;
    }
    if (!existing.signalSources.includes(patch.source)) existing.signalSources.push(patch.source);
    if (!existing.email && patch.email) existing.email = patch.email;
  };

  // ── Email senders ──
  for (const e of emails) {
    const { name, email } = parseFromHeader(e.from);
    if (!name || isSelf(name) || (email && isSelf(email))) continue;
    if (isBotIdentity(name) || (email && isBotIdentity(email))) continue;

    // Skip if already in contacts (by name or email match)
    if (findContactByName(name)) continue;
    if (email && contacts.some((c) => c.email?.toLowerCase() === email)) continue;

    const key = email || slugify(name);
    bump(key, {
      displayName: name,
      email,
      date: e.date,
      sample: `Email — "${e.subject}"`,
      source: "email",
    });
  }

  // ── Slack authors ──
  for (const m of slacks) {
    if (!m.author || isSelf(m.author)) continue;
    if (isBotIdentity(m.author)) continue;
    if (isBotIdentity(m.channel)) continue;

    if (findContactByName(m.author)) continue;

    const key = slugify(m.author);
    bump(key, {
      displayName: m.author,
      date: m.date,
      sample: `Slack ${m.channel}: ${m.text.slice(0, 100)}`,
      slackChannels: [m.channel],
      source: "slack",
    });
  }

  // Rank: combined recency + frequency — more signal, more recent = higher.
  const now = Date.now();
  const suggestions = [...byKey.values()]
    .map((s) => {
      const daysOld = Math.max(1, (now - new Date(s.lastSeen).getTime()) / 86400000);
      const score = (s.emailCount * 3 + s.slackCount) / Math.sqrt(daysOld);
      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ score: _score, ...s }) => s); // eslint-disable-line @typescript-eslint/no-unused-vars

  return NextResponse.json({
    suggestions,
    fetchedAt: new Date().toISOString(),
    scanned: { emails: emails.length, slack: slacks.length },
  });
}
