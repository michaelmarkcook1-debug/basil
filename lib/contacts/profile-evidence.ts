/**
 * lib/contacts/profile-evidence.ts — numbered evidence, cited claims, and how
 * much each profile field actually rests on.
 *
 * docs/personality-profiles-review-2026-11-23.md, recommendations 1, 2 and 4:
 *
 *   1. Who wrote it. Evidence is split into what the person WROTE (the only
 *      thing a communication-style claim may rest on), what OTHERS said about
 *      them or around them (context), what the user STATED, and what Basil
 *      MEASURED.
 *   2. Every claim cites. Each item gets an id ([E7], [N1], [H2]); the model
 *      returns claims as { text, evidence: [ids] }. Code drops any claim whose
 *      citations don't exist, and any style claim that cites nothing they
 *      wrote, nothing measured and nothing the user stated.
 *   4. Strength is counted, never asked. A model's own confidence is badly
 *      calibrated, so each field is scored here from what its surviving claims
 *      cite: distinct items, distinct days, distinct channels. Too little, and
 *      the field says "Not enough evidence yet" instead of prose.
 *
 * Pure.
 */

export type EvidenceBy = "them" | "others" | "stated" | "measured";

/**
 * Where it was said (recommendation 6). People behave differently one-to-one,
 * in group channels and in meetings; a claim resting on one setting should say
 * so rather than generalise.
 */
export type Setting = "1:1" | "group" | "meeting";

export interface EvidenceItem {
  /** "E12" (messages), "N1" (the user's notes), "H3" (measured habits). */
  id: string;
  by: EvidenceBy;
  /** email | slack | zoom | whatsapp | teams | meeting | note | habit */
  channel: string;
  /** YYYY-MM-DD, when known. */
  date?: string;
  setting?: Setting;
  /** What the model sees. */
  text: string;
  /** Short label for the UI: "Email · 12 Nov · Re: Atos". */
  label: string;
}

export type ProfileField =
  | "personality" | "whatMakesThemTick" | "watchOut" | "recentActivity"
  // "How to work with them" (review 2026-11-23, recommendation 7): the fields
  // practitioners' user-manual templates converge on.
  | "howToLandIt" | "reachThem" | "decides" | "badNews" | "silence";
export const PROFILE_FIELDS: readonly ProfileField[] = ["personality", "whatMakesThemTick", "watchOut", "recentActivity", "howToLandIt", "reachThem", "decides", "badNews", "silence"];
/** The "how to work with them" fields — stored in the override layer, not on the contact record. */
export const WORKING_FIELDS = ["howToLandIt", "reachThem", "decides", "badNews", "silence"] as const;
export type WorkingField = (typeof WORKING_FIELDS)[number];
export type WorkingStyle = Partial<Record<WorkingField, string>>;

/** A second, independent read of one claim against only its cited evidence. */
export type CheckVerdict = "supported" | "unsupported" | "contradicted";
/** Key of a raw claim: "personality#2". */
export const claimKey = (field: ProfileField, index: number) => `${field}#${index}`;

export interface Claim { text: string; evidence: string[] }

export interface FieldStrength {
  level: "stated" | "strong" | "some" | "thin";
  items: number;
  days: number;
  channels: number;
}

/** What a finished profile carries beside its prose, for citations on hover. */
export interface ProfileEvidence {
  claims: Record<ProfileField, Claim[]>;
  /** Only the items some kept claim cites, trimmed for storage. */
  cited: Array<Pick<EvidenceItem, "id" | "by" | "channel" | "date" | "label"> & { excerpt: string }>;
  strength: Record<ProfileField, FieldStrength>;
  /** Claims the model made that code removed, and why — for audit, not shown as fact. */
  dropped: Array<{ field: ProfileField; text: string; why: DropReason }>;
  /** Whether the second check ran (false: it failed, and nothing was removed by it). */
  checked?: boolean;
}

export type DropReason = "no-valid-citation" | "style-without-their-words" | "checker-unsupported" | "checker-contradicted";

