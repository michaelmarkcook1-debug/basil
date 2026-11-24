/**
 * Draft a contact's personality profile from everything Basil can read.
 *
 * Moved out of app/api/contacts/generate-profile/route.ts on 2026-11-10: Ask
 * Basil's generateContactProfile tool fetched that route over HTTP with no
 * session cookie, so it was always 401. The route (after its own auth) and the
 * tool (with its own username) now both call this.
 */
import "server-only";
import { MAX_TOKENS, PROVIDER_MODE } from "@/lib/ai/model-config";
import { getTaskSystemPrompt } from "@/lib/ai/system-prompt";
import { generateValidated } from "@/lib/ai/generate-validated";
import { ContactProfileClaimsSchema, type ContactProfileOutput } from "@/lib/ai/schemas";
import { numberEvidence, finalizeClaims, citedClaims, channelAndHourHabits, settingHabits, askHabits, exchangesIn, exchangeEvidence, WORKING_FIELDS, PROFILE_FIELDS, type ConvoMessage, type Setting, type ProfileField, type DropReason, type RawEvidence, type ProfileEvidence, type WorkingStyle } from "@/lib/contacts/profile-evidence";
import { checkClaims } from "@/lib/contacts/profile-check";
import { readFeedback, recordRun } from "@/lib/contacts/profile-feedback";
import { editRatio, verdictsFor } from "@/lib/contacts/profile-quality";
import { searchEmails, getRecentEmails, getEmailBody, getThreadState, type ThreadState } from "@/lib/google/gmail";
import { getSelfIdentity } from "@/lib/self-identity";
import { getSettings } from "@/lib/settings/store";
import { getOverrideFromStore } from "@/lib/contacts/overrides-store";
import { assertProfilingAllowed } from "@/lib/privacy/store";
import { listUserContacts } from "@/lib/contacts/user-store";
import { interactionsWith, baselineInteractions } from "@/lib/contacts/sentiment";
import { baselineOf, recentSignals, describeSignals } from "@/lib/contacts/relationship-signals";
import { buildProfilePrompt, habitLines, personMatcher, signalCount as countSignal } from "@/lib/contacts/profile-prompt";
import {
  getRecentSlackMessages,
  searchSlackMessages,
  getUserProfile,
} from "@/lib/slack/client";
import { getZoomSummaries, filterByAttendees } from "@/lib/google/zoom-summaries";
import { getWhatsAppSignalForContact } from "@/lib/whatsapp/dump-job";
import { getStoredPipedriveSnapshot } from "@/lib/pipedrive/client";
import { meetingHistoryWith } from "@/lib/meetings/history-store";
import { getPeopleIndexSafe } from "@/lib/people/directory-store";
import { findPerson, fullNameKey, normEmail } from "@/lib/people/directory";
import { spokenBy } from "@/lib/meetings/history";
import { getUploadText } from "@/lib/uploads/store";
import { profileEvidence as pipedriveEvidence } from "@/lib/pipedrive/context";
import {
  getTeamsChatSignalForContact,
  getTeamsChannelSignalForContact,
  getTeamsMeetings,
  filterTeamsMeetingsByAttendees,
} from "@/lib/microsoft/teams";

// Given a contact (name + optional email + directory + optional free-text
// notes), pull every bit of signal we can reach and ask Basil to write the
// same personality fields the hand-authored seed contacts already have:
//   personality, whatMakesThemTick, watchOut, recentActivity, activitySource
//
// Since 2026-10-21 (docs/personality-profiles-review-2026-10-21.md):
//   - the window is 90 days, not this week (getRecentEmails defaulted to 2 days);
//   - the person's measured habits (reply time, length, who starts threads) go
//     in as facts, shared with the tone read;
//   - up to 8 direct emails from them go in IN FULL, not as snippets;
//   - the previous profile and everything the user has told Basil (ownerNotes)
//     go in too — regeneration revises, it does not restart;
//   - with tone & sentiment switched off in Settings, only the user's notes
//     are used: no message data is read.
//
// The directory matters:
//   - work contacts → Gmail + Slack + Zoom signal is rich
//   - personal contacts → usually zero Gmail/Slack signal; Basil leans on
//     the user's notes (and will honestly say "low signal" if neither exists)

/** The long window a profile is drawn from — the same one the tone read uses. */
const WINDOW_DAYS = 90;
/** Direct emails from the person fetched in full (one Gmail call each). */
const MAX_BODIES = 8;

