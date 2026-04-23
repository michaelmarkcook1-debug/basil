import { generateText, type ModelMessage } from "ai";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { findContactByName, getPersonaSummary } from "@/lib/contacts-lookup";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getAllOverridesFromStore } from "@/lib/contacts/overrides-store";
import type { Contact } from "@/lib/contacts-data";
import { parseAIJson } from "@/lib/ai/parse-json";
import { getRecentEmails } from "@/lib/google/gmail";

// ── Context window constants ───────────────────────────────────────────────────
/**
 * How far back to look for emails when building meeting prep.
 * 7 days ensures we catch agenda-setting threads from earlier in the week.
 * getRecentEmails(n, MEETING_PREP_EMAIL_DAYS) uses "newer_than:7d" Gmail query.
 */
const MEETING_PREP_EMAIL_DAYS = 7;
/**
 * Ambient carry-in window — recent signal from any sender/channel that may
 * surface follow-on context for the meeting, even if not attendee-specific.
 * 24 hours covers a full business day including overnight messages.
 */
const CARRY_IN_HOURS = 24;
import { getRecentSlackMessages, searchSlackMessages } from "@/lib/slack/client";
import { getTodayEvents } from "@/lib/google/calendar";
import { getZoomSummaries, filterByAttendees } from "@/lib/google/zoom-summaries";
import { listDecisions } from "@/lib/decisions/store";
import { listActions, isActionStalled } from "@/lib/actions/store";
import { stripSelf } from "@/lib/self-identity";
import {
  parseExtraContext,
  formatExtraContextBlock,
  type ExtraContext,
} from "@/lib/ai/extra-context";
import { getMemoriesForEntity, listMemories } from "@/lib/memory/store";
import type { Memory } from "@/lib/memory/types";

