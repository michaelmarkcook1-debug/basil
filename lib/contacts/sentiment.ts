/**
 * lib/contacts/sentiment.ts — how each relationship feels, and which way it's going.
 *
 * Tone tracking used to exist only as "shifts" the message classifier happened
 * to notice (lib/contacts/tone-store.ts): on 2026-10-10 just 6 of 23 contacts had
 * any, the newest from mid-September, and the card that showed them was hidden
 * unless one existed. This reads each person's last 30 days — Slack (574
 * messages that month), their email, and the stored history — and states a
 * current tone, a trend, and the evidence behind them.
 *
 * One cheap model call per person, at most once a day, and only when there is
 * something new: the verdict is stored with the newest interaction it saw.
 */
import "server-only";
import { z } from "zod";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { listEvents } from "@/lib/events/store";
import type { BasilEvent } from "@/lib/events/types";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getAllOverridesFromStore } from "@/lib/contacts/overrides-store";
import type { ToneObservation } from "@/lib/contact-profile-overrides";
import { getSelfIdentity } from "@/lib/self-identity";
import { getRecentSlackMessages, type SlackMessage } from "@/lib/slack/client";
import { getRecentEmails, type GmailMessage } from "@/lib/google/gmail";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { getSettings } from "@/lib/settings/store";
import { baselineOf, recentSignals, confidenceOf, describeSignals, type Baseline, type RecentSignals, type Confidence } from "@/lib/contacts/relationship-signals";

const FILE = "contact-sentiment.json";
const WINDOW_DAYS = 30;
/** The long window a person's own baseline is drawn from. */
const BASELINE_DAYS = 90;
/** Re-read a relationship at most this often, however busy it is. */
const REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_INTERACTIONS = 30;
/** Fewer than this and there is nothing to read a tone from. */
export const MIN_INTERACTIONS = 2;

export type Tone = "warm" | "positive" | "neutral" | "cool" | "strained";
export type Trend = "warming" | "steady" | "cooling";

export interface RelationshipSentiment {
  contactId: string;
  tone: Tone;
  trend: Trend;
  summary: string;
  evidence: Array<{ date: string; source: string; note: string }>;
  /** Interactions read. */
  basedOn: number;
  /** Newest interaction considered — the verdict is current until a newer one exists. */
  latestAt: string;
  computedAt: string;
  /** How much to trust it: "early" reads show grey and carry no trend. */
  confidence?: Confidence;
  /** Plain facts the read was judged against (reply time, length, gaps vs their usual). */
  facts?: string[];
  /** The user said this read was wrong, and why — fed into every later read of this person. */
  correction?: { note: string; at: string };
}

export interface Interaction { date: string; source: string; from: string; text: string; mine: boolean }

type ContactLike = { id: string; name: string; email?: string };

// ── Which messages are with this person ──────────────────────────────────────

