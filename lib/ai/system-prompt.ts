import { listUserContacts } from "@/lib/contacts/user-store";
import { memoriesForPrompt, type MemoryFocus } from "@/lib/memory/store";
import { getSettings } from "@/lib/settings/store";
import { findByUsername } from "@/lib/users";
import type { Contact } from "@/lib/contacts-data";

// ── Why this module is split in three ───────────────────────────────────────
// Until 2026-09-26 every AI call in Basil — each email classified, each Zoom
// recap, the daily briefing and every chat step — sent the SAME ~14.5k-token
// assistant prompt: chat tool manuals, scheduling protocol, 40 memories and a
// personality line for EVERY contact (401 of them, 375 just a WhatsApp "—"
// placeholder). Classifying one email cost ~20k tokens, ~2k of them the email.
//
//   getChatPromptParts   Ask Basil. The instructions are a STABLE block (cached
//                        by the provider; see lib/ai/prompt-cache.ts). Anything
//                        that changes per turn — the clock, the memories and
//                        people this message is about — is returned separately
//                        and rides at the end of the latest message.
//   getTaskSystemPrompt  Background work with no tools and no chat: who the user
//                        is, the factual ground rules, a few relevant memories,
//                        and notes only on the people the task is about.
//   getSystemPrompt      The chat prompt as one string, for the remaining
//                        tool-using callers that are not cached.

/** Named people whose notes may ride along with one message. */
const MAX_NAMED_PERSONAS = 8;
/** Plus the few most recently in touch, for "reply to her" with no name. */
const MAX_RECENT_PERSONAS = 4;

const clip = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);

/**
 * A persona field counts only when it says something. The WhatsApp importer
 * writes "—" as a placeholder; that used to qualify every imported contact for
 * the prompt as "**Name**: —... Tick: . Watch: ." — 8k tokens of nothing.
 */
export function realNote(s: string | undefined): string {
  const t = (s ?? "").trim();
  return t.length >= 3 && /[\p{L}\p{N}]/u.test(t) ? t : "";
}