export async function POST(req: Request) {
  // Two ingress shapes:
  //  - JSON body (back-compat for anything still calling without extras)
  //  - multipart/form-data (new — includes free-text notes + file uploads)
  const contentType = req.headers.get("content-type") || "";

  let title: string;
  let attendees: string[];
  let date: string;
  let time: string;
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
      // userContacts is no longer forwarded — read from the server store below
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
    // userContacts is no longer forwarded — read from the server store below
  }

  // Fetch user contacts and AI-generated overrides from the server store so
  // meeting prep always reflects the latest profile data without the client
  // having to forward them through the request body.
  const [userContacts, overrideMap] = await Promise.all([
    listUserContacts().catch(() => [] as Contact[]),
    getAllOverridesFromStore().catch(() => ({} as Record<string, unknown>)),
  ]);

  // Michael isn't an attendee of his own meeting — strip him everywhere.
  const attendeeNames = stripSelf(attendees as string[]);
  const attendeeNamesLower = attendeeNames.map((n: string) => n.toLowerCase());

  const attendeeProfiles = attendeeNames
    .map((name: string) => {
      const contact = findContactByName(name, userContacts);
      if (!contact) return `${name} — no profile on file`;
      // Apply any AI-generated override on top of the base contact record
      const ov = (overrideMap as Record<string, {
        personality?: string; whatMakesThemTick?: string; watchOut?: string;
      }>)[contact.id];
      const enriched = ov
        ? {
            ...contact,
            personality: ov.personality ?? contact.personality,
            whatMakesThemTick: ov.whatMakesThemTick ?? contact.whatMakesThemTick,
            watchOut: ov.watchOut ?? contact.watchOut,
          }
        : contact;
      return getPersonaSummary(enriched);
    })
    .join("\n\n");

  // Fetch emails + Slack (recent + targeted search) + today's calendar + Zoom
  // summaries + decisions in parallel. Targeted search is critical — relying
  // only on the last 60 recent messages buries any conversation older than a day.
  const [emails, slackMessages, todaysCal, zoomSummariesAll, perAttendeeSlack, allDecisions, allActions, perAttendeeMemories, allMemories] = await Promise.all([
    getRecentEmails(50, MEETING_PREP_EMAIL_DAYS).catch((err) => {
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

    // All active decisions — filter client-side to those relevant to this meeting
    listDecisions().catch((err) => {
      console.error("Failed to fetch decisions for meeting prep:", err);
      return [];
    }),

    // All open actions — filter client-side to those relevant to this meeting
    listActions().catch((err) => {
      console.error("Failed to fetch actions for meeting prep:", err);
      return [];
    }),

    // Per-attendee memories — relationship context, prior person signals
    Promise.all(
      attendeeNames.map((name: string) =>
        getMemoriesForEntity(name).catch((): Memory[] => [])
      )
    ),

    // All memories — scan for active blockers (last 30 days)
    listMemories().catch((err) => {
      console.error("Failed to fetch memories for meeting prep:", err);
      return [] as Memory[];
    }),
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

  // Grab any Slack/email from the last CARRY_IN_HOURS — ambient signal from any
  // sender/channel that may surface carry-in context for the meeting.
  // 24 hours covers a full business day and overnight messages.
  const carryInCutoff = Date.now() - CARRY_IN_HOURS * 60 * 60 * 1000;
  const recentEmailsAnyAttendee = emails
    .filter((e) => new Date(e.date).getTime() > carryInCutoff)
    .slice(0, 15);
  const recentSlackAnyAttendee = slackMessages
    .filter((m) => new Date(m.date).getTime() > carryInCutoff)
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
    : `No recent email traffic in the last ${CARRY_IN_HOURS} hours.`;

  const carryInSlackBlock = recentSlackAnyAttendee.length > 0
    ? recentSlackAnyAttendee
        .map((m) => `- [${m.date}] ${m.author} in ${m.channel}: ${m.text}`)
        .join("\n")
    : `No recent Slack traffic in the last ${CARRY_IN_HOURS} hours.`;

  // Zoom summaries block — post-meeting AI Companion recaps Zoom sends via
  // email, plus any Drive docs titled with "Zoom". These capture what was
  // actually said on prior calls — often the only source of that signal.
  const zoomBlock = relevantZoom.length > 0
    ? relevantZoom
        .slice(0, 4)
        .map((z) => `- [${z.date}] (${z.source}) ${z.title}\n${z.body}${z.link ? `\n  link: ${z.link}` : ""}`)
        .join("\n\n")
    : "No Zoom AI Companion summaries or Zoom-titled Drive docs mention these attendees in the last 14 days.";

  // ── Relevant decisions — filter to those related to this meeting's attendees,
  // context, or meeting title. A decision is "relevant" if:
  //   - a stakeholder or decidedBy matches an attendee
  //   - the context field mentions an attendee name or the meeting title
  //   - the decision text mentions an attendee name
  // Only include active decisions from the last 90 days.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const relevantDecisions = allDecisions
    .filter((d) => {
      if (d.status === "superseded") return false;
      if (d.date && new Date(d.date) < ninetyDaysAgo) return false;

      const textLower = (d.text + " " + (d.title ?? "") + " " + (d.context ?? "")).toLowerCase();
      const decidedByLower = (d.decidedBy ?? "").toLowerCase();
      const stakeholdersLower = (d.stakeholders ?? []).map((s) => s.toLowerCase());

      return attendeeNamesLower.some(
        (name) =>
          textLower.includes(name) ||
          decidedByLower.includes(name) ||
          stakeholdersLower.some((s) => s.includes(name)) ||
          name.split(" ").some(
            (part) => part.length > 2 && textLower.includes(part)
          )
      ) || (title && textLower.includes(title.toLowerCase().slice(0, 20)));
    })
    .sort(
      (a, b) =>
        new Date(b.date ?? "").getTime() - new Date(a.date ?? "").getTime()
    )
    .slice(0, 8);

  const decisionsBlock =
    relevantDecisions.length === 0
      ? "No relevant logged decisions found for these attendees."
      : relevantDecisions
          .map((d) => {
            const headline = d.title ? `${d.title}: ${d.text}` : d.text;
            const meta: string[] = [];
            if (d.decidedBy) meta.push(`decided by ${d.decidedBy}`);
            if (d.date) meta.push(d.date);
            if (d.source) meta.push(`via ${d.source}`);
            const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
            const rationaleStr = d.rationale ? `\n  Why: ${d.rationale}` : "";
            const consequencesStr =
              d.consequences && d.consequences.length > 0
                ? `\n  Follow-ups: ${d.consequences.join("; ")}`
                : "";
            return `- ${headline}${metaStr}${rationaleStr}${consequencesStr}`;
          })
          .join("\n");

  // ── Relevant open actions — filter to those owned by or mentioning attendees,
  // or where text/source overlaps with the meeting. Only non-done items.
  const relevantActions = allActions
    .filter((a) => {
      if (a.status === "done") return false;

      const textLower = a.text.toLowerCase();
      const ownerLower = (a.owner ?? "").toLowerCase();

      return attendeeNamesLower.some(
        (name) =>
          textLower.includes(name) ||
          ownerLower.includes(name) ||
          name.split(" ").some((part) => part.length > 2 && textLower.includes(part))
      ) || (title && textLower.includes(title.toLowerCase().slice(0, 20)));
    })
    .sort((a, b) => {
      // Overdue first, then priority, then creation date
      const todayLocal = new Date().toISOString().split("T")[0];
      const aOverdue = a.status === "overdue" || (a.status === "open" && a.dueDate && a.dueDate < todayLocal);
      const bOverdue = b.status === "overdue" || (b.status === "open" && b.dueDate && b.dueDate < todayLocal);
      if (aOverdue && !bOverdue) return -1;
      if (!aOverdue && bOverdue) return 1;
      const po: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return (po[a.priority ?? "low"] ?? 2) - (po[b.priority ?? "low"] ?? 2);
    })
    .slice(0, 10);

  const openActionsBlock =
    relevantActions.length === 0
      ? "No relevant open actions found for these attendees."
      : relevantActions
          .map((a) => {
            const todayLocal = new Date().toISOString().split("T")[0];
            const isOverdue =
              a.status === "overdue" ||
              (a.status === "open" && a.dueDate && a.dueDate < todayLocal);
            const flags: string[] = [];
            if (isOverdue) flags.push("OVERDUE");
            else if (a.dueDate) flags.push(`due ${a.dueDate}`);
            if (a.priority === "high") flags.push("high priority");
            if (isActionStalled(a)) flags.push("stalled");
            if (a.owner && a.owner !== "Michael Cook") flags.push(`owner: ${a.owner}`);
            const flagStr = flags.length ? ` (${flags.join(", ")})` : "";
            return `- ${a.text}${flagStr}`;
          })
          .join("\n");

  const totalSignal = relevantEmails.length + relevantSlack.length + relevantZoom.length;

  // ── Per-attendee memory context (person notes, facts, relationship signals)
  const attendeeMemoryBlock = attendeeNames
    .map((name: string, i: number) => {
      const mems = (perAttendeeMemories as Memory[][])[i] ?? [];
      if (mems.length === 0) return null;
      const lines = mems
        .map((m: Memory) => `  - [${m.kind}] ${m.content}`)
        .join("\n");
      return `${name}:\n${lines}`;
    })
    .filter(Boolean)
    .join("\n\n");

  // ── Blocker memories — items explicitly flagged as blocked/stuck/at-risk in last 30 days
  const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const blockerMemories = (allMemories as Memory[])
    .filter((m: Memory) => {
      if (new Date(m.updatedAt).getTime() < thirtyDaysAgoMs) return false;
      return /\bblock(?:er|ed|ing)?\b|\bstuck\b|\bat risk\b|\brisk\b/.test(
        m.content.toLowerCase()
      );
    })
    .slice(0, 8);
  const blockersMemoryBlock =
    blockerMemories.length > 0
      ? blockerMemories
          .map(
            (m: Memory) =>
              `- ${m.entity ? `[${m.entity}] ` : ""}${m.content} (${new Date(m.updatedAt).toISOString().split("T")[0]})`
          )
          .join("\n")
      : null;

  const extraBlock = formatExtraContextBlock(extra);

  const promptText = `Generate a meeting prep cheatsheet for Michael — sharp, opinionated, the kind of note a great chief of staff slides across before he walks in. Match the depth of a senior exec's handwritten pre-meeting notes.

Meeting: ${title}
Date/Time: ${date} at ${time} UK
Attendees:
${attendeeProfiles}

## EARLIER TODAY — MICHAEL'S OWN CALENDAR (all events that already happened today before this one)
${earlierTodayBlock}

## CARRY-IN EMAIL (last ${CARRY_IN_HOURS} hours, any sender — signal that may bleed into this meeting)
${carryInEmailBlock}

## CARRY-IN SLACK (last ${CARRY_IN_HOURS} hours, any channel — signal that may bleed into this meeting)
${carryInSlackBlock}

## RECENT EMAIL WITH ATTENDEES (filtered to this meeting's people)
${emailContext || "No recent emails found with these attendees."}

## RECENT SLACK WITH ATTENDEES (filtered + actively searched — DMs, mentions, channel posts for each attendee)
${slackContext || "No recent Slack activity found with these attendees."}

## ZOOM SUMMARIES WITH ATTENDEES (AI Companion post-meeting recaps + Drive docs titled 'Zoom', last 14 days)
${zoomBlock}

## LOGGED DECISIONS RELEVANT TO THIS MEETING (from Decision Log — already made, use as context and to avoid re-litigating)
${decisionsBlock}

## OPEN ACTIONS RELEVANT TO THIS MEETING (from Action Tracker — overdue/stalled items need particular attention)
${openActionsBlock}

## RELATIONSHIP MEMORY — BASIL'S NOTES ON ATTENDEES (person facts & signals accumulated over time — use as relationship context, not as AI-generated claims)
${attendeeMemoryBlock || "No memory notes on file for these attendees."}

## BLOCKER MEMORY — ITEMS FLAGGED AS BLOCKED OR AT RISK IN THE LAST 30 DAYS (from memory store — explicit, source-backed)
${blockersMemoryBlock || "No blockers flagged in memory."}
${extraBlock ? `\n${extraBlock}` : ""}
## SIGNAL DENSITY — ${totalSignal} relevant item(s) found across email, Slack, and Zoom${relevantDecisions.length > 0 ? `, plus ${relevantDecisions.length} relevant decision(s)` : ""}${relevantActions.length > 0 ? `, plus ${relevantActions.length} open action(s)` : ""}${extraBlock ? ", plus extra context Michael attached" : ""}.
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

**suggestedQuestions** — 2-5 specific, grounded questions Michael should ask in this meeting. Root each in a concrete signal: an overdue action, an unresolved prior decision, a commitment made on a Zoom call, or a blocker in memory. Never generic ("how are things going?"). Each question should be specific enough that a wrong answer would be notable. Examples: "Did the Tier 1 outreach actually go out last week, or was it still on hold?" / "Has the budget for the new engineering hire been signed off?"

**unresolvedRisks** — 0-4 risks that are **explicitly documented** in the data blocks above — email, Slack, Zoom summaries, or blocker memory. Not inferred — only what is clearly stated somewhere in the inputs. Each: risk (what the specific risk is), source (e.g. "Slack from Ed, April 21" or "Zoom summary April 15"), raisedDate (YYYY-MM-DD if evident from context, omit otherwise). Return empty array if no explicit risks found.

## Factual guardrails — non-negotiable

Michael walks into meetings with what you write. Don't make him look ill-informed.

- fromTodaysCalls + topicsToRaise + thingsToLand + watchOuts: every specific claim traceable to a line in the CARRY-IN, RECENT, ZOOM SUMMARIES, LOGGED DECISIONS, or EXTRA CONTEXT blocks above, or to the EARLIER TODAY calendar. If you can't trace it, don't claim it.
- When Michael attached EXTRA CONTEXT (notes, files, a folder), treat it as FIRST-CLASS signal. Weave it into topicsToRaise and thingsToLand — reference by filename if relevant. Those attachments usually represent what Michael is actually thinking about going into the meeting.
- Zoom summaries are GOLD — they contain what was actually said on prior calls. When a topic traces to a Zoom summary, say so in the context field (e.g. "per Tuesday's Zoom summary, Ed committed to...") so Michael can audit.
- LOGGED DECISIONS are prior calls that are ALREADY MADE — do not surface them as open questions. Instead: (1) use them as context in topicsToRaise when they're directly relevant ("we decided X in [meeting], so the question is now Y"); (2) add a watchOut if a relevant decision may be challenged or re-litigated in this meeting; (3) reference them in thingsToLand if this meeting should confirm or act on a prior decision's follow-ups.
- OPEN ACTIONS are real tracked commitments from the Action Tracker. OVERDUE or stalled actions involving meeting attendees are prime candidates for topicsToRaise ("Ed has an overdue action from last week — check status") or thingsToLand ("Confirm action X is unblocked before EOD"). Never invent actions not in this block.
- RELATIONSHIP MEMORY contains facts and notes accumulated over prior interactions. Use them to enrich attendeeInsights and topicsToRaise — treat them as reliable background, not as grounds for inventing new claims.
- BLOCKER MEMORY contains explicitly tracked blockers. If any are relevant to this meeting's attendees, surface them in unresolvedRisks or watchOuts — but quote the content, don't paraphrase into something stronger.
- suggestedQuestions: every question must trace to a concrete signal — an overdue action, a prior decision's follow-up, a Zoom commitment, or a blocker memory. "Ask how it's going" is never acceptable. Omit the field rather than invent questions.
- unresolvedRisks: only populate from explicit evidence in the source blocks. If nothing is flagged, return [].
- attendeeInsights.style draws on the persona background for the operating profile. That's appropriate — personas describe how people *operate*, which is exactly what this field captures. Never invent a current thread or belief.
- **LOW SIGNAL discipline**: if SIGNAL DENSITY above is low, produce a SHORTER prep. Fewer topics, each one honestly sourced from whatever signal DOES exist. An accurate 2-topic prep beats a fabricated 5-topic prep every time. When in doubt, say "no carry-in signal" in watchOuts — that's MORE useful to Michael than invented context.
- If a block says "No recent…" or "No Zoom…" or "No relevant decisions found", do NOT invent claims scoped to that block. Say nothing, or flag the absence as a watch-out.
- Do NOT invent deal stages, prospect names, company names, pending decisions, or commitments.
- Empty arrays are acceptable. If earlier today was quiet, fromTodaysCalls: []. If no recent signal, topicsToRaise: []. Better a sparse prep than a fabricated one.

## Output shape

Return ONLY valid JSON, no markdown code fences:
{
  "fromTodaysCalls": [{"title": "...", "summary": "..."}],
  "attendeeInsights": [{"name": "...", "role": "...", "style": "..."}],
  "topicsToRaise": [{"title": "...", "context": "...", "priority": "free-form action label"}],
  "suggestedQuestions": ["..."],
  "thingsToLand": ["..."],
  "watchOuts": ["..."],
  "unresolvedRisks": [{"risk": "...", "source": "...", "raisedDate": "YYYY-MM-DD or omit"}]
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
    model: "anthropic/claude-sonnet-4.6",
    system: await getSystemPrompt(),
    ...(messages ? { messages } : { prompt: promptText }),
    providerOptions: {
      gateway: { tags: ["feature:meeting-prep", "env:production"] },
    },
  });

  try {
    const parsed = parseAIJson<Record<string, unknown>>(result.text);
    return Response.json({
      ...parsed,
      generatedAt: new Date().toISOString(),
      extraContextSummary: extra.summary,
      // Structured reference data — passed directly from store, not AI-generated,
      // so provenance and exact text are preserved.
      openActions: relevantActions.map((a) => ({
        id: a.id,
        text: a.text,
        owner: a.owner,
        dueDate: a.dueDate,
        status: a.status,
        priority: a.priority,
        source: a.source,
        createdAt: a.createdAt,
      })),
      priorDecisions: relevantDecisions.map((d) => ({
        id: d.id,
        text: d.text,
        title: d.title,
        decidedBy: d.decidedBy,
        date: d.date,
        rationale: d.rationale,
        consequences: d.consequences,
        source: d.source,
        confidence: d.confidence,
      })),
    });
  } catch {
    return Response.json({ error: "Failed to parse AI response", raw: result.text });
  }
}
