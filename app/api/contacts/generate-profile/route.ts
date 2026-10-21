export const maxDuration = 300;

import { getTextModel, MAX_TOKENS, PROVIDER_MODE } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { generateValidated, AIValidationError, aiValidationErrorResponse } from "@/lib/ai/generate-validated";
import { SpendCapError, spendCapResponse } from "@/lib/ai/spend-guard";
import { ContactProfileSchema } from "@/lib/ai/schemas";
import { searchEmails, getRecentEmails, getEmailBody } from "@/lib/google/gmail";
import { getSelfIdentity } from "@/lib/self-identity";
import { getSettings } from "@/lib/settings/store";
import { getOverrideFromStore } from "@/lib/contacts/overrides-store";
import { listUserContacts } from "@/lib/contacts/user-store";
import { interactionsWith, baselineInteractions } from "@/lib/contacts/sentiment";
import { baselineOf, recentSignals, describeSignals } from "@/lib/contacts/relationship-signals";
import { buildProfilePrompt, signalCount as countSignal } from "@/lib/contacts/profile-prompt";
import {
  getRecentSlackMessages,
  searchSlackMessages,
} from "@/lib/slack/client";
import { getZoomSummaries, filterByAttendees } from "@/lib/google/zoom-summaries";
import { getWhatsAppSignalForContact } from "@/lib/whatsapp/dump-job";
import {
  getTeamsChatSignalForContact,
  getTeamsChannelSignalForContact,
  getTeamsMeetings,
  filterTeamsMeetingsByAttendees,
} from "@/lib/microsoft/teams";
import { getSessionUser } from "@/lib/auth";

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

interface ReqBody {
  /** The stored contact's id, when regenerating: brings in the previous profile and the user's notes. */
  contactId?: string;
  name: string;
  email?: string;
  phone?: string;
  directory?: "work" | "personal";
  /** Free-text Michael can paste in — how they met, what matters, history. */
  notes?: string;
}

export async function POST(req: Request) {
  const username = (await getSessionUser());
  if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { name, email, notes } = body;
  const directory = body.directory ?? "work";
  if (!name || !name.trim()) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

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
  const override = contactId ? await getOverrideFromStore(username, contactId).catch(() => undefined) : undefined;
  const prior = {
    personality: override?.personality ?? stored?.personality,
    whatMakesThemTick: override?.whatMakesThemTick ?? stored?.whatMakesThemTick,
    watchOut: override?.watchOut ?? stored?.watchOut,
    generatedAt: override?.generatedAt ?? stored?.generatedAt,
  };
  const ownerNotes = override?.ownerNotes;

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

  // Filter emails: match sender/recipient against name or email
  const emailSignal = emailsAll.filter((e) => {
    const fromLower = e.from.toLowerCase();
    if (email && fromLower.includes(email.toLowerCase())) return true;
    return (
      fromLower.includes(nameLower) ||
      (nameFirst.length >= 3 && fromLower.includes(nameFirst.toLowerCase()))
    );
  });

  // Also a targeted Gmail search by name / email — catches things outside the
  // recent window that still matter.
  const targetedEmails = shouldPullWorkSignal
    ? await searchEmails(username, email ? `from:${email} OR to:${email}` : name, 15).catch(
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
  const direct = emails.filter((e) => !e.bulk && ((email && e.fromEmail?.toLowerCase() === email.toLowerCase()) || e.from.toLowerCase().includes(nameLower))).slice(0, MAX_BODIES);
  const emailBodies = (await Promise.all(direct.map(async (e) => {
    try { const b = await getEmailBody(username, e.id); return { date: b.date || e.date, subject: b.subject || e.subject, body: b.body }; }
    catch { return null; }
  }))).filter((b): b is { date: string; subject: string; body: string } => !!b && b.body.trim().length > 0);

  // Merge recent Slack + targeted search, dedup by id, filter against name
  const slackById = new Map<string, (typeof slackRecent)[number]>();
  for (const m of [...slackRecent, ...slackSearched]) {
    const authorLower = m.author.toLowerCase();
    const textLower = m.text.toLowerCase();
    const hit =
      authorLower.includes(nameLower) ||
      (nameFirst.length >= 3 &&
        (authorLower.includes(nameFirst.toLowerCase()) ||
          textLower.includes(nameFirst.toLowerCase())));
    if (!hit) continue;
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

  // Zoom summaries mentioning the person
  const zoom = shouldPullWorkSignal
    ? filterByAttendees(zoomAll, [name]).slice(0, 4)
    : [];

  // Teams meetings with the person (from Outlook Calendar — no extra scope needed)
  const teamsMeetings = shouldPullWorkSignal
    ? filterTeamsMeetingsByAttendees(teamsAllMeetings, [name]).slice(0, 4)
    : [];

  // Teams chat + channel messages for the person
  const teamsLines = [...teamsChatLines, ...teamsChannelLines].slice(0, 30);

  const evidence = {
    emailLines: emails.map((e) => `- [${e.date}] From ${e.from}: "${e.subject}" — ${e.snippet}`),
    emailBodies,
    slackLines: slackMsgs.map((m) => `- [${m.date}] ${m.author} in ${m.channel}: ${m.text}`),
    zoomBlocks: zoom.map((z) => `- [${z.date}] (${z.source}) ${z.title}\n${z.body}`),
    whatsappLines,
    teamsLines,
    teamsMeetingBlocks: teamsMeetings.map((m) => `- [${m.date}] (teams) ${m.title}\n${m.body}`),
  };
  const signalCount = countSignal(evidence);

  const promptText = buildProfilePrompt({
    name, email, phone: body.phone, directory, selfFirst, notes, ownerNotes, prior, baseline, recent, facts, evidence,
  });

  try {
    const parsed = await generateValidated({
      kind: "object",
      schema: ContactProfileSchema,
      schemaName: "ContactProfile",
      model: getTextModel(),
      maxOutputTokens: MAX_TOKENS.default,
      system: await getSystemPrompt(username),
      prompt: promptText,
      tag: "contact-profile",
      meter: { username, feature: "contact-profile" },
      meterKind: "default",
      ...(PROVIDER_MODE === "vercel_gateway" && {
        providerOptions: { gateway: { tags: ["feature:contact-profile", "env:production"] } },
      }),
    });
    return Response.json({
      ...parsed,
      signalCount,
      bodiesRead: emailBodies.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    if (e instanceof SpendCapError) {
      return spendCapResponse(e);
    }
    if (e instanceof AIValidationError) {
      return Response.json(aiValidationErrorResponse(e), { status: 422 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[generate-profile] failed:", msg);
    return Response.json(
      { error: "Contact profile generation failed" },
      { status: 500 }
    );
  }
}