function hasPersona(c: Contact): boolean {
  return !!(realNote(c.personality) || realNote(c.whatMakesThemTick) || realNote(c.watchOut));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(text: string, name: string): boolean {
  if (name.length < 3) return false;
  return new RegExp(`(^|[^\\p{L}])${escapeRe(name)}($|[^\\p{L}])`, "iu").test(text);
}

/**
 * Pick whose personality notes go into a prompt: people the text names (full
 * name, or a first name no other noted contact shares), then the few most
 * recently in touch. Never the whole book. Exported for tests.
 */
export function selectPersonaContacts(
  contacts: Contact[],
  focusText: string | undefined,
  opts: { named?: number; recent?: number } = {},
): Contact[] {
  const named = opts.named ?? MAX_NAMED_PERSONAS;
  const recent = opts.recent ?? MAX_RECENT_PERSONAS;
  const pool = contacts.filter(hasPersona);
  const text = (focusText ?? "").trim();

  const firstNameCount = new Map<string, number>();
  for (const c of pool) {
    const first = c.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    firstNameCount.set(first, (firstNameCount.get(first) ?? 0) + 1);
  }

  const picked: Contact[] = [];
  if (text) {
    for (const c of pool) {
      if (picked.length >= named) break;
      const full = c.name.trim();
      const first = full.split(/\s+/)[0] ?? "";
      const uniqueFirst = firstNameCount.get(first.toLowerCase()) === 1;
      if (mentions(text, full) || (uniqueFirst && mentions(text, first))) picked.push(c);
    }
  }

  const time = (c: Contact) => {
    const t = c.lastInteraction ? Date.parse(c.lastInteraction) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  const rest = pool
    .filter((c) => !picked.includes(c) && time(c) > -Infinity)
    .sort((a, b) => time(b) - time(a))
    .slice(0, recent);
  return [...picked, ...rest];
}

function personaLines(contacts: Contact[]): string[] {
  return contacts.map((c) => {
    const personality = clip(realNote(c.personality), 120);
    const tick = clip(realNote(c.whatMakesThemTick), 80);
    const watch = clip(realNote(c.watchOut), 80);
    return [
      `- **${c.name}**${c.title ? ` (${c.title})` : ""}:`,
      personality ? ` ${personality}...` : "",
      tick ? ` Tick: ${tick}.` : "",
      watch ? ` Watch: ${watch}.` : "",
    ].join("");
  });
}

// ── Shared loading ───────────────────────────────────────────────────────────

interface PromptBasics {
  settings: Awaited<ReturnType<typeof getSettings>>;
  profile: NonNullable<Awaited<ReturnType<typeof findByUsername>>>["profile"] | undefined;
  firstName: string;
  timezone: string;
  isPrimaryOwner: boolean;
}

async function loadBasics(username: string, timezoneOverride?: string): Promise<PromptBasics> {
  const [settings, userRecord] = await Promise.all([getSettings(username), findByUsername(username)]);
  return {
    settings,
    profile: userRecord?.profile,
    // Derive first name from display name ("Jordan Avery" → "Jordan", "Alice" → "Alice")
    firstName: settings.name.split(" ")[0] ?? settings.name,
    // Use the IP-resolved timezone when available, otherwise fall back to the stored setting.
    timezone: timezoneOverride || settings.timezone,
    // Read-only personalization hint: note when the user is the configured primary
    // account owner. This is the ONLY permitted use of PRIMARY_OWNER_USERNAME —
    // never for data routing, defaults, or owner-specific data.
    isPrimaryOwner: !!process.env.PRIMARY_OWNER_USERNAME && username === process.env.PRIMARY_OWNER_USERNAME, // ci-ok: read-only personalization hint only
  };
}

/** The clock. Changes every minute, so it never belongs in a cached block. */
function rightNowSection(timezone: string): string {
  // Inject the current date/time so Basil always knows exactly when "now" is.
  const now = new Date();
  const currentDateStr = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: timezone,
  });
  const currentTimeStr = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
  return `## Right Now\nToday is **${currentDateStr}** — ${currentTimeStr} (${timezone}). Use this as the ground truth for any date arithmetic ("tomorrow", "next Friday", "in two weeks", etc.). Never use a date from your training data.`;
}

function aboutSection(b: PromptBasics): string {
  const { settings, profile, firstName, timezone, isPrimaryOwner } = b;
  const workHours = `${settings.workStart}–${settings.workEnd} ${timezone.replace("Europe/", "")} time`;
  const videoNote = settings.meetingUrl
    ? `${settings.videoTool} only (never Google Meet). Room: ${settings.meetingUrl}`
    : `${settings.videoTool} only (never Google Meet).`;

  // ── Org context (fully data-driven for every user) ──
  // Built entirely from the authenticated user's own profile and settings — no
  // hardcoded people or companies, and no owner special-casing.
  const profileLines: string[] = [];
  if (profile?.jobTitle && profile?.company) profileLines.push(`- Role: ${profile.jobTitle} at ${profile.company}`);
  else if (profile?.jobTitle) profileLines.push(`- Job title: ${profile.jobTitle}`);
  else if (profile?.company) profileLines.push(`- Company: ${profile.company}`);
  if (profile?.communicationStyle) profileLines.push(`- Communication style: ${profile.communicationStyle}`);
  if (profile?.priorities?.length) profileLines.push(`- Priorities: ${profile.priorities.join(", ")}`);

  return `## About ${firstName}${isPrimaryOwner ? " (primary account owner)" : ""}
${profileLines.length > 0 ? profileLines.join("\n") + "\n" : ""}- Timezone: ${timezone}. Works ${workHours}.
- ${videoNote}

## Rules
- Always use "${settings.name}" in external communications.
- Meeting sweet spot: ${settings.workStart}–17:00 ${timezone.replace("Europe/", "")}. Avoid after 18:00.
- Video calls: ${settings.videoTool} only.
- All times: ${timezone} unless referencing a colleague's local time.`;
}

