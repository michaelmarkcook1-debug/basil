/**
 * lib/psychology/playbook.ts — sales psychology for follow-ups and meeting
 * prep, applied ethically. Pure.
 *
 * Michael, 2026-11-24: "use /sales-psychology and overlay this with all
 * available context on the last few interactions, topics of conversation,
 * individual and firm to suggest follow up suggestions (how long to wait, what
 * to say, do etc.) and for meeting prep. Also use this skill in meeting prep
 * to help users sell themselves and ideas/projects."
 *
 * Three parts:
 *   - PRINCIPLES: the models that matter in an exec's follow-ups and meetings,
 *     each with how to use it and the line not to cross;
 *   - timing: when to follow up, from the situation and what is measured;
 *   - selection: which principles fit this person, this firm, this moment.
 *
 * Ethics are part of the output, not an afterthought: no invented urgency,
 * no false scarcity, no pressure the other side would resent later. Basil
 * helps the user communicate value and read people; it never manipulates.
 */

export type PrincipleId =
  | "reciprocity" | "commitment" | "loss-aversion" | "status-quo" | "social-proof" | "authority" | "liking"
  | "paradox-of-choice" | "present-bias" | "foot-in-door" | "endowment" | "attribution" | "mere-exposure"
  | "reactive-devaluation" | "iceberg" | "consensus" | "anchoring" | "deadline" | "risk-reduction" | "decision-fatigue";

export interface Principle { id: PrincipleId; name: string; use: string; guard: string }

export const PRINCIPLES: Record<PrincipleId, Principle> = {
  reciprocity: { id: "reciprocity", name: "Reciprocity", use: "Give something useful first — an insight, an intro, the resource you promised — before asking for anything.", guard: "Give real value; a 'gift' that is a sales pitch in disguise breaks trust." },
  commitment: { id: "commitment", name: "Commitment & consistency", use: "Play back what they said and agreed, in their words, and anchor the next small step to it.", guard: "Only quote what they actually said or agreed; never put words in their mouth." },
  "loss-aversion": { id: "loss-aversion", name: "Loss aversion", use: "Frame the real cost of waiting (time, money, risk) — losses weigh about twice as much as gains.", guard: "Only costs that exist in their situation; never invent a deadline or a loss." },
  "status-quo": { id: "status-quo", name: "Status quo bias", use: "Acknowledge their current way works for them, then make dissatisfaction × vision × first step outweigh the effort of change.", guard: "Respect a genuine 'not now'; don't belittle what they have." },
  "social-proof": { id: "social-proof", name: "Social proof", use: "Point to similar firms or peers who made the move, with a concrete example.", guard: "Real, permissioned references only; no vague 'everyone is doing this'." },
  authority: { id: "authority", name: "Authority", use: "Lead with relevant expertise or a credible source early, briefly.", guard: "Claim only experience and credentials you have." },
  liking: { id: "liking", name: "Liking & similarity", use: "Reference genuine common ground and match their style and pace.", guard: "Genuine only; flattery reads as manipulation." },
  "paradox-of-choice": { id: "paradox-of-choice", name: "Paradox of choice", use: "Recommend one option with a reason, not a menu.", guard: "Keep the alternatives available if they ask." },
  "present-bias": { id: "present-bias", name: "Present bias", use: "Lead with the quick win they get in the first weeks, not the 18-month payoff.", guard: "Only quick wins you can deliver." },
  "foot-in-door": { id: "foot-in-door", name: "Small first step", use: "Ask for the smallest next yes — 20 minutes, one stakeholder intro, a pilot — not the big decision.", guard: "Be open about where the steps lead." },
  endowment: { id: "endowment", name: "Endowment", use: "Let them try it — a pilot, a sample, a draft with their name on it — so it already feels theirs.", guard: "Make the trial honest and easy to leave." },
  attribution: { id: "attribution", name: "Fundamental attribution error", use: "Assume silence is circumstances (busy, priorities, timing), not disinterest — and make replying easy.", guard: "Don't guilt-trip ('just following up again…')." },
  "mere-exposure": { id: "mere-exposure", name: "Mere exposure", use: "Stay visible with light, useful touches across channels, so you are familiar when the moment comes.", guard: "Spaced out and useful; volume becomes spam." },
  "reactive-devaluation": { id: "reactive-devaluation", name: "Reactive devaluation", use: "Ideas land better when they help shape them: ask questions that lead them to the solution, and credit their input.", guard: "Don't fake-ask; be ready for their idea to be better." },
  iceberg: { id: "iceberg", name: "The iceberg of motivation", use: "Ask 'why' and 'what else' to reach the real driver — looking good to their boss, avoiding blame, a target.", guard: "Curiosity, not interrogation." },
  consensus: { id: "consensus", name: "Consensus building", use: "Arm your champion: give them the one-page case and offer to meet the others who decide.", guard: "Don't go around your champion without telling them." },
  anchoring: { id: "anchoring", name: "Anchoring", use: "Show the value or the cost of the problem before the price, so the price is judged against it.", guard: "Real numbers only." },
  deadline: { id: "deadline", name: "Mutual deadlines", use: "Agree a date tied to THEIR goal ('to be live before January hiring…') and hold to it.", guard: "Never a fake deadline; a deadline you don't keep loses its force." },
  "risk-reduction": { id: "risk-reduction", name: "Risk reduction", use: "Address the fear behind the objection — a pilot, references, a guarantee, a phased start.", guard: "Promise only what you can stand behind." },
  "decision-fatigue": { id: "decision-fatigue", name: "Decision fatigue", use: "Put asks and decisions early in their day and early in the meeting; late-day asks default to 'let me think'.", guard: "None — just timing." },
};