export interface ContactProfileInput {
  /** The stored contact's id, when regenerating: brings in the previous profile and the user's notes. */
  contactId?: string;
  name: string;
  email?: string;
  phone?: string;
  directory?: "work" | "personal";
  /** Free-text Michael can paste in — how they met, what matters, history. */
  notes?: string;
}

/** What the route returns and the tool hands back: the profile plus how much it read. */
export type ContactProfileDraft = ContactProfileOutput & {
  /** Cited claims, the items they cite, and each field's strength (lib/contacts/profile-evidence). */
  evidence: ProfileEvidence;
  /** How to work with them (stored in the override layer). */
  workingStyle: WorkingStyle;
  signalCount: number;
  bodiesRead: number;
  generatedAt: string;
};

/** "Guy Saunders" from `Guy Saunders <guy@x.io>` on a message from that address. Exported for tests. */
export function fullNameFromHeaders(msgs: ReadonlyArray<{ from: string; fromEmail?: string }>, email: string): string | undefined {
  const addr = email.toLowerCase();
  for (const m of msgs) {
    if ((m.fromEmail ?? "").toLowerCase() !== addr) continue;
    const display = m.from.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim();
    if (display.split(/\s+/).length >= 2 && !display.includes("@")) return display;
  }
  return undefined;
}

/**
 * Throws SpendCapError / AIValidationError / Error as generateValidated does;
 * the caller decides how to report them.
 */
