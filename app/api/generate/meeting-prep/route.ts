import { generateText, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { findContactByName, getPersonaSummary } from "@/lib/contacts-lookup";
import type { Contact } from "@/lib/contacts-data";
import { parseAIJson } from "@/lib/ai/parse-json";
import { getRecentEmails } from "@/lib/google/gmail";
import { getRecentSlackMessages, searchSlackMessages } from "@/lib/slack/client";
import { getTodayEvents } from "@/lib/google/calendar";
import { getZoomSummaries, filterByAttendees } from "@/lib/google/zoom-summaries";
import { stripSelf } from "@/lib/self-identity";
import {
  parseExtraContext,
  formatExtraContextBlock,
  type ExtraContext,
} from "@/lib/ai/extra-context";

export async function POST(req: Request) {
  // Two ingress shapes:
  //  - JSON body (back-compat for anything still calling without extras)
  //  - multipart/form-data (new — includes free-text notes + file uploads)
  const contentType = req.headers.get("content-type") || "";

  let title: string;
  let attendees: string[];
  let date: string;
  let time: string;
  let userContacts: Contact[] = [];
  let extra: ExtraContext = {
    notes: "",
    textBlock: "",
    fileParts: [],
    skipped: [],
    summary: "no extra context",
  };

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    // Core meeting fields come through as a single JSON blob under "meeting"
    try {
      const meta = JSON.parse((form.get("meeting") as string) || "{}");
      title = meta.title;
      attendees = meta.attendees || [];
      date = meta.date;
      time = meta.time;
      userContacts = Array.isArray(meta.userContacts) ? meta.userContacts : [];
    } catch {
      return Response.json({ error: "Invalid meeting payload" }, { status: 400 });
    }
    try {
      extra = await parseExtraContext(form);
    } catch (e) {
      console.error("Failed to parse extra context:", e);
    }
  } else {
    const body = await req.json();
    title = body.title;
    attendees = body.attendees || [];
    date = body.date;
    time = body.time;
    userContacts = Array.isArray(body.userContacts) ? body.userContacts : [];
  }

  // Michael isn't an attendee of his own meeting — strip him everywhere.
  const attendeeNames = stripSelf(attendees as string[]);
  const attendeeNamesLower = attendeeNames.map((n: string) => n.toLowerCase());

  const attendeeProfiles = attendeeNames
    .map((name: string) => {
      const contact = findContactByName(name, userContacts);
      return contact ? getPersonaSummary(contact) : `${name} — no profile on file`;
    })
    .join("\n\n");

  // Fetch emails + Slack (recent + targeted search) + today's calendar + Zoom
  // summaries in parallel. Targeted search is critical — relying only on the
  // last 60 recent messages buries any conversation older than a day or two.
  const [emails, slackMessages, todaysCal, zoomSummariesAll, perAttendeeSlack] = await Promise.all([
    getRecentEmails(30).catch((err) => {
      console.error("Failed to fetch emails for meeting prep:", err);
      return [];
    }),
    getRecentSlackMessages(60).catch((err) => {
      console.error("Failed to fetch Slack messages for meeting prep:", err);
      return [];
    }),
    getTodayEvents().catch((err) => {
      console.error("Failed to fetch today's calendar:", err);
      return [];
    }),
    getZoomSummaries(14).catch((err) => {
      console.error("Failed to fetch Zoom summaries:", err);
      return [];
    }),
    // Actively SEARCH Slack for each attendee — DMs, mentions, channel posts —
    // so we capture conversations older than the 60-message recent window.
    Promise.all(
      attendeeNames.map((name: string) =>
        searchSlackMessages(name, 15).catch((err) => {
          console.error(`Slack search failed for ${name}:`, err);
          return [];
        })
      )
    ),
  ]);

  // Filter emails where the sender name matches any attendee
  const relevantEmails = emails.filter((email) => {
    const fromLower = email.from.toLowerCase();
    return attendeeNamesLower.some(
      (name) =>
        fromLower.includes(name) ||
        name.split(" ").some((part) => part.length > 2 && fromLower.includes(part))
    );
  });

  // Merge recent-feed filter + targeted search. Dedupe by message id.
  const recentSlackFiltered = slackMessages.filter((msg) => {
    const authorLower = msg.author.toLowerCase();
    const textLower = msg.text.toLowerCase();
    return attendeeNamesLower.some(
      (name) =>
        authorLower.includes(name) ||
        name.split(" ").some((part) => part.length > 2 && (authorLower.includes(part) || textLower.includes(part)))
    );
  });
  const searchedSlack = perAttendeeSlack.flat();
  const slackById = new Map<string, (typeof searchedSlack)[number]>();
  for (const m of [...recentSlackFiltered, ...searchedSlack]) {
    if (!slackById.has(m.id)) slackById.set(m.id, m);
  }
  const relevantSlack = [...slackById.values()].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  // Zoom summaries mentioning any attendee — these capture what was said on
  // prior calls that don't show up in email or Slack text.
  const relevantZoom = filterByAttendees(zoomSummariesAll, attendeeNames);

  // Today's *other* events that already happened before this meeting — the
  // "From Today's Calls" amber card pulls from here. Carry-in context from
  // earlier calls is what makes meeting prep feel like a real chief-of-staff note.
  const meetingStart = time && /^\d{2}:\d{2}/.test(time)
    ? `${date}T${time.slice(0, 5)}:00`
    : null;
  const earlierTodayEvents = todaysCal.filter((e) => {
    if (!meetingStart) return true;
    // Exclude the current meeting itself + events later in the day
    if (e.summary === title) return false;
    return (e.start || "") < meetingStart;
  });

  // Grab any Slack/email from the last 8 hours — this is the ambient carry-in
  // signal that didn't involve the current meeting's attendees but still matters.
  const eightHoursAgo = Date.now() - 8 * 60 * 60 * 1000;
  const recentEmailsAnyAttendee = emails
    .filter((e) => new Date(e.date).getTime() > eightHoursAgo)
    .slice(0, 15);
  const recentSlackAnyAttendee = slackMessages
    .filter((m) => new Date(m.date).getTime() > eightHoursAgo)
    .slice(0, 25);

  // Format email context
  const emailContext = relevantEmails.length > 0
    ? relevantEmails
        .slice(0, 10)
        .map((e) => `- [${e.date}] From ${e.from}: "${e.subject}" — ${e.snippet}`)
        .join("\n")
    : null;

  // Format Slack context
  const slackContext = relevantSlack.length > 0
    ? relevantSlack
        .slice(0, 15)
        .map((m) => `- [${m.date}] ${m.author} in ${m.channel}: ${m.text}`)
        .join("\n")
    : null;

  const earlierTodayBlock = earlierTodayEvents.length > 0
    ? earlierTodayEvents
        .map((e) => {
          const start = e.start ? new Date(e.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "";
          const att = e.attendees?.length ? ` [with ${e.attendees.join(", ")}]` : "";
          return `- ${start} ${e.summary}${att}`;
        })
        .join("\n")
    : "No earlier meetings today.";

  const carryInEmailBlock = recentEmailsAnyAttendee.length > 0
    ? recentEmailsAnyAttendee
        .map((e) => `- [${e.date}] From ${e.from}: "${e.subject}" — ${e.snippet}`)
        .join("\n")
    : "No recent email traffic in the last 8 hours.";

  const carryInSlackBlock = recentSlackAnyAttendee.length > 0
    ? recentSlackAnyAttendee
        .map((m) => `- [${m.date}] ${m.author} in ${m.channel}: ${m.text}`)
        .join("\n")
    : "No recent Slack traffic in the last 8 hours.";

  // Zoom summaries block — post-meeting AI Companion recaps Zoom sends via
  // email, plus any Drive docs titled with "Zoom". These capture what was
  // actually said on prior calls — often the only source of that signal.
  const zoomBlock = relevantZoom.length > 0
    ? relevantZoom
        .slice(0, 4)
        .map((z) => `- [${z.date}] (${z.source}) ${z.title}\n${z.body}${z.link ? `\n  link: ${z.link}` : ""}`)
        .join("\n\n")
    : "No Zoom AI Companion summaries or Zoom-titled Drive docs mention these attendees in the last 14 days.";

  const totalSignal = relevantEmails.length + relevantSlack.length + relevantZoom.length;
  const extraBlock = formatExtraContextBlock(extra);

  const promptText = `Generate a meeting prep cheatsheet for Michael — sharp, opinionated, the kind of note a great chief of staff slides across before he walks in. Match the depth of a senior exec's handwritten pre-meeting notes.

Meeting: ${title}
Date/Time: ${date} at ${time} UK
Attendees:
${attendeeProfiles}

## EARLIER TODAY — MICHAEL'S OWN CALENDAR (all events that already happened today before this one)
${earlierTodayBlock}

## CARRY-IN EMAIL (last 8 hours, any sender — signal that may bleed into this meeting)
${carryInEmailBlock}

## CARRY-IN SLACK (last 8 hours, any channel — signal that may bleed into this meeting)
${carryInSlackBlock}

## RECENT EMAIL WITH ATTENDEES (filtered to this meeting's people)
${emailContext || "No recent emails found with these attendees."}

## RECENT SLACK WITH ATTENDEES (filtered + actively searched — DMs, mentions, channel posts for each attendee)
${slackContext || "No recent Slack activity found with these attendees."}

## ZOOM SUMMARIES WITH ATTENDEES (AI Companion post-meeting recaps + Drive docs titled 'Zoom', last 14 days)
${zoomBlock}
${extraBlock ? `\n${extraBlock}` : ""}
## SIGNAL DENSITY — ${totalSignal} relevant item(s) found across email, Slack, and Zoom${extraBlock ? ", plus extra context Michael attached" : ""}.
${totalSignal < 3 && !extraBlock ? "⚠️ LOW SIGNAL: You have very little hard evidence for this meeting. Keep topicsToRaise SHORT (1–3 entries) and generic-but-honest. Do NOT manufacture topics to fill space. Watch Outs may say 'Low carry-in signal — go in open-minded.'" : ""}

## How Basil writes meeting prep — match this shape precisely

**fromTodaysCalls** — 0-3 entries. Each is a named reference to a meeting earlier today (from EARLIER TODAY above) where something relevant to THIS meeting happened. Title is "Name — TIME call" or "Name — TIME call & [one-line tag]". Summary is 2-4 sentences of concrete what-happened-and-why-it-matters-now, stitched from the CARRY-IN blocks. Examples of the style:
  - Title: "Olivia — 13:00 call" | Summary: "Call happened (Michael sent the colour) Zoom link live, Slack at 12:50 — no written note to team that paint was picked — bring gently, expect 'I knew' response."
  - Title: "Crystal — 15:00 call & Zoom issue" | Summary: "Crystal messaged at 12:25 saying she couldn't join — the calendar invite had the wrong Zoom link. Michael regenerated and sent. If call didn't happen, flag status before TG Leadership."
  Only include entries where CARRY-IN email/Slack contains concrete evidence. Empty array is correct if nothing to carry in.

**attendeeInsights** — ONE entry per attendee. "style" is a 2-3 sentence **operating profile**, not tone advice. Describe: role, what they care about, how they operate, current context. Example:
  - name: "Ed Baum", role: "COO, TalentGenius", style: "Operationally focused, accountability-minded. Tracks vendor delivery and company-wide accountability. Currently 30 mins before a TG Leadership meeting — he'll be triaging what needs escalating there."
  Draw from persona background for operating style; never fabricate current activity.

**topicsToRaise** — 3-6 entries. This is the heart of the prep. Each is:
  - title: Short em-dash phrased heading. Examples: "AG build — brief Ed from your tease call", "AgentPowered outreach — what actually happened?", "Crystal's brand work — did the call happen?", "Anthropic partner programme", "Company casting — still unresolved"
  - context: **3-5 sentences of meaty detail**. Name specific people, dates, Slack/email references, unresolved questions. Don't be vague. Cross-reference sources. Say what's at stake. Example style: "Michael's shortfire was later (unclear should have started during PTO). Ed was on every GTM standup. Finish him (kit: Olivia send Tier 1 scripter? View templates finished? Any response?) You need a concrete answer for Malcolm in 30 minutes."
  - priority: **Free-form action label** — NOT an enum. Use phrases that capture the actual state: "Higher priority TG", "Watch during TG", "Respond today", "Verify before TG", "Responding", "Unblock before EOD", "Park for now". Pick the phrase that fits this topic's real urgency.

**thingsToLand** — 4-7 concrete outcomes Michael should walk out with. Each references something from topicsToRaise above. Use the downstream-meeting framing if relevant (e.g., "...before TG Leadership", "...before Malcolm weighs in"). Example entries: "Alignment narrative on AG build status to present to Malcolm", "Clear answer on outreach — what went well, to whom, what failed", "Confirm Crystal's brand status (or flag it's unknown)", "Got Ed's read on anything you've missed while on PTO".

**watchOuts** — 3-5 risks. Use **if/then framing** where it fits. Example entries: "Only 30 mins — stay focused. TG leadership immediately after — don't spill past.", "Ed may have a different read on AG blockers — be ready.", "If Crystal's call didn't happen, her status going in to TG Leadership is an awkward gap.", "If company casting gets deferred again, that's now three weeks — it'll surface elsewhere.".

## Factual guardrails — non-negotiable

Michael walks into meetings with what you write. Don't make him look ill-informed.

- fromTodaysCalls + topicsToRaise + thingsToLand + watchOuts: every specific claim traceable to a line in the CARRY-IN, RECENT, ZOOM SUMMARIES, or EXTRA CONTEXT blocks above, or to the EARLIER TODAY calendar. If you can't trace it, don't claim it.
- When Michael attached EXTRA CONTEXT (notes, files, a folder), treat it as FIRST-CLASS signal. Weave it into topicsToRaise and thingsToLand — reference by filename if relevant. Those attachments usually represent what Michael is actually thinking about going into the meeting.
- Zoom summaries are GOLD — they contain what was actually said on prior calls. When a topic traces to a Zoom summary, say so in the context field (e.g. "per Tuesday's Zoom summary, Ed committed to...") so Michael can audit.
- attendeeInsights.style draws on the persona background for the operating profile. That's appropriate — personas describe how people *operate*, which is exactly what this field captures. Never invent a current thread or belief.
- **LOW SIGNAL discipline**: if SIGNAL DENSITY above is low, produce a SHORTER prep. Fewer topics, each one honestly sourced from whatever signal DOES exist. An accurate 2-topic prep beats a fabricated 5-topic prep every time. When in doubt, say "no carry-in signal" in watchOuts — that's MORE useful to Michael than invented context.
- If a block says "No recent…" or "No Zoom…", do NOT invent claims scoped to that block. Say nothing, or flag the absence as a watch-out.
- Do NOT invent deal stages, prospect names, company names, pending decisions, or commitments.
- Empty arrays are acceptable. If earlier today was quiet, fromTodaysCalls: []. If no recent signal, topicsToRaise: []. Better a sparse prep than a fabricated one.

## Output shape

Return ONLY valid JSON, no markdown code fences:
{
  "fromTodaysCalls": [{"title": "...", "summary": "..."}],
  "attendeeInsights": [{"name": "...", "role": "...", "style": "..."}],
  "topicsToRaise": [{"title": "...", "context": "...", "priority": "free-form action label"}],
  "thingsToLand": ["..."],
  "watchOuts": ["..."]
}`;

  const messages: ModelMessage[] | undefined =
    extra.fileParts.length > 0
      ? [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              ...extra.fileParts.map((p) => ({
                type: "file" as const,
                data: p.data,
                mediaType: p.mediaType,
                filename: p.filename,
              })),
            ],
          },
        ]
      : undefined;

  const result = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: await getSystemPrompt(),
    ...(messages ? { messages } : { prompt: promptText }),
  });

  try {
    const parsed = parseAIJson<Record<string, unknown>>(result.text);
    return Response.json({
      ...parsed,
      generatedAt: new Date().toISOString(),
      extraContextSummary: extra.summary,
    });
  } catch {
    return Response.json({ error: "Failed to parse AI response", raw: result.text });
  }
}