/** "Carter Lusher - Lusher Advisory" → ["carter", "lusher"]. */
function nameTokens(name: string): string[] {
  return name.toLowerCase().replace(/\s+[-–|(].*$/, "").replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter((t) => t.length > 1);
}

function isPerson(from: string, tokens: string[]): boolean {
  const f = nameTokens(from);
  if (tokens.length === 0 || f.length === 0) return false;
  // First and last name both present (a lone "Matt" would match every Matt).
  return tokens.length === 1 ? f[0] === tokens[0] : f.includes(tokens[0]) && f.includes(tokens[tokens.length - 1]);
}

export interface InteractionSources {
  slack?: SlackMessage[];
  emails?: GmailMessage[];
  /** Stored, classified events — older context, and Zoom/meeting signals. */
  events?: BasilEvent[];
}

/**
 * What this person said — to the user directly first (DMs, group DMs,
 * @-mentions, their email), then elsewhere — and what the user said to them
 * one-to-one. Newest first. Pure — exported for tests.
 */
export function interactionsWith(contact: ContactLike, src: InteractionSources, selfNames: string[], now = Date.now(), windowDays = WINDOW_DAYS, max = MAX_INTERACTIONS): Interaction[] {
  const tokens = nameTokens(contact.name);
  const email = contact.email?.toLowerCase();
  const self = selfNames.map((n) => n.toLowerCase());
  const since = now - windowDays * 86_400_000;
  const direct: Interaction[] = [];
  const elsewhere: Interaction[] = [];
  const seen = new Set<string>();
  const add = (bucket: Interaction[], i: Interaction) => {
    const key = `${i.date.slice(0, 16)}|${i.text.slice(0, 60)}`;
    if (!i.text || Date.parse(i.date) < since || seen.has(key)) return;
    seen.add(key);
    bucket.push({ ...i, text: i.text.replace(/\s+/g, " ").slice(0, 300) });
  };

  for (const m of src.slack ?? []) {
    const toThem = m.fromSelf && m.channel.startsWith("DM: ") && isPerson(m.channel.slice(4), tokens);
    if (toThem) { add(direct, { date: m.date, source: "slack", from: "you", text: m.text, mine: true }); continue; }
    if (m.fromSelf || !isPerson(m.author, tokens)) continue;
    const toYou = m.channelMembers !== undefined || m.isMention;
    add(toYou ? direct : elsewhere, { date: m.date, source: toYou ? "slack" : `slack ${m.channel}`, from: contact.name, text: m.text, mine: false });
  }
  for (const e of src.emails ?? []) {
    const theirs = (!!email && e.fromEmail?.toLowerCase() === email) || isPerson(e.from, tokens);
    if (theirs) add(direct, { date: new Date(e.date).toISOString(), source: "email", from: contact.name, text: `${e.subject} — ${e.snippet}`, mine: false });
  }
  for (const e of src.events ?? []) {
    const p = (e.payload ?? {}) as { from?: string; fromEmail?: string; title?: string; body?: string; channel?: string };
    const from = String(p.from ?? "");
    const theirs = isPerson(from, tokens) || (!!email && String(p.fromEmail ?? "").toLowerCase() === email);
    const mine = !theirs && self.includes(from.toLowerCase()) && typeof p.channel === "string"
      && /^DM: /.test(p.channel) && isPerson(p.channel.slice(4), tokens);
    if ((!theirs && !mine) || !e.createdAt) continue;
    add(direct, { date: e.createdAt, source: e.source, from: theirs ? contact.name : "you", text: [p.title, p.body].filter(Boolean).join(" — "), mine });
  }

  const byDate = (a: Interaction, b: Interaction) => b.date.localeCompare(a.date);
  direct.sort(byDate); elsewhere.sort(byDate);
  // Direct contact is the relationship; channel posts only fill the gaps.
  const picked = direct.slice(0, max);
  picked.push(...elsewhere.slice(0, Math.max(0, max - picked.length)));
  return picked.sort(byDate);
}

/** Everything with this person over the long window — the baseline's input. Direct contact only. */
export function baselineInteractions(contact: ContactLike, src: InteractionSources, selfNames: string[], now = Date.now()): Interaction[] {
  return interactionsWith(contact, src, selfNames, now, BASELINE_DAYS, 400).filter((i) => !i.source.startsWith("slack #"));
}

// ── The read ────────────────────────────────────────────────────────────────

/** Exported for tests. */
export function sentimentPrompt(
  name: string, selfFirst: string, interactions: Interaction[], shifts: ToneObservation[],
  ctx: { facts?: string[]; baseline?: Baseline; correction?: { note: string; at: string } } = {},
): string {
  const facts = ctx.facts ?? [];
  const base = ctx.baseline;
  const baselineLine = base && base.n >= 5
    ? `How ${name} usually writes to ${selfFirst} (last 90 days, ${base.n} messages): about ${Math.round(base.medianWords)} words a message${base.shortShare >= 0.5 ? ", mostly one-liners" : ""}${base.medianReplyHours !== undefined ? `, replying in roughly ${base.medianReplyHours < 1 ? "under an hour" : base.medianReplyHours < 48 ? `${Math.round(base.medianReplyHours)} hours` : `${Math.round(base.medianReplyHours / 24)} days`}` : ""}. That is their normal. Terse, direct or unpadded is NOT cool if it is how they always write.`
    : `There is no long history with ${name} yet, so do not treat brevity or directness as a signal.`;
  return `Below are recent interactions between ${selfFirst} and ${name}, newest first. Judge the working relationship as it stands, against ${name}'s OWN usual style — never against a generic professional norm.

${baselineLine}
${facts.length ? `\nMeasured against their usual (these are facts, weigh them):\n${facts.map((f) => `- ${f}`).join("\n")}` : ""}
${ctx.correction ? `\n${selfFirst} corrected an earlier read of ${name} on ${ctx.correction.at.slice(0, 10)}: "${ctx.correction.note}". Respect this.` : ""}

- tone: how ${name} comes across towards ${selfFirst} now — one of "warm", "positive", "neutral", "cool", "strained". Most work messages are routine: when nothing stands out, say "neutral".
- trend: the last two weeks compared with before — "warming", "steady" or "cooling". Say "steady" unless the change is visible in the messages AND consistent with the measured facts. A change in words alone, with reply time and length as usual, is "steady".
- summary: one plain sentence a busy executive can act on. Describe behaviour ("shorter and slower than usual"), not inner states.
- evidence: up to 3 specific messages that show it, each {"date": "YYYY-MM-DD", "source": "slack|email|zoom", "note": "what was said or how, briefly"}.
Use only what the messages show. Do not invent context.
Judge the relationship with ${selfFirst} only: frustration, praise or criticism ${name} aims at someone else is not about ${selfFirst}. Newsletters and mass mailings say nothing about a relationship.

Interactions:
${interactions.map((i) => `- ${i.date.slice(0, 10)} [${i.source}] ${i.mine ? `${selfFirst} → ${name}` : name}: ${i.text}`).join("\n")}
${shifts.length ? `\nEarlier shifts Basil noted:\n${shifts.slice(-5).map((sh) => `- ${sh.date} ${sh.direction}: ${sh.summary}`).join("\n")}` : ""}

Respond with JSON only: {"tone": "...", "trend": "...", "summary": "...", "evidence": [...]}`;
}

const VerdictSchema = z.object({
  tone: z.enum(["warm", "positive", "neutral", "cool", "strained"]),
  trend: z.enum(["warming", "steady", "cooling"]),
  summary: z.string(),
  evidence: z.array(z.object({ date: z.string(), source: z.string(), note: z.string() })).max(5).optional().default([]),
});

export type SentimentJudge = (prompt: string) => Promise<z.infer<typeof VerdictSchema> | null>;

export function makeModelSentimentJudge(username: string): SentimentJudge {
  return async (prompt) => {
    const { text } = await generateTextSafe({
      model: getTextModel("fast"),
      maxOutputTokens: 500,
      system: "You read working relationships from message history. Be measured: routine is neutral, and change must be visible to count.",
      prompt,
    }, "fast", { username, feature: "contacts:sentiment" });
    const parsed = parseAndValidate(text, VerdictSchema, "[sentiment]");
    return parsed.ok ? parsed.data : null;
  };
}

type Store = Record<string, RelationshipSentiment>;

/** The Settings switch: on unless the user turned tone & sentiment off. */
export async function toneSentimentEnabled(username: string): Promise<boolean> {
  return (await getSettings(username)).toneSentiment !== false;
}

export async function listSentiment(username: string): Promise<Store> {
  return readUserStore<Store>(username, FILE, {});
}

/**
 * The read for one contact: stored when nothing newer has happened, otherwise
 * judged now and stored. Null when there is too little to read.
 */
/** Everything the reads draw on, fetched once for all contacts. Each source is best-effort. */
export async function loadInteractionSources(username: string): Promise<InteractionSources> {
  const [slack, emails, events] = await Promise.all([
    // The long window feeds each person's baseline; the read itself uses the last 30 days of it.
    getRecentSlackMessages(username, 2500, BASELINE_DAYS).catch((e) => { console.warn("[sentiment] slack unavailable:", e instanceof Error ? e.message : e); return []; }),
    getRecentEmails(username, 400, BASELINE_DAYS).catch((e) => { console.warn("[sentiment] gmail unavailable:", e instanceof Error ? e.message : e); return []; }),
    listEvents(username).catch(() => []),
  ]);
  return { slack, emails, events };
}

/**
 * The read for one contact. Stored when nothing newer has happened (or it was
 * read in the last day), otherwise judged now and stored. Null when there is
 * too little to read.
 */
export async function assessRelationship(
  username: string,
  contact: ContactLike,
  opts: { force?: boolean; sources?: InteractionSources; shifts?: ToneObservation[]; selfNames?: string[]; judge?: SentimentJudge; now?: number } = {},
): Promise<{ sentiment: RelationshipSentiment | null; interactions: number }> {
  const now = opts.now ?? Date.now();
  // A read from the last day stands — answer before gathering 30 days of Slack
  // and Gmail (opening a profile took seconds for a read already on file).
  if (!opts.force && !opts.sources) {
    const prev = (await listSentiment(username))[contact.id];
    if (prev && now - Date.parse(prev.computedAt) < REFRESH_MS) return { sentiment: prev, interactions: prev.basedOn };
  }
  const [sources, identity, overrides, stored] = await Promise.all([
    opts.sources ?? loadInteractionSources(username),
    opts.selfNames ? { names: opts.selfNames } : getSelfIdentity(username),
    opts.shifts ? null : getAllOverridesFromStore(username).catch(() => ({} as Record<string, { toneHistory?: ToneObservation[] }>)),
    listSentiment(username),
  ]);
  const shifts = opts.shifts ?? overrides?.[contact.id]?.toneHistory ?? [];
  const interactions = interactionsWith(contact, sources, identity.names, now);
  const prev = stored[contact.id] ?? null;
  if (interactions.length < MIN_INTERACTIONS) return { sentiment: prev, interactions: interactions.length };
  if (prev && !opts.force && (prev.latestAt >= interactions[0].date || now - Date.parse(prev.computedAt) < REFRESH_MS)) {
    return { sentiment: prev, interactions: interactions.length };
  }

  const first = identity.names[0]?.split(/\s+/)[0] ?? "";
  const selfFirst = first ? first[0].toUpperCase() + first.slice(1) : "the user";
  const long = baselineInteractions(contact, sources, identity.names, now);
  const baseline = baselineOf(long);
  const recent = recentSignals(interactions, baseline, now);
  const facts = describeSignals(baseline, recent);
  const confidence = confidenceOf(interactions);
  const correction = prev?.correction;
  const verdict = await (opts.judge ?? makeModelSentimentJudge(username))(sentimentPrompt(contact.name, selfFirst, interactions, shifts, { facts, baseline, correction }));
  if (!verdict) return { sentiment: prev, interactions: interactions.length };

  const sentiment: RelationshipSentiment = {
    contactId: contact.id,
    ...verdict,
    // An early read is a glimpse: no trend is shown from it.
    trend: confidence === "early" ? "steady" : verdict.trend,
    evidence: verdict.evidence.slice(0, 3),
    basedOn: interactions.length,
    latestAt: interactions[0].date,
    computedAt: new Date(now).toISOString(),
    confidence,
    facts,
    ...(correction ? { correction } : {}),
  };
  await updateUserStore<Store>(username, FILE, (cur) => ({ ...cur, [contact.id]: sentiment }), {});
  return { sentiment, interactions: interactions.length };
}

/**
 * "That's just how they write." Records the user's correction on the stored
 * read and re-reads with it in the prompt. The set of corrections is also the
 * calibration data for checking the reads (review §4.3).
 */
export async function correctRelationship(username: string, contact: ContactLike, note: string, now = Date.now()): Promise<RelationshipSentiment | null> {
  const correction = { note: note.trim().slice(0, 300), at: new Date(now).toISOString() };
  await updateUserStore<Store>(username, FILE, (cur) => {
    const prev = cur[contact.id];
    return prev ? { ...cur, [contact.id]: { ...prev, correction } } : cur;
  }, {});
  return (await assessRelationship(username, contact, { force: true, now })).sentiment;
}

/**
 * A read made before reads were baseline-relative (2026-10-21) has no
 * confidence and no measured facts — the card cannot show message length or
 * reply time. It is redone on the next refresh, even if nothing new arrived.
 */
export function isOldFormat(prev: { confidence?: unknown }): boolean {
  return !prev.confidence;
}

/** Re-read every relationship with something new (once a day each, bounded), and any old-format read. Returns how many were re-judged. */
export async function refreshStaleSentiment(username: string, max = 8, now = Date.now()): Promise<number> {
  if (!(await toneSentimentEnabled(username))) return 0;
  const [contacts, sources, identity, overrides, stored] = await Promise.all([
    listUserContacts(username), loadInteractionSources(username), getSelfIdentity(username),
    getAllOverridesFromStore(username).catch(() => ({} as Record<string, { toneHistory?: ToneObservation[] }>)),
    listSentiment(username),
  ]);
  const stale = contacts.filter((c) => {
    const ix = interactionsWith(c, sources, identity.names, now);
    const prev = stored[c.id];
    return ix.length >= MIN_INTERACTIONS && (!prev || isOldFormat(prev) || (prev.latestAt < ix[0].date && now - Date.parse(prev.computedAt) >= REFRESH_MS));
  }).slice(0, max);
  let n = 0;
  for (const c of stale) {
    try {
      const prev = stored[c.id];
      const r = await assessRelationship(username, c, { sources, selfNames: identity.names, shifts: overrides[c.id]?.toneHistory ?? [], now, force: !!prev && isOldFormat(prev) });
      if (r.sentiment?.computedAt === new Date(now).toISOString()) n++;
    } catch (e) {
      console.warn("[sentiment] could not read", c.id, e instanceof Error ? e.message : e);
    }
  }
  return n;
}