export async function generateContactProfile(username: string, body: ContactProfileInput): Promise<ContactProfileDraft> {
  const { name, email, notes } = body;
  const directory = body.directory ?? "work";
  if (!name || !name.trim()) throw new Error("name is required");

  const nameLower = name.toLowerCase();
  const nameFirst = name.split(" ")[0];

  const [identity, settings, contacts] = await Promise.all([
    getSelfIdentity(username),
    getSettings(username),
    listUserContacts(username).catch(() => []),
  ]);
  const selfFirstRaw = identity.names[0]?.split(/\s+/)[0] ?? "";
  const selfFirst = selfFirstRaw ? selfFirstRaw[0].toUpperCase() + selfFirstRaw.slice(1) : "the user";
  // The stored record (if any) carries the previous profile and the user's notes.
  // Ask Basil's tool knows only the name, so resolve the id when it is not given.
  const stored = body.contactId
    ? contacts.find((c) => c.id === body.contactId)
    : contacts.find((c) => c.name.toLowerCase() === nameLower || (!!email && c.email?.toLowerCase() === email.toLowerCase()));
  const contactId = body.contactId ?? stored?.id;
  // The same person everywhere (lib/people): every address, Slack ID and
  // Pipedrive record they have, not just the one on the contact card.
  const peopleIx = await getPeopleIndexSafe(username);
  const person = (contactId ? peopleIx.people.find((p) => p.contactId === contactId) : undefined)
    ?? findPerson(peopleIx, email) ?? findPerson(peopleIx, name) ?? null;
  const personEmails = [...new Set([email, ...(person?.emails ?? [])].map((e) => normEmail(e)).filter((e): e is string => !!e))];
  // People profiles off, or this person excluded (lib/privacy): no profile.
  await assertProfilingAllowed(username, contactId);
  const override = contactId ? await getOverrideFromStore(username, contactId).catch(() => undefined) : undefined;
  const prior = {
    personality: override?.personality ?? stored?.personality,
    whatMakesThemTick: override?.whatMakesThemTick ?? stored?.whatMakesThemTick,
    watchOut: override?.watchOut ?? stored?.watchOut,
    generatedAt: override?.generatedAt ?? stored?.generatedAt,
  };
  const ownerNotes = override?.ownerNotes;
  // What the user confirmed or rejected on earlier drafts (recommendation 8).
  const feedback = contactId ? await readFeedback(username).catch(() => null) : null; // ci-ok: no feedback store → no corrections carried
  const judged = feedback && contactId ? verdictsFor(feedback, contactId) : { confirmed: [], rejected: [] };

  // Only hit Gmail/Slack/Zoom when the directory is "work" OR when we have an
  // email (which implies they might appear in inbox), and only while tone &
  // sentiment is on — that switch governs every read of message data.
  const readMessages = settings.toneSentiment !== false;
  const shouldPullWorkSignal = readMessages && (directory === "work" || !!email);

  const [emailsAll, slackRecent, slackSearched, zoomAll, whatsappLines, teamsChatLines, teamsChannelLines, teamsAllMeetings] = await Promise.all([
    shouldPullWorkSignal
      ? getRecentEmails(username, 400, WINDOW_DAYS).catch(() => [])
      : Promise.resolve([]),
    shouldPullWorkSignal
      // Same (limit, days) as the tone read, so the Slack client serves it from cache.
      ? getRecentSlackMessages(username, 2500, WINDOW_DAYS).catch(() => [])
      : Promise.resolve([]),
    shouldPullWorkSignal
      ? searchSlackMessages(username, name, 20).catch(() => [])
      : Promise.resolve([]),
    shouldPullWorkSignal
      ? getZoomSummaries(username, WINDOW_DAYS).catch(() => [])
      : Promise.resolve([]),
    // WhatsApp signal is available for any contact regardless of directory.
    readMessages ? getWhatsAppSignalForContact(username, name, body.phone, 40).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    // Teams chat messages — work contacts only
    shouldPullWorkSignal
      ? getTeamsChatSignalForContact(username, name, 30).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
    shouldPullWorkSignal
      ? getTeamsChannelSignalForContact(username, name, 20).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
    shouldPullWorkSignal
      ? getTeamsMeetings(username, 30).catch(() => [])
      : Promise.resolve([]),
  ]);

  // Whole words and exact addresses only (see personMatcher). An auto-added
  // contact is often just "guy": take the full name from their own From header.
  const personFull = person?.names.find((n) => fullNameKey(n));
  const fullName = name.trim().includes(" ") ? name.trim() : (personFull ?? (email ? fullNameFromHeaders(emailsAll, email) : undefined) ?? name.trim());
  const who = personMatcher(fullName, email);
  const fromThem = (e: { from: string; fromEmail?: string }) => who.sentEmail(e) || personEmails.includes(normEmail(e.fromEmail) ?? "");
  const emailSignal = emailsAll.filter(fromThem);

  // Also a targeted Gmail search by name / email — catches things outside the
  // recent window that still matter. A year back (it stopped at 30 days until
  // 2026-11-24, so a quiet relationship had no email evidence at all).
  const targetedEmails = shouldPullWorkSignal
    ? await searchEmails(username, personEmails.length ? personEmails.slice(0, 4).map((a) => `from:${a} OR to:${a}`).join(" OR ") : name, 15, 365).catch(
        () => []
      )
    : [];

  const emailsById = new Map<string, (typeof emailSignal)[number]>();
  for (const e of [...emailSignal, ...targetedEmails]) {
    if (!emailsById.has(e.id)) emailsById.set(e.id, e);
  }
  const emails = [...emailsById.values()]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 30);

  // Their direct, non-bulk emails in full: where writing style actually shows.
  // Each with its thread (recommendation 3): what they were answering, and
  // what happened next — a reply means little without the message it answers.
  const direct = emails.filter((e) => !e.bulk && fromThem(e)).slice(0, MAX_BODIES);
  const emailBodies = (await Promise.all(direct.map(async (e) => {
    try {
      const [b, thread] = await Promise.all([getEmailBody(username, e.id), getThreadState(username, e.id).catch(() => null)]); // ci-ok: no thread → the email alone
      return { id: e.id, date: b.date || e.date, subject: b.subject || e.subject, body: b.body, setting: emailSetting(e), thread };
    }
    catch { return null; }
  }))).filter((b): b is NonNullable<typeof b> => !!b && b.body.trim().length > 0);

  // Slack identity: their user id from their email (users.lookupByEmail), so
  // "written by them" is decided by who posted, not by a display name.
  const slackIds = new Set(person?.slackIds ?? []);
  const lookedUp = shouldPullWorkSignal && email && slackIds.size === 0 ? (await getUserProfile(username, email).catch(() => null))?.id : undefined; // ci-ok: no Slack identity → display-name matching
  if (lookedUp) slackIds.add(lookedUp);
  const slackAuthored = (m: { author: string; authorId?: string }) =>
    slackIds.size && m.authorId ? slackIds.has(m.authorId) : who.authored(m.author);

  // Merge recent Slack + targeted search, dedup by id. Kept: what they wrote,
  // what was said in a 1:1 DM with them (both sides), and messages naming them
  // in full. A bare first name inside someone else's text is not them.
  const slackById = new Map<string, (typeof slackRecent)[number]>();
  for (const m of [...slackRecent, ...slackSearched]) {
    const dmWithThem = m.channelMembers?.length === 1 && m.channelMembers[0] === nameFirst.toLowerCase();
    if (!(slackAuthored(m) || dmWithThem || who.mentions(m.text))) continue;
    if (!slackById.has(m.id)) slackById.set(m.id, m);
  }
  const slackMsgs = [...slackById.values()]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 30);

  // Measured habits — the same computation the tone read uses.
  const contactLike = { id: contactId ?? name, name, email };
  const sources = { slack: slackRecent, emails: emailsAll };
  const long = baselineInteractions(contactLike, sources, identity.names);
  const baseline = baselineOf(long);
  const recent = recentSignals(interactionsWith(contactLike, sources, identity.names), baseline);
  const facts = describeSignals(baseline, recent);

  // Zoom summaries naming the person in full (AI summaries: context, never style).
  const zoom = shouldPullWorkSignal
    ? filterByAttendees(zoomAll, [name]).filter((z) => who.mentions(`${z.title} ${z.body}`) || who.authored(z.title)).slice(0, 4)
    : [];

  // Teams meetings with the person (from Outlook Calendar — no extra scope needed)
  const teamsMeetings = shouldPullWorkSignal
    ? filterTeamsMeetingsByAttendees(teamsAllMeetings, [name]).slice(0, 4)
    : [];

  // ── Numbered evidence: who wrote each item decides what it may support ──
  const bodyIds = new Set(emailBodies.map((b) => b.id));
  const speakerLine = (channel: string) => (line: string): RawEvidence => {
    const m = /^\[(\d{4}-\d{2}-\d{2})[^\]]*\]\s*([^:]{1,80}):\s*([\s\S]*)$/.exec(line.trim());
    if (!m) return { channel, by: "others", text: clip(line, 600) };
    const speaker = m[2].trim();
    const mine = speaker.toLowerCase() === username.toLowerCase() || identity.names.some((n) => n.toLowerCase() === speaker.toLowerCase());
    return { channel, by: !mine && (who.authored(speaker) || speaker === "Them") ? "them" : "others", date: m[1], text: clip(`${speaker}: ${m[3]}`, 600) };
  };
  // One-to-one Slack conversations with them, both sides, oldest first.
  const dmConvos = new Map<string, ConvoMessage[]>();
  for (const m of slackRecent) {
    const dmWithThem = m.channelMembers?.length === 1 && m.channelMembers[0] === nameFirst.toLowerCase();
    if (!dmWithThem || !m.channelId) continue;
    const list = dmConvos.get(m.channelId) ?? [];
    list.push({ fromUser: !!m.fromSelf, fromThem: !m.fromSelf && slackAuthored(m), at: m.date, text: m.text });
    dmConvos.set(m.channelId, list);
  }
  const exchanges = [...dmConvos.values()].flatMap((c) => exchangesIn(c));
  const slackSetting = (m: { channelMembers?: string[] }): Setting => (m.channelMembers?.length === 1 ? "1:1" : "group");

  // Pipedrive: their deals, notes and meetings — account context, never style.
  const crm = directory === "work"
    ? await getStoredPipedriveSnapshot(username)
        .then((snap) => {
          const ev = snap ? pipedriveEvidence(snap, { emails: personEmails, names: [fullName], personIds: person?.pipedrivePersonIds ?? [] }) : [];
          return Array.isArray(ev) ? ev : [];
        })
        .catch((e) => { console.warn("[contact-profile] Pipedrive unreadable:", e instanceof Error ? e.message : e); return []; })
    : [];

  // Meetings with them, kept for good (lib/meetings/history) — and, where a
  // transcript has speaker labels (Read AI, Plaud, recordings), their own words.
  const pastMeetingsRaw = directory === "work"
    ? await meetingHistoryWith(username, { names: [...new Set([fullName, ...(person?.names ?? []).filter((n) => fullNameKey(n))])], emails: personEmails }, 8)
        .catch((e) => { console.warn("[contact-profile] meeting history unreadable:", e instanceof Error ? e.message : e); return []; })
    : [];
  const pastMeetings = Array.isArray(pastMeetingsRaw) ? pastMeetingsRaw : [];
  const meetingEvidence: RawEvidence[] = pastMeetings.map((m) => ({
    channel: "meeting", by: "others" as const, setting: "meeting" as const, date: isoDay(m.date), title: m.title,
    text: `Meeting "${m.title}" (${m.source}): ${clip(m.summary, 700)}${m.decisions.length ? ` Decided: ${m.decisions.slice(0, 3).join("; ")}.` : ""}`,
  }));
  const spoken: RawEvidence[] = [];
  for (const m of pastMeetings.filter((x) => x.id.startsWith("upload:")).slice(0, 4)) {
    const t = await getUploadText(username, m.id.slice("upload:".length)).catch(() => ({ segments: undefined })); // ci-ok: no transcript → no spoken lines
    const lines = spokenBy(Array.isArray(t?.segments) ? t.segments : [], fullName, 5);
    for (const line of Array.isArray(lines) ? lines : []) {
      spoken.push({ channel: "meeting", by: "them", setting: "meeting", date: isoDay(m.date), title: m.title, text: `${fullName} said in "${m.title}": "${line}"` });
    }
  }

  const raw: RawEvidence[] = [
    ...crm,
    ...meetingEvidence,
    ...spoken.slice(0, 15),
    ...emailBodies.map((b) => ({ channel: "email", by: "them" as const, setting: b.setting, date: isoDay(b.date), title: b.subject, text: withThread(b, selfFirst) })),
    ...emails.filter((e) => !bodyIds.has(e.id)).slice(0, 22).map((e) => ({
      channel: "email",
      by: fromThem(e) ? "them" as const : "others" as const,
      setting: emailSetting(e),
      date: isoDay(e.date),
      title: e.subject,
      text: `Email from ${e.from}: "${e.subject}" — ${e.snippet}`,
    })),
    ...slackMsgs.map((m) => ({ channel: "slack", by: slackAuthored(m) ? "them" as const : "others" as const, setting: slackSetting(m), date: isoDay(m.date), title: m.channel, text: `${m.author} in ${m.channel}: ${clip(m.text, 600)}` })),
    // Your asks in DMs, each with what they did next (newest 12).
    ...exchanges.slice(-12).map((x) => exchangeEvidence(x, "slack", selfFirst, fullName)),
    ...zoom.map((z) => ({ channel: "zoom", by: "others" as const, setting: "meeting" as const, date: isoDay(z.date), title: z.title, text: `Zoom AI summary "${z.title}": ${clip(z.body, 1200)}` })),
    ...whatsappLines.map(speakerLine("whatsapp")),
    ...[...teamsChatLines, ...teamsChannelLines].slice(0, 30).map(speakerLine("teams")),
    ...teamsMeetings.map((m) => ({ channel: "meeting", by: "others" as const, setting: "meeting" as const, date: isoDay(m.date), title: m.title, text: `Teams meeting "${m.title}": ${clip(m.body, 800)}` })),
  ];
  // Their own messages, setting by setting (recommendation 6).
  const theirMessages = [
    ...emails.filter((e) => !e.bulk && fromThem(e)).map((e) => ({ setting: emailSetting(e), text: e.snippet })),
    ...slackRecent.filter((m) => slackAuthored(m)).map((m) => ({ setting: slackSetting(m), text: m.text })),
  ];

  // Where and when they write — measured from their own messages' timestamps.
  const theirTimes = [
    ...emailsAll.filter((e) => !e.bulk && fromThem(e)).map((e) => ({ channel: "email", at: e.date })),
    ...slackRecent.filter((m) => slackAuthored(m)).map((m) => ({ channel: "slack", at: m.date })),
  ];
  const items = numberEvidence({
    notes: [
      ownerNotes?.trim() ?? "",
      notes?.trim() ?? "",
      ...judged.confirmed.map((c) => `${selfFirst} confirmed this earlier: "${c}"`),
    ].filter(Boolean),
    habits: [
      ...habitLines(baseline, facts),
      ...channelAndHourHabits(theirTimes, settings.timezone || "Europe/London"),
      ...settingHabits(theirMessages),
      ...askHabits(exchanges),
    ],
    messages: raw,
  });
  const signalCount = countSignal(items);

  const promptText = buildProfilePrompt({ name: fullName, email, phone: body.phone, directory, selfFirst, prior, items, rejected: judged.rejected });

  const parsed = await generateValidated({
    kind: "object",
    schema: ContactProfileClaimsSchema,
    schemaName: "ContactProfile",
    // No explicit model: the tier's primary, then the other provider (an
    // explicit one would retry the same, out-of-credit provider first).
    maxOutputTokens: MAX_TOKENS.default,
    // Background work: the task prompt (ground rules, data-not-instructions,
    // memories about this person), not the ~15k-token chat prompt with its
    // tool manuals, which a profile never uses.
    system: await getTaskSystemPrompt(username, undefined, { memories: 8, focus: { text: fullName, entities: [fullName] }, glossaryFor: promptText.slice(0, 6_000) }),
    prompt: promptText,
    tag: "contact-profile",
    meter: { username, feature: "contact-profile" },
    meterKind: "default",
    ...(PROVIDER_MODE === "vercel_gateway" && {
      providerOptions: { gateway: { tags: ["feature:contact-profile", "env:production"] } },
    }),
  });
  // The second check: each claim re-read against only its own sources, by the
  // fast tier, without the draft in view. Fails open (null → nothing removed).
  const checks = await checkClaims(username, citedClaims(parsed, items));
  // Citations checked, fields scored, prose written — in code, not by the model.
  const done = finalizeClaims(parsed, items, checks);
  const { personality, whatMakesThemTick, watchOut, recentActivity, ...rest } = done.text;
  const workingStyle: WorkingStyle = Object.fromEntries(WORKING_FIELDS.map((f) => [f, rest[f]]));

  // Grade the run: what the checks removed, and how much the user had edited
  // the last draft before asking for this one.
  if (contactId) {
    const lastClaims = override?.profileEvidence?.claims;
    const keptText: Partial<Record<ProfileField, string | undefined>> = {
      personality: override?.personality ?? stored?.personality,
      whatMakesThemTick: override?.whatMakesThemTick ?? stored?.whatMakesThemTick,
      watchOut: override?.watchOut ?? stored?.watchOut,
      recentActivity: override?.recentActivity ?? stored?.recentActivity,
      ...override?.workingStyle,
    };
    const edits: Partial<Record<ProfileField, number>> = {};
    for (const f of PROFILE_FIELDS) {
      const written = (lastClaims?.[f] ?? []).map((c) => c.text).join(f === "recentActivity" ? "\n" : " ");
      if (written && keptText[f]) edits[f] = editRatio(written, keptText[f]!);
    }
    const dropped: Partial<Record<DropReason, number>> = {};
    for (const d of done.evidence.dropped) dropped[d.why] = (dropped[d.why] ?? 0) + 1;
    await recordRun(username, {
      contactId,
      kept: PROFILE_FIELDS.reduce((n, f) => n + done.evidence.claims[f].length, 0),
      dropped,
      checked: done.evidence.checked !== false,
      ...(Object.keys(edits).length ? { edits } : {}),
    }).catch((e) => console.warn("[contact-profile] could not log the run:", e instanceof Error ? e.message : e));
  }
  return {
    personality, whatMakesThemTick, watchOut, recentActivity,
    workingStyle,
    activitySource: done.activitySource,
    ...(parsed.changes ? { changes: parsed.changes } : {}),
    ...(parsed.summary ? { summary: parsed.summary } : {}),
    ...(parsed.canonicalFields ? { canonicalFields: parsed.canonicalFields } : {}),
    evidence: done.evidence,
    signalCount,
    bodiesRead: emailBodies.length,
    generatedAt: new Date().toISOString(),
  };
}

/** One-to-one when it went to the user alone; group when others were on it. */
function emailSetting(e: { to?: string; cc?: string }): Setting {
  const n = [e.to ?? "", e.cc ?? ""].join(",").split(",").map((x) => x.trim()).filter((x) => x.includes("@")).length;
  return n <= 1 ? "1:1" : "group";
}

/** Their email in full, with what it answered and what happened next in the thread. */
function withThread(b: { date: string; subject: string; body: string; thread: ThreadState | null }, selfFirst: string): string {
  const before = b.thread?.earlier?.[b.thread.earlier.length - 1];
  const after = b.thread?.later?.[0];
  const head = before
    ? `Answering ${before.sent ? `${selfFirst}'s` : `${before.fromName || before.fromEmail}'s`} email of ${isoDay(before.date) ?? "earlier"}: "${clip(before.snippet, 240)}"\n`
    : "";
  const tail = after ? `\nNext in the thread: ${after.sent ? selfFirst : after.fromName || after.fromEmail}, ${isoDay(after.date) ?? "later"}: "${clip(after.snippet, 160)}"` : "";
  return `${head}Email "${b.subject}" (in full):\n${clip(b.body, 1800)}${tail}`;
}

const isoDay = (d: string) => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined; };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
