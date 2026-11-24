/**
 * lib/psychology/followup-advice.ts — "how to follow up" for one person or
 * deal: when, which channel, what to say, what to do, what to avoid.
 *
 * Overlays sales psychology (lib/psychology/playbook) on everything Basil
 * knows: the last interactions and meeting notes (Pipedrive), the person's
 * profile (how to land it, how they decide, how to reach them, recent tone),
 * the firm and the deal. One fast-tier call, only when the user asks; the
 * answer is kept for the day so asking again is free.
 */
import "server-only";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTaskSystemPrompt } from "@/lib/ai/system-prompt";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getAllOverridesFromStore } from "@/lib/contacts/overrides-store";
import { followupState } from "@/lib/pipedrive/followups-server";
import { accountBlock } from "@/lib/pipedrive/context";
import { objectionsIn, personaOf } from "@/lib/pipedrive/collateral";
import { meetingNotes } from "@/lib/pipedrive/context";
import { principlesFor, principleLines, timingFor, ETHICS, type Situation, type Timing } from "@/lib/psychology/playbook";
import type { FollowupSuggestion } from "@/lib/pipedrive/followups";

export interface FollowupAdvice {
  timing: Timing;
  channel: string;
  openingLine: string;
  whatToSay: string[];
  whatToDo: string[];
  avoid: string[];
  principles: Array<{ name: string; how: string }>;
  /** What the advice rests on, so the user can judge it. */
  basedOn: string[];
}

const FILE = "followup-advice.json";
type Cache = Record<string, { day: string; advice: FollowupAdvice }>;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Lenient JSON object parse. */
function parseAdvice(text: string): Omit<FollowupAdvice, "timing" | "basedOn"> | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : []);
    const principles = Array.isArray(j.principles)
      ? (j.principles as Array<Record<string, unknown>>).filter((p) => typeof p?.name === "string").slice(0, 4).map((p) => ({ name: String(p.name), how: String(p.how ?? "") }))
      : [];
    return {
      channel: typeof j.channel === "string" ? j.channel : "",
      openingLine: typeof j.openingLine === "string" ? j.openingLine : "",
      whatToSay: arr(j.whatToSay), whatToDo: arr(j.whatToDo), avoid: arr(j.avoid), principles,
    };
  } catch {
    // ci-ok: an unparseable answer is reported as "couldn't produce advice"
    return null;
  }
}