// ── Timing ───────────────────────────────────────────────────────────────────

export type Situation =
  | "after-meeting" | "past-close" | "going-cold" | "no-next-step"
  | "awaiting-their-reply" | "they-are-waiting" | "after-proposal";

export interface TimingInput {
  situation: Situation;
  today: string;
  /** Days since the last two-way contact (meeting, call, email either way). */
  daysSinceTouch?: number;
  /** Measured: their median hours to reply to the user. */
  theirReplyHours?: number;
  /** How many follow-ups the user has sent since their last reply. */
  unansweredNudges?: number;
  /** Recent tone toward the user, from tone history. */
  tone?: "warming" | "cooling" | "neutral";
}

export interface Timing {
  /** YYYY-MM-DD to send on (today or later, a working day). */
  sendOn: string;
  label: string;
  why: string;
  /** Prefer Tue–Thu mornings for asks. */
  bestTime: string;
}

const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
export function addWorkingDays(ymd: string, n: number): string {
  let d = new Date(`${ymd}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    d = new Date(d.getTime() + 86_400_000);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  // Never land on a weekend.
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 86_400_000);
  return d.toISOString().slice(0, 10);
}
const nice = (ymd: string, today: string) =>
  ymd === today ? "today" : new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/**
 * When to follow up. Fresh is best after a meeting; otherwise give them room
 * proportional to how they actually reply, and stop nudging without new value.
 */
export function timingFor(t: TimingInput): Timing {
  const today = t.today;
  const after = (n: number) => addWorkingDays(today, n);
  const replyDays = t.theirReplyHours !== undefined ? Math.max(1, Math.ceil((t.theirReplyHours * 2) / 24)) : undefined;
  let sendOn = today;
  let why = "";
  switch (t.situation) {
    case "after-meeting":
      sendOn = today;
      why = (t.daysSinceTouch ?? 0) <= 1
        ? "Within 24 hours of a meeting the conversation is fresh and agreements are easiest to confirm (commitment)."
        : "It's already later than ideal after a meeting — send today, and lead with the agreed next step.";
      break;
    case "they-are-waiting":
      sendOn = today;
      why = "They are waiting on you; speed is the courtesy.";
      break;
    case "after-proposal":
      sendOn = after(replyDays ? Math.max(3, replyDays) : 3);
      why = `Give them room to read and discuss internally — about ${replyDays ? `twice their usual reply time` : "three working days"} — then check in with something useful, not "any news?".`;
      break;
    case "awaiting-their-reply": {
      const n = t.unansweredNudges ?? 0;
      const gap = n === 0 ? (replyDays ? Math.max(2, replyDays) : 3) : n === 1 ? 5 : 7;
      sendOn = after(gap);
      why = n >= 2
        ? "Two follow-ups without a reply: the next one should close the loop politely or bring genuinely new value — not a third nudge."
        : replyDays
          ? `They usually reply in about ${Math.round(t.theirReplyHours!)}h; waiting roughly twice that before nudging respects their pace.`
          : "No measured reply habit yet; a few working days is a respectful gap.";
      break;
    }
    case "going-cold":
      sendOn = t.tone === "cooling" ? after(1) : today;
      why = t.tone === "cooling"
        ? "Their tone has been cooling: don't chase today — send one useful, no-ask touch tomorrow, and assume circumstances, not disinterest."
        : "Gone quiet: re-open with value, not a 'just checking in'.";
      break;
    case "past-close":
      sendOn = today;
      why = "Past the expected close: an honest, direct check-in about timing beats waiting — and it lets you re-forecast.";
      break;
    case "no-next-step":
      sendOn = after(1);
      why = "An open deal with nothing planned drifts; propose one concrete next step within a couple of days.";
      break;
  }
  // Asks land worse on Monday mornings and Friday afternoons; nudge to Tue–Thu.
  const d = dow(sendOn);
  const bestTime = d === 1 ? "after 10:00 their time (Monday mornings are inbox triage)" : d === 5 ? "before 13:00 their time (Friday afternoons slip to next week)" : "mid-morning their time, Tue–Thu if you have the choice";
  return { sendOn, label: sendOn === today ? "Today" : `Wait until ${nice(sendOn, today)}`, why, bestTime };
}

// ── Choosing principles ──────────────────────────────────────────────────────

export type ObjectionTheme = "price" | "timing" | "competition" | "authority" | "status-quo" | "technical";
export type Persona = "economic" | "technical" | "champion" | "end-user";

export interface SelectionInput {
  situation: Situation | "meeting-external" | "meeting-internal-pitch" | "meeting-relationship";
  objections?: ObjectionTheme[];
  personas?: Persona[];
  tone?: "warming" | "cooling" | "neutral";
  hasChampionOnly?: boolean;
}

/** The 3–5 principles that fit, strongest first. */
export function principlesFor(s: SelectionInput): Principle[] {
  const ids: PrincipleId[] = [];
  const add = (...xs: PrincipleId[]) => { for (const x of xs) if (!ids.includes(x)) ids.push(x); };
  switch (s.situation) {
    case "after-meeting": add("commitment", "reciprocity", "foot-in-door"); break;
    case "after-proposal": add("anchoring", "paradox-of-choice", "deadline"); break;
    case "past-close": add("deadline", "status-quo", "attribution"); break;
    case "going-cold": add("attribution", "reciprocity", "mere-exposure"); break;
    case "no-next-step": add("foot-in-door", "commitment"); break;
    case "awaiting-their-reply": add("attribution", "reciprocity"); break;
    case "they-are-waiting": add("liking", "commitment"); break;
    case "meeting-external": add("iceberg", "commitment", "decision-fatigue"); break;
    case "meeting-internal-pitch": add("reactive-devaluation", "loss-aversion", "foot-in-door", "social-proof", "consensus"); break;
    case "meeting-relationship": add("liking", "reciprocity", "iceberg"); break;
  }
  for (const o of s.objections ?? []) {
    if (o === "price") add("anchoring", "loss-aversion");
    if (o === "timing") add("present-bias", "foot-in-door");
    if (o === "competition") add("endowment", "social-proof");
    if (o === "authority") add("consensus");
    if (o === "status-quo") add("status-quo", "loss-aversion");
    if (o === "technical") add("risk-reduction", "authority");
  }
  if (s.personas?.includes("economic")) add("anchoring", "risk-reduction");
  if (s.personas?.includes("technical")) add("authority", "risk-reduction");
  if (s.hasChampionOnly) add("consensus");
  if (s.tone === "cooling") add("attribution");
  return ids.slice(0, 5).map((id) => PRINCIPLES[id]);
}

export const ETHICS = "Ethics: use these to understand people and communicate value, never to manipulate. No invented urgency, deadlines, scarcity, competitor claims or social proof. If they genuinely don't need it or the timing is wrong, say so and leave the door open.";

// ── Prompt blocks ────────────────────────────────────────────────────────────

export function principleLines(ps: readonly Principle[]): string {
  return ps.map((p) => `- ${p.name}: ${p.use} (Line not to cross: ${p.guard})`).join("\n");
}

export interface AttendeeRead {
  name: string;
  role?: string;
  persona?: Persona;
  /** From their profile: how to land it, how they decide, bad news, silence, how to reach them. */
  howToLandIt?: string;
  decides?: string;
  badNews?: string;
  reachThem?: string;
  tone?: "warming" | "cooling" | "neutral";
}

/**
 * The "how to influence" block for meeting prep. For a client meeting: read
 * the room and move the deal. For an internal meeting: sell yourself and your
 * idea or project. Both: one ask, early, with the ethics attached.
 */
export function meetingPlaybook(input: {
  kind: "external" | "internal";
  attendees: readonly AttendeeRead[];
  dealStage?: string;
  objections?: ObjectionTheme[];
}): string {
  const situation = input.kind === "internal" ? "meeting-internal-pitch" : "meeting-external";
  const ps = principlesFor({ situation, objections: input.objections, personas: input.attendees.map((a) => a.persona).filter((x): x is Persona => !!x) });
  const people = input.attendees.slice(0, 8).map((a) => {
    const bits = [
      a.role, a.persona ? `likely ${a.persona === "economic" ? "economic buyer — judges payback and risk" : a.persona === "technical" ? "technical buyer — judges fit, security, integration" : a.persona === "end-user" ? "end user — judges daily ease" : "champion"}` : "",
      a.howToLandIt ? `lands it: ${a.howToLandIt}` : "", a.decides ? `decides: ${a.decides}` : "",
      a.badNews ? `bad news: ${a.badNews}` : "", a.tone && a.tone !== "neutral" ? `recent tone ${a.tone}` : "",
    ].filter(Boolean);
    return `- ${a.name}${bits.length ? ` — ${bits.join("; ")}` : ""}`;
  }).join("\n");
  const goal = input.kind === "internal"
    ? `This is an internal meeting: help the user sell THEMSELVES and their idea or project. Frame it around the problem the others feel (and the cost of leaving it), let them shape it (ask, don't just tell), name the one small decision wanted today, and pre-empt the likely pushback with evidence the user actually has.`
    : `This is a client/external meeting${input.dealStage ? ` (deal stage: ${input.dealStage})` : ""}: help the user read each person, uncover the real driver beneath the stated one, and leave with a specific, agreed next step.`;
  return `${goal}

Psychology that fits this meeting (apply where the evidence supports it):
${principleLines(ps)}

How each person is likely to engage (from their profile and the CRM; style guidance, not fact):
${people || "- No profile data on the attendees."}

${ETHICS}`;
}