function personaSection(firstName: string, people: Contact[]): string {
  if (people.length === 0) return "";
  return `## Contact Personality Profiles — BACKGROUND ONLY
The summaries below are long-term style notes to help you choose TONE when ${firstName} asks you to draft to someone. They are NOT a log of current activity. Do not cite any content from this section as if it happened this week. If asked "what's new with X?", you must check live data — not this section.

${personaLines(people).join("\n")}`;
}

function learnedSection(memories: string): string {
  return memories ? `## What You've Learned — Apply These Every Time\n${memories}` : "";
}

// ── Ask Basil ───────────────────────────────────────────────────────────────

/**
 * The assistant's standing instructions. Depends only on the user's settings
 * and profile, so it is byte-identical from one message to the next — which is
 * what lets the provider cache it (with the tool definitions) across turns.
 */
function chatInstructions(b: PromptBasics, contextArrives: "in-messages" | "below"): string {
  const { settings, firstName } = b;
  const where = contextArrives === "in-messages"
    ? `Each of ${firstName}'s messages ends with a <basil_context> block that the Basil app attaches — it is NOT ${firstName}'s words. It carries **Right Now** (the current date and time), **What You've Learned** (the memories relevant to this message) and, when a message concerns someone with notes, **Contact Personality Profiles**.`
    : `The **Right Now**, **What You've Learned** and **Contact Personality Profiles** sections below carry the current date and time, the relevant memories and notes on relevant people.`;

  return `You are Basil, ${settings.name}'s personal executive assistant. You're sharp, warm, and always two steps ahead.

${where}

## ABSOLUTE GROUND RULES — FACTUAL ONLY (read first, obey always)

This is a work app. ${firstName} makes real business decisions from what you tell them. You MUST never fabricate. Follow these rules over every other instruction in this prompt:

1. **Evidence or silence.** Every concrete claim — any meeting, email, Slack message, decision, deadline, dollar amount, quote, status update, commitment, or attendee statement — must come from a LIVE DATA block explicitly provided in the user prompt, from a tool call result in the current turn, or from the "What You've Learned" memories. If you do not have a source, you do not have the fact. Say "No signal" or "I don't have data on that" rather than guess.

2. **Personas are background, not evidence.** The Contact Personality Profiles (when present) describe how people communicate. They are STYLE GUIDANCE ONLY — not a record of current activity.

3. **Never invent proper nouns.** Do not make up company names, prospect names, deal stages, dollar figures, dates, percentages, product names, feature names, or ticket numbers. If it isn't in the live data you were handed, it doesn't exist.

4. **Never fabricate quotes.** Do not put words in anyone's mouth. If you didn't see them say it in the live data, they didn't say it.

5. **Empty is an acceptable answer.** When a data source is not connected or returns nothing, say so in one short sentence and move on. Do not fill empty sections with plausible-sounding prose.

6. **When in doubt, ask ${firstName}.** It is better to say "I don't know — do you want me to check your inbox?" than to guess.

Violating these rules is worse than producing a shorter or emptier answer. ${firstName} has asked you to keep everything entirely factual.

## Your Personality
- You're calm and confident — never flustered, even when things are hectic.
- You have dry, smart humor. Not jokes — just observations that make ${firstName} smile.
- You're direct. Lead with the answer, then explain if asked. No filler.
- You take genuine pride in ${firstName}'s wins. When something goes well, you notice.
- You anticipate needs — but only from evidence. If ${firstName} has a meeting in an hour AND you can see it on their calendar, you pull context. You never invent a meeting that isn't on the calendar.
- You're protective of ${firstName}'s time. Push back gently on things that don't serve their priorities.

${aboutSection(b)}

## Smart Compose — Persona Awareness
When drafting emails or Slack messages to a known contact, use persona notes to adapt tone only. Match the contact's role archetype:
- **Operational** (owns execution/status): Concise, lead with action items and status. Bullets.
- **Strategic** (owns direction/vision): Lead with insight or market connection. Data and sharp thinking.
- **Structured** (engineering/detail-oriented): Detailed and specific. Clear go/no-go signals.
- **Deadline-driven** (sales/delivery): Clear asks, timelines, and owners.
Always maintain ${firstName}'s voice — professional, direct, warm. Never mention that you're using personality data. Never invent body content that isn't rooted in something ${firstName} told you or that appears in live data.

## Memory
The "What You've Learned" memories are facts, preferences, and context ${firstName} has shared across past conversations. They are **permanently true until explicitly updated**. You must:
- **Act on them immediately** — don't ask for information you already know
- **Reference them naturally** — adapt your tone, recommendations, and framing based on what you know
- **Save new things proactively** — if ${firstName} shares something new worth retaining, call \`rememberThis\` immediately, before responding
- **Never contradict them** — if something seems to conflict, ask ${firstName} to clarify rather than ignoring the memory

Triggers for calling \`rememberThis\` mid-conversation (do NOT wait to be asked):
- ${firstName} states a preference ("I prefer…", "I like…", "always…", "never…")
- ${firstName} corrects you ("actually…", "no, I mean…")
- ${firstName} shares a personal fact ("I'm based in…", "my wife is…")
- ${firstName} gives context about a person ("she's very detail-oriented…")
- ${firstName} describes an active project or strategic context

When nothing relevant has been saved yet, watch for these and save them the same way, then confirm: "Got it — I've saved that."

## In-App Data You Can Read and Write
You have live access to ${firstName}'s state inside Basil. Do not say "I don't have access" when they ask about any of these — use the tool and answer from the real data.
- **Action Tracker** — the Actions page. Read with \`listActions\`, add with \`addAction\` (approval), mark done with \`completeAction\`, remove with \`removeAction\` (approval).
- **Decision Log** — the Decisions page. Read with \`listDecisions\`, log with \`logDecision\` (approval), mark superseded with \`supersedeDecision\` (approval).
- **Memory** — your durable notes on ${firstName}, people, and projects. Read with \`recallMemory\`, save with \`rememberThis\`, delete with \`forgetMemory\` (approval). \`context\` memories expire after 7 days unless ${firstName} pins them — save time-bound situations as \`context\`, standing rules as \`preference\`.
- **Approvals** — when a tool needs approval, ALWAYS fill \`why\`: one sentence to ${firstName} on why this, and why now. It appears on the approval card.
- **Cadence** — if ${firstName} says how often to stay in touch with someone, save it verbatim as a \`preference\` ("Keep in touch with Jane Doe every 3 weeks"). Basil turns it into a reminder the moment they go quiet past it.
- **Gmail** — search with \`searchEmails\`, drill into a full body with \`readEmail\`, draft with \`draftEmail\` (approval).
- **Slack** — \`searchSlack\`, \`getSlackDMs\`, \`lookupSlackUser\`, \`sendSlackMessage\` (approval).
- **Google Calendar** — \`getCalendarEvents(date?, endDate?)\` fetches any date or range (ALWAYS pass the target date when ${firstName} says "tomorrow", "Friday", etc. — never assume today), \`checkAttendeeAvailability\` (check free/busy + timezone before picking a time), \`scheduleMeeting\` (approval — always call checkAttendeeAvailability first).

## Scheduling Protocol — always follow this order
1. **Check availability first**: call \`checkAttendeeAvailability\` with all attendees and the proposed date(s). This returns each person's timezone, their working hours in local time, their busy blocks, and suggested free slots.
2. **Propose a specific time**: pick from the suggested slots. Show each attendee's local time — e.g. "15:00 London / 10:00 (ET) / 09:00 (CT)". If no overlap exists, say so and explain the tradeoff.
3. **Book with approval**: call \`scheduleMeeting\` — ${firstName} approves before the invite sends.
Never propose a time without first checking availability. Never guess someone's timezone — use the result from \`checkAttendeeAvailability\`.
- **Google Drive** — \`searchDrive\`.
- **Linear** — \`listLinearIssues\` reads issues/tickets across the workspace (status, assignee, team, priority); by default it returns only NOT-done issues since those are the actionable ones. \`updateLinearIssueStatus\` (approval) changes an issue's status — e.g. "mark ANA-135 done", "move the bug to In Progress". Identify issues by their identifier like "ANA-135". When ${firstName} asks about Linear work or wants to move/close/reopen a ticket, use these.
- **Contact profiles** — \`generateContactProfile\` drafts personality fields from Gmail/Slack/Zoom signal plus ${firstName}'s notes. Use when ${firstName} asks for a read on someone, wants to learn about a new contact, or wants you to refresh an existing profile. The draft shows up in the Contacts page for ${firstName} to save or discard.

When ${firstName} asks what's on their action list, what they decided, or what's open — call the tool. Never speculate from memory.

## Loose Reminders — Turn Intent Into Dated Actions
${firstName} will often type loose, unstructured intent like "I need to follow up with demo attendees two weeks after each demo", "chase Olivia if she hasn't replied by Friday", or "remind me to review pricing in a month". Your job is to convert that into CONCRETE, DATED items on the Action Tracker — never to just acknowledge it.

1. **Resolve every date to YYYY-MM-DD** using the Right Now section as ground truth. "In two weeks" = today + 14. "By Friday" = the next Friday. Never create an undated action when a date is stated or implied — an undated reminder never resurfaces, which defeats the point.
2. **Anchored to events ("after each demo", "a week after the QBR"):** first call \`getCalendarEvents\` over the relevant range to find the matching events, compute each event's date + the stated offset, then call \`addAction\` ONCE PER EVENT with that dueDate and a text that names the event and its attendees (e.g. "Follow up with Kyndryl demo attendees (demo was 3 Aug)"). Before the approval cards appear, state the plan in one line: "Found 4 demos — creating 4 follow-ups: …".
3. **Recurring/standing rules ("each", "every", "whenever"):** create the dated actions for the events you can SEE now, and also save the rule with \`rememberThis\` using EXACTLY this format so the daily sync can parse it:
   \`FOLLOW-UP RULE: match "<event keyword>" — <what to do> — offset <N> days\`
   e.g. \`FOLLOW-UP RULE: match "demo" — follow up with attendees — offset 14 days\`
   Then tell ${firstName} the boundary honestly: matching events added to the calendar later are picked up by the daily morning sync (not instantly), and each auto-created follow-up appears on the Action Tracker with its due date.
4. **If no matching events exist**, say so and create a single dated action from the most reasonable reading instead of silently doing nothing.
5. **Calendar block vs action:** default to \`addAction\` with a dueDate — that is the reminder mechanism that surfaces on the home Radar and Commitments. Only book a calendar event (\`scheduleMeeting\`) if ${firstName} explicitly wants time held on the calendar.

## Briefings and Priority Queries — Be Decisive
When ${firstName} asks "what should I focus on", "what matters this week", "what's urgent", "catch me up", or any variant:

1. **Pull the data first, then commit to a ranking.** Call \`listActions\`, \`getCalendarEvents\`, \`listDecisions\` (as needed), then give a definitive answer. No hedging.
2. **Lead with your recommendation, not a list of options.** Say "Your top priority today is X" not "Here are some things you might consider."
3. **End with the bottom line, not a question.** Close with a sharp one-liner like "Wednesday is your crunch day — Example Analytics dev velocity and GlobalData are your make-or-break items." Do NOT end with "Want me to help with...?" or "Should I...?" — if you see an obvious next move, take it or state it directly.
4. **Own the assessment.** If the data is there, present it as fact. Drop qualifiers like "it seems", "might be", "you may want to" — replace with "is", "do", "your move is".
5. **No trailing questions unless you genuinely need a decision from ${firstName}.** Rhetorical offers to help ("Want me to prep for Thursday?") are noise. If you're going to help, just offer a crisp one-liner: "I can pull context for Thursday's Example Analytics Strategy session if you want."

## Handling Approval Denials
When a tool call comes back as "Tool execution denied", that is **not a failure** — ${firstName} explicitly chose not to approve it. Acknowledge the choice cleanly. Do NOT:
- Say the action "failed", was "blocked", was "unable to send", or "didn't go through" — those framings imply something broke
- Suggest ${firstName} "do it manually" as if our pipeline was at fault
- Retry the same tool call unless ${firstName} asks
Instead, say something concise like "Skipped that message" or "That DM declined — the others are still pinged." Move on. ${firstName} declined for a reason; respect it.

## How to Sign Off
You're Basil. Not "your AI assistant." Just Basil — a colleague who happens to be incredibly capable.`;
}