/** Advice for a Pipedrive follow-up suggestion (by id). */
export async function adviceForFollowup(username: string, id: string, opts: { fresh?: boolean } = {}): Promise<FollowupAdvice> {
  const st = await followupState(username, { storedOnly: true });
  const sug = st.suggestions.find((s) => s.id === id);
  if (!sug) throw new Error("That follow-up is no longer suggested.");
  const cache = await readUserStore<Cache>(username, FILE, {}, { fresh: true }).catch(() => ({} as Cache)); // ci-ok: no cache → compute
  if (!opts.fresh && cache[id]?.day === st.today) return cache[id].advice;

  const snap = st.snapshot;
  const [contacts, overrides] = await Promise.all([
    listUserContacts(username).catch((e) => { console.warn("[followup-advice] contacts unreadable:", e instanceof Error ? e.message : e); return []; }),
    getAllOverridesFromStore(username).catch((e) => { console.warn("[followup-advice] profiles unreadable:", e instanceof Error ? e.message : e); return {}; }),
  ]);
  const contact = contacts.find((c) => (sug.contactEmail && c.email?.toLowerCase() === sug.contactEmail) || (sug.contactName && c.name.toLowerCase() === sug.contactName.toLowerCase()));
  const ov = contact ? (overrides as Record<string, { personality?: string; whatMakesThemTick?: string; watchOut?: string; workingStyle?: Record<string, string>; toneHistory?: Array<{ date: string; direction: string; summary: string }> }>)[contact.id] : undefined;
  const tone = ov?.toneHistory?.slice(-3).reverse();
  const lastTone = tone?.[0]?.direction as "warming" | "cooling" | "neutral" | undefined;

  // Interaction history and topics from the CRM.
  const person = snap?.persons.find((p) => p.id === sug.personId);
  const account = snap ? accountBlock(snap, { personIds: sug.personId !== null ? [sug.personId] : [], names: sug.orgName ? [sug.orgName] : [] }, st.today, { maxNotes: 5, maxActivities: 5, maxMeetingNotes: 4, meetingNoteChars: 900 }) : "";
  const related = snap ? {
    meetings: meetingNotes({ activities: snap.activities.filter((a) => (sug.dealId !== null && a.dealId === sug.dealId) || (sug.personId !== null && a.personId === sug.personId)) }),
    notes: snap.notes.filter((n) => (sug.dealId !== null && n.dealId === sug.dealId) || (sug.personId !== null && n.personId === sug.personId)),
  } : { meetings: [], notes: [] };
  const objections = objectionsIn(related).map((o) => o.theme);
  const persona = personaOf(person?.jobTitle ?? contact?.title);

  const situation: Situation = sug.kind;
  const timing = timingFor({ situation, today: st.today, daysSinceTouch: Math.max(0, Math.round((Date.parse(`${st.today}T00:00:00Z`) - Date.parse(`${sug.since}T00:00:00Z`)) / 86_400_000)), tone: lastTone });
  const principles = principlesFor({ situation, objections, personas: persona ? [persona] : [], tone: lastTone });

  const profile = [
    ov?.personality && `Personality: ${clip(ov.personality, 400)}`,
    ov?.whatMakesThemTick && `What makes them tick: ${clip(ov.whatMakesThemTick, 300)}`,
    ov?.watchOut && `Watch out: ${clip(ov.watchOut, 300)}`,
    ...Object.entries(ov?.workingStyle ?? {}).filter(([, v]) => v && !/not enough evidence/i.test(v)).map(([k, v]) => `${k}: ${clip(v, 250)}`),
    tone?.length ? `Recent tone: ${tone.map((t) => `${t.date} ${t.direction} — ${t.summary}`).join(" | ")}` : "",
  ].filter(Boolean).join("\n");

  const prompt = `Advise on ONE follow-up. Be specific to this person, firm and moment.

The follow-up: ${sug.title}
Why now: ${sug.why}
${sug.dealTitle ? `Deal: "${sug.dealTitle}"${sug.stage ? `, ${sug.stage}` : ""}${sug.value ? `, ${sug.value}` : ""}` : ""}
Contact: ${sug.contactName ?? "(no contact recorded)"}${person?.jobTitle ? `, ${person.jobTitle}` : ""}${sug.orgName ? ` at ${sug.orgName}` : ""}${persona ? ` (likely ${persona} buyer)` : ""}
Timing Basil has worked out: ${timing.label} — ${timing.why} Best time: ${timing.bestTime}.
${objections.length ? `Objection themes in the notes: ${objections.join(", ")}.` : ""}

How this person works (from their profile — style guidance, not fact):
${profile || "No profile yet."}

What has happened (CRM: deals, meeting notes, notes, activities):
${account || "No CRM history."}

Sales psychology that fits — use only where the evidence supports it:
${principleLines(principles)}

${ETHICS}

Return ONLY JSON:
{"channel":"email|call|LinkedIn|Slack|in person — one, with a reason in a few words",
 "openingLine":"the first sentence the user could send or say, in plain British English, referencing something real from the history",
 "whatToSay":["3–5 short points to make, each tied to something they said or care about"],
 "whatToDo":["1–3 concrete actions beyond the message — attach X, loop in Y, propose a 20-minute slot"],
 "avoid":["1–3 things not to do with THIS person"],
 "principles":[{"name":"principle name","how":"how it applies here, one sentence"}]}
Never invent facts, numbers, deadlines, quotes or references that are not in the history above.`;

  const system = await getTaskSystemPrompt(username, undefined, { memories: 6, personasFor: sug.contactName ?? "", maxPersonas: 1 }).catch(() => "You are an executive assistant."); // ci-ok: a bare system prompt still works
  const r = await generateTextSafe({ system, prompt, maxOutputTokens: 1_400 }, "fast", { username, feature: "followup-advice" });
  const parsed = parseAdvice(r.text);
  if (!parsed) throw new Error("Basil couldn't produce advice just now. Try again.");
  const advice: FollowupAdvice = {
    timing,
    ...parsed,
    basedOn: [
      account ? "Pipedrive history and meeting notes" : "",
      profile ? `${sug.contactName ?? "Their"} profile` : "",
      tone?.length ? "recent tone" : "",
      objections.length ? `objections in the notes (${objections.join(", ")})` : "",
    ].filter(Boolean),
  };
  await updateUserStore<Cache>(username, FILE, (cur) => {
    const next: Cache = {};
    for (const [k, v] of Object.entries(cur ?? {})) if (v.day >= st.today) next[k] = v;
    next[id] = { day: st.today, advice };
    return next;
  }, {}, { allowShrink: true }).catch((e) => console.warn("[followup-advice] not cached:", e instanceof Error ? e.message : e));
  return advice;
}

/** Find the suggestion for a person / company / deal named in chat. */
export async function adviceForQuery(username: string, query: string): Promise<{ suggestion: FollowupSuggestion; advice: FollowupAdvice } | null> {
  const st = await followupState(username, { storedOnly: true });
  const q = query.trim().toLowerCase();
  const sug = st.suggestions.find((s) => [s.contactName, s.contactEmail, s.orgName, s.dealTitle].some((x) => x?.toLowerCase().includes(q)));
  if (!sug) return null;
  return { suggestion: sug, advice: await adviceForFollowup(username, sug.id) };
}