export const NOT_ENOUGH = "Not enough evidence yet.";

/** Thresholds: below either, a field is "thin". */
export const MIN_ITEMS = 3;
export const MIN_SPAN_DAYS = 14;

const day = (iso?: string) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const shortDate = (d?: string) => {
  if (!d) return "";
  const t = Date.parse(`${d}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : d;
};
const CHANNEL_LABEL: Record<string, string> = {
  email: "Email", slack: "Slack", zoom: "Zoom summary", whatsapp: "WhatsApp", teams: "Teams", meeting: "Meeting", note: "Your note", habit: "Measured",
};

export interface RawEvidence {
  channel: string;
  by: Exclude<EvidenceBy, "stated" | "measured">;
  date?: string;
  setting?: Setting;
  text: string;
  /** Subject / channel name for the label. */
  title?: string;
}

/** Number everything. Notes first (N), measured habits (H), then messages (E), newest first. */
export function numberEvidence(input: { notes: string[]; habits: string[]; messages: RawEvidence[] }): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  input.notes.filter((n) => n.trim()).forEach((n, i) => out.push({ id: `N${i + 1}`, by: "stated", channel: "note", text: n.trim(), label: "Your note" }));
  input.habits.filter((h) => h.trim()).forEach((h, i) => out.push({ id: `H${i + 1}`, by: "measured", channel: "habit", text: h.trim(), label: `Measured · ${clip(h.trim(), 60)}` }));
  const msgs = [...input.messages].sort((a, b) => (day(b.date) ?? "").localeCompare(day(a.date) ?? ""));
  msgs.forEach((m, i) => {
    const d = day(m.date);
    out.push({
      id: `E${i + 1}`,
      by: m.by,
      channel: m.channel,
      ...(d ? { date: d } : {}),
      ...(m.setting ? { setting: m.setting } : {}),
      text: m.text,
      label: [CHANNEL_LABEL[m.channel] ?? m.channel, m.setting, shortDate(d), m.title ? clip(m.title, 50) : ""].filter(Boolean).join(" · "),
    });
  });
  return out;
}

/** The evidence blocks of the prompt, grouped by who said it. */
export function evidenceBlocks(items: readonly EvidenceItem[], selfFirst: string, name: string): string {
  const line = (e: EvidenceItem) => `[${e.id}]${e.date ? ` ${e.date}` : ""}${e.setting ? ` (${e.setting})` : ""} ${e.text}`;
  const group = (by: EvidenceBy) => items.filter((e) => e.by === by).map(line).join("\n");
  const sec = (title: string, body: string) => (body ? `## ${title}\n${body}\n\n` : "");
  return [
    sec(`STATED BY ${selfFirst.toUpperCase()} — facts; they outrank anything inferred`, group("stated")),
    sec("MEASURED — computed from message history; facts, not guesses", group("measured")),
    sec(`WRITTEN BY ${name.toUpperCase()} — the only evidence of how they communicate`, group("them")),
    sec(`SAID BY OTHERS, OR ABOUT ${name.toUpperCase()} — context only, never evidence of their style`, group("others")),
  ].join("");
}

/** A field's strength from the items its claims cite. Exported for tests. */
export function strengthOf(cited: readonly EvidenceItem[]): FieldStrength {
  const unique = [...new Map(cited.map((e) => [e.id, e])).values()];
  const days = [...new Set(unique.map((e) => e.date).filter((d): d is string => !!d))].sort();
  const channels = new Set(unique.filter((e) => e.by !== "measured").map((e) => e.channel)).size;
  const spanDays = days.length >= 2 ? Math.round((Date.parse(days[days.length - 1]) - Date.parse(days[0])) / 86_400_000) : 0;
  const base = { items: unique.length, days: days.length, channels };
  if (unique.some((e) => e.by === "stated")) return { level: "stated", ...base };
  const messages = unique.filter((e) => e.by === "them" || e.by === "others").length;
  // Measured habits are computed over 90 days of history: they carry their own span.
  const measured = unique.some((e) => e.by === "measured");
  // A measured habit summarises at least five messages over 90 days: it weighs
  // as much as the minimum on its own.
  const weight = unique.length + unique.filter((e) => e.by === "measured").length * (MIN_ITEMS - 1);
  if (weight < MIN_ITEMS || (!measured && spanDays < MIN_SPAN_DAYS)) return { level: "thin", ...base };
  if (messages >= 6 && days.length >= 4 && channels >= 2) return { level: "strong", ...base };
  return { level: "some", ...base };
}

const STYLE_BASIS: ReadonlySet<EvidenceBy> = new Set(["them", "measured", "stated"]);
/** Fields about how they communicate and respond — never from others' descriptions alone. */
const STYLE_FIELDS: ReadonlySet<ProfileField> = new Set<ProfileField>(["personality", "reachThem", "silence"]);

type RawClaims = Partial<Record<ProfileField, Array<{ text?: unknown; evidence?: unknown }>>>;

const normId = (x: unknown) => String(x).replace(/[[\]\s]/g, "").toUpperCase();

/** Claims with at least one real citation — what the second check reads. Exported for tests. */
export function citedClaims(raw: RawClaims, items: readonly EvidenceItem[]): Array<{ key: string; field: ProfileField; text: string; evidence: EvidenceItem[] }> {
  const byId = new Map(items.map((e) => [e.id, e]));
  const out: Array<{ key: string; field: ProfileField; text: string; evidence: EvidenceItem[] }> = [];
  for (const field of PROFILE_FIELDS) {
    (Array.isArray(raw[field]) ? raw[field]! : []).forEach((c, i) => {
      const t = typeof c?.text === "string" ? c.text.trim() : "";
      const ev = [...new Set((Array.isArray(c?.evidence) ? c.evidence : []).map(normId))].map((id) => byId.get(id)).filter((e): e is EvidenceItem => !!e);
      if (t && ev.length) out.push({ key: claimKey(field, i), field, text: t, evidence: ev });
    });
  }
  return out;
}

/**
 * Check the model's claims against the evidence (and, when given, the second
 * check's verdicts), score each field, and write the prose. Exported for tests.
 */
export function finalizeClaims(
  raw: RawClaims,
  items: readonly EvidenceItem[],
  checks?: ReadonlyMap<string, CheckVerdict> | null,
): { text: Record<ProfileField, string>; activitySource: string; evidence: ProfileEvidence } {
  const byId = new Map(items.map((e) => [e.id, e]));
  const claims = {} as Record<ProfileField, Claim[]>;
  const strength = {} as Record<ProfileField, FieldStrength>;
  const text = {} as Record<ProfileField, string>;
  const dropped: ProfileEvidence["dropped"] = [];
  const citedIds = new Set<string>();

  for (const field of PROFILE_FIELDS) {
    const kept: Claim[] = [];
    const list = Array.isArray(raw[field]) ? raw[field]! : [];
    for (let index = 0; index < list.length; index++) {
      const c = list[index];
      const t = typeof c?.text === "string" ? c.text.trim() : "";
      if (!t) continue;
      const ids = (Array.isArray(c.evidence) ? c.evidence : [])
        .map(normId)
        .filter((id, i, a) => byId.has(id) && a.indexOf(id) === i);
      if (ids.length === 0) { dropped.push({ field, text: t, why: "no-valid-citation" }); continue; }
      // How someone communicates can only rest on what they wrote, what was
      // measured, or what the user said — never on others' descriptions.
      if (STYLE_FIELDS.has(field) && !ids.some((id) => STYLE_BASIS.has(byId.get(id)!.by))) {
        dropped.push({ field, text: t, why: "style-without-their-words" });
        continue;
      }
      // The second check read this claim against only its sources and found
      // them not to say it (or to say the opposite).
      const verdict = checks?.get(claimKey(field, index));
      if (verdict === "unsupported" || verdict === "contradicted") {
        dropped.push({ field, text: t, why: verdict === "unsupported" ? "checker-unsupported" : "checker-contradicted" });
        continue;
      }
      kept.push({ text: t, evidence: ids });
    }
    const cited = kept.flatMap((c) => c.evidence.map((id) => byId.get(id)!));
    const s = strengthOf(cited);
    strength[field] = s;
    // Recent activity is a list of dated observations: one is enough to show.
    const thin = field === "recentActivity" ? kept.length === 0 : s.level === "thin";
    if (thin) {
      claims[field] = [];
      text[field] = NOT_ENOUGH;
    } else {
      claims[field] = kept;
      text[field] = kept.map((c) => c.text).join(field === "recentActivity" ? "\n" : " ");
      for (const c of kept) for (const id of c.evidence) citedIds.add(id);
    }
  }

  const citedItems = items.filter((e) => citedIds.has(e.id));
  const channelNames = [...new Set(citedItems.map((e) => CHANNEL_LABEL[e.channel] ?? e.channel))];
  return {
    text,
    activitySource: channelNames.length ? channelNames.join(", ") : "No cited sources",
    evidence: {
      claims,
      cited: citedItems.map((e) => ({ id: e.id, by: e.by, channel: e.channel, ...(e.date ? { date: e.date } : {}), label: e.label, excerpt: clip(e.text.replace(/\s+/g, " "), 280) })),
      strength,
      dropped,
      ...(checks !== undefined ? { checked: checks !== null } : {}),
    },
  };
}

// ── Measured channel and hours ───────────────────────────────────────────────

/**
 * Where and when they write, as plain lines of measured evidence: the channel
 * mix of their own messages, and the three-hour stretch most of them fall in
 * (the user's time zone), with how much falls on weekdays. Nothing under eight
 * messages — too few to call a habit. Pure.
 */
export function channelAndHourHabits(msgs: ReadonlyArray<{ channel: string; at: string }>, timeZone: string): string[] {
  const valid = msgs.filter((m) => Number.isFinite(Date.parse(m.at)));
  if (valid.length < 8) return [];
  const out: string[] = [];
  const counts = new Map<string, number>();
  for (const m of valid) counts.set(m.channel, (counts.get(m.channel) ?? 0) + 1);
  const mix = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ch, n]) => `${Math.round((n / valid.length) * 100)}% ${CHANNEL_LABEL[ch] ?? ch}`);
  out.push(`Of their ${valid.length} messages in 90 days: ${mix.join(", ")}.`);
  const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" });
  const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" });
  const hours = new Array(24).fill(0) as number[];
  let weekday = 0;
  for (const m of valid) {
    const d = new Date(m.at);
    hours[Number(hourFmt.format(d)) % 24]++;
    if (!["Sat", "Sun"].includes(dayFmt.format(d))) weekday++;
  }
  let best = 0, bestStart = 0;
  for (let h = 0; h < 24; h++) {
    const n = hours[h] + hours[(h + 1) % 24] + hours[(h + 2) % 24];
    if (n > best) { best = n; bestStart = h; }
  }
  const pad = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  out.push(`${Math.round((best / valid.length) * 100)}% of them are sent between ${pad(bestStart)} and ${pad(bestStart + 3)} (${timeZone}); ${Math.round((weekday / valid.length) * 100)}% on weekdays.`);
  return out;
}