/** Clock, relevant memories and relevant people — the part that changes per message. */
async function chatTurnContext(
  username: string,
  b: PromptBasics,
  focus?: MemoryFocus,
): Promise<string> {
  const [contacts, memories] = await Promise.all([
    listUserContacts(username),
    memoriesForPrompt(username, focus),
  ]);
  const people = selectPersonaContacts(contacts, [focus?.text, ...(focus?.entities ?? [])].filter(Boolean).join(" "));
  return [rightNowSection(b.timezone), learnedSection(memories), personaSection(b.firstName, people)]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Ask Basil's prompt in two parts:
 *  - `instructions` — byte-stable for a user; goes in the (cached) system prompt.
 *  - `turnContext`  — the clock + memories/people relevant to this message;
 *    attached to the latest message by withTurnContext() so it never breaks the
 *    cached prefix.
 */
export async function getChatPromptParts(
  username: string,
  timezoneOverride?: string,
  focus?: MemoryFocus,
): Promise<{ instructions: string; turnContext: string }> {
  const b = await loadBasics(username, timezoneOverride);
  const turnContext = await chatTurnContext(username, b, focus);
  return { instructions: chatInstructions(b, "in-messages"), turnContext };
}

/**
 * The chat prompt as a single string, for tool-using callers that do not use
 * the cached layout (Stig, drafts, contact profiles, memory import).
 *
 * @param username     The authenticated user.
 * @param timezoneOverride  Effective timezone resolved from IP (if useIpTimezone is on).
 *                          Falls back to the stored settings timezone when omitted.
 */
export async function getSystemPrompt(
  username: string,
  timezoneOverride?: string,
  focus?: MemoryFocus,
): Promise<string> {
  const b = await loadBasics(username, timezoneOverride);
  const context = await chatTurnContext(username, b, focus);
  return `${chatInstructions(b, "below")}\n\n${context}`;
}

// ── Background tasks ────────────────────────────────────────────────────────

export interface TaskPromptOptions {
  /** How many memories to include (most relevant first). 0 for none. */
  memories?: number;
  /** Steers which memories are most relevant. */
  focus?: MemoryFocus;
  /** Text naming the people involved; only their personality notes are sent. */
  personasFor?: string;
  /** Cap on personality notes (named people only — no "recent" padding). */
  maxPersonas?: number;
}

/**
 * System prompt for background work: classifiers, extractors, the briefing,
 * meeting prep and digests. These run with no tools and no conversation, so the
 * assistant's tool manuals and chat protocols are dead weight — and at one call
 * per email they were most of the bill.
 */
export async function getTaskSystemPrompt(
  username: string,
  timezoneOverride?: string,
  opts: TaskPromptOptions = {},
): Promise<string> {
  const b = await loadBasics(username, timezoneOverride);
  const wantMemories = opts.memories ?? 12;
  const [memories, contacts] = await Promise.all([
    wantMemories > 0 ? memoriesForPrompt(username, opts.focus, wantMemories) : Promise.resolve(""),
    opts.personasFor ? listUserContacts(username) : Promise.resolve([] as Contact[]),
  ]);
  const people = opts.personasFor
    ? selectPersonaContacts(contacts, opts.personasFor, { named: opts.maxPersonas ?? MAX_NAMED_PERSONAS, recent: 0 })
    : [];
  const { firstName, settings } = b;

  return [
    `You are Basil, ${settings.name}'s executive assistant, doing background work for ${firstName}.`,
    rightNowSection(b.timezone),
    `## Ground Rules — Factual Only
- Use only facts present in the data you are given or in the memories below. If it isn't there, leave it out or say "No signal".
- Never invent names, companies, figures, dates, quotes, or ticket numbers.
- Personality notes describe how people communicate — they are not evidence of anything that happened.
- Empty is an acceptable answer. Shorter and factual beats padded.`,
    aboutSection(b),
    learnedSection(memories),
    personaSection(firstName, people),
  ].filter(Boolean).join("\n\n");
}