// ── Both sides, and the setting (recommendations 3 and 6) ────────────────────

/** One message in a conversation, oldest first, as the exchange builder needs it. */
export interface ConvoMessage { fromUser: boolean; fromThem: boolean; at: string; text: string }

const ASK_RE = /\?|\b(can you|could you|would you|will you|please|need you to|let me know|send me|are you able|any chance)\b/i;
/** A message that asks something of its reader. Pure. */
export const isAsk = (text: string) => ASK_RE.test(text);

function gap(fromIso: string, toIso: string): string {
  const h = (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
  if (!Number.isFinite(h) || h < 0) return "later";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min later`;
  if (h < 48) return `${Math.round(h)} h later`;
  return `${Math.round(h / 24)} days later`;
}

export interface Exchange {
  askedAt: string;
  ask: string;
  /** Their reply, if they answered before the user wrote again (or within 7 days). */
  reply?: { at: string; text: string };
}

/**
 * The user's asks in a one-to-one conversation, each with what the person did
 * next: their reply and how long it took, or nothing before the user wrote
 * again. "How they handle your asks" cannot be read from their side alone. Pure.
 */
export function exchangesIn(convo: readonly ConvoMessage[]): Exchange[] {
  const msgs = [...convo].filter((m) => Number.isFinite(Date.parse(m.at))).sort((a, b) => a.at.localeCompare(b.at));
  const out: Exchange[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m.fromUser || !isAsk(m.text)) continue;
    // Consecutive messages from the user count as one ask: answer the last of them.
    if (msgs[i + 1]?.fromUser) continue;
    const next = msgs[i + 1];
    const within = next && Date.parse(next.at) - Date.parse(m.at) <= 7 * 86_400_000;
    out.push({ askedAt: m.at, ask: m.text, ...(next?.fromThem && within ? { reply: { at: next.at, text: next.text } } : {}) });
  }
  return out;
}

/** An exchange as evidence: what was asked, and what they did. Pure. */
export function exchangeEvidence(x: Exchange, channel: string, selfFirst: string, name: string): RawEvidence {
  const first = name.split(/\s+/)[0] || name;
  const text = x.reply
    ? `${selfFirst} asked: "${clip(x.ask, 280)}"\n→ ${first} replied ${gap(x.askedAt, x.reply.at)}: "${clip(x.reply.text, 400)}"`
    : `${selfFirst} asked: "${clip(x.ask, 280)}"\n→ No reply from ${first} before ${selfFirst} wrote again (or within a week).`;
  return { channel, by: "them", setting: "1:1", date: (x.reply?.at ?? x.askedAt).slice(0, 10), title: "Your ask", text };
}

/** How they handle the user's asks, as a measured line (four asks at least). Pure. */
export function askHabits(xs: readonly Exchange[]): string[] {
  if (xs.length < 4) return [];
  const answered = xs.filter((x) => x.reply);
  const hours = answered.map((x) => (Date.parse(x.reply!.at) - Date.parse(x.askedAt)) / 3_600_000).filter((h) => h >= 0).sort((a, b) => a - b);
  const med = hours.length ? hours[Math.floor(hours.length / 2)] : undefined;
  const when = med === undefined ? "" : med < 1 ? ", usually within the hour" : med < 48 ? `, typically ${Math.round(med)} h later` : `, typically ${Math.round(med / 24)} days later`;
  return [`Of ${xs.length} questions or requests you sent them one-to-one, they answered ${answered.length}${when}; ${xs.length - answered.length} got no reply before you wrote again.`];
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** Their own messages, setting by setting (four at least per setting). Pure. */
export function settingHabits(msgs: ReadonlyArray<{ setting?: Setting; text: string }>): string[] {
  const label: Record<Setting, string> = { "1:1": "One-to-one (DMs, direct email)", group: "In group channels and group email", meeting: "In meetings" };
  const out: string[] = [];
  for (const s of ["1:1", "group"] as const) {
    const xs = msgs.filter((m) => m.setting === s);
    if (xs.length < 4) continue;
    const w = xs.map((m) => words(m.text)).sort((a, b) => a - b);
    const q = xs.filter((m) => /\?/.test(m.text)).length;
    const asks = xs.filter((m) => isAsk(m.text)).length;
    out.push(`${label[s]}: ${xs.length} messages from them, median ${w[Math.floor(w.length / 2)]} words; ${Math.round((q / xs.length) * 100)}% ask a question, ${Math.round((asks / xs.length) * 100)}% ask for something.`);
  }
  return out;
}
