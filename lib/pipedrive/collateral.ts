/**
 * lib/pipedrive/collateral.ts — which sales collateral a deal needs, and a
 * ready-to-paste prompt for each. Pure.
 *
 * Michael, 2026-11-24: "not create but suggest and provide prompts for the
 * user to create client specific collateral". So Basil never writes the deck,
 * one-pager or proposal. It reads the deal (stage, value, people and their
 * roles, meeting notes, notes, what is planned), decides which assets fit, and
 * hands over a prompt the user pastes into Claude / ChatGPT / their deck tool.
 *
 * Built on sales-enablement practice:
 *   - situation-specific, not generic: by stage, by persona, by what was said;
 *   - scannable, outcome-led structures for each asset type;
 *   - claims reps can defend: the prompt forbids invented stats, customers
 *     and competitor facts, and asks for missing proof instead of making it up;
 *   - when an objection shows up in the notes, a live-deal objection prompt.
 */

import type { PdActivity, PdDeal, PdNote, PdOrg, PdPerson } from "@/lib/pipedrive/shape";
import { money } from "@/lib/pipedrive/shape";

export type AssetKind =
  | "discovery-talk-track" | "persona-cards" | "intro-one-pager" | "demo-script" | "recap-one-pager"
  | "champion-one-pager" | "sales-deck" | "proposal" | "roi-calculator" | "objection-response"
  | "re-engagement-email" | "win-loss-notes";

export interface CollateralContext {
  deal: PdDeal;
  org?: PdOrg;
  people: PdPerson[];
  /** Meeting / call activities with notes, newest first. */
  meetings: PdActivity[];
  notes: PdNote[];
  planned: PdActivity[];
  today: string;
  /** The user's own selling context (value prop, differentiators, proof) from Settings. */
  sellerContext?: string;
  sellerCompany?: string;
}

export interface CollateralSuggestion {
  kind: AssetKind;
  title: string;
  why: string;
  /** Who it is for, when a persona drives it. */
  audience?: string;
  prompt: string;
}

// ── Reading the deal ─────────────────────────────────────────────────────────

type Persona = "economic" | "technical" | "champion" | "end-user";

const PERSONA_RULES: ReadonlyArray<[Persona, RegExp]> = [
  ["economic", /\b(ceo|cfo|coo|cro|founder|owner|president|managing director|md|finance|procurement|purchasing|chief|vp|vice president|head of|director|partner)\b/i],
  ["technical", /\b(cto|cio|ciso|engineer|engineering|architect|developer|it\b|security|data|technical|devops|platform)\b/i],
  ["end-user", /\b(analyst|coordinator|associate|specialist|executive assistant|administrator|recruiter|consultant)\b/i],
];

export function personaOf(jobTitle?: string): Persona | undefined {
  if (!jobTitle) return undefined;
  // Technical titles that are also senior ("VP Engineering") read as technical.
  if (PERSONA_RULES[1][1].test(jobTitle)) return "technical";
  for (const [p, re] of PERSONA_RULES) if (re.test(jobTitle)) return p;
  return undefined;
}

const PERSONA_LABEL: Record<Persona, string> = { economic: "economic buyer", technical: "technical buyer", champion: "champion", "end-user": "end user" };

export type ObjectionTheme = "price" | "timing" | "competition" | "authority" | "status-quo" | "technical";

const OBJECTION_RULES: ReadonlyArray<[ObjectionTheme, RegExp]> = [
  ["price", /\b(too expensive|expensive|price|pricing|budget|cost|cheaper|discount|afford)\b/i],
  ["timing", /\b(next quarter|next year|not now|later|timing|too busy|bandwidth|on hold|pause|delay)\b/i],
  ["competition", /\b(competitor|alternative|already use|already have|incumbent|vs\.?|versus|comparing|evaluating others)\b/i],
  ["authority", /\b(board|sign[- ]?off|approval|approve|my boss|committee|procurement|legal review)\b/i],
  ["status-quo", /\b(works fine|happy with|not a priority|in[- ]house|build it ourselves|manual process is fine)\b/i],
  ["technical", /\b(security|integration|integrate|sso|gdpr|compliance|api|data protection|scal(e|ability)|soc ?2|iso ?27001)\b/i],
];

export interface ObjectionHit { theme: ObjectionTheme; quote: string; date: string }

/** Objection signals in what was written up, with the sentence they came from. */
export function objectionsIn(ctx: Pick<CollateralContext, "meetings" | "notes">): ObjectionHit[] {
  const texts = [
    ...ctx.meetings.map((m) => ({ text: m.note ?? "", date: (m.doneTime ?? m.dueDate ?? m.updateTime).slice(0, 10) })),
    ...ctx.notes.map((n) => ({ text: n.content, date: n.addTime.slice(0, 10) })),
  ];
  const hits: ObjectionHit[] = [];
  const seen = new Set<ObjectionTheme>();
  for (const t of texts) {
    for (const sentence of t.text.split(/(?<=[.!?\n])\s+/)) {
      for (const [theme, re] of OBJECTION_RULES) {
        if (seen.has(theme) || !re.test(sentence)) continue;
        seen.add(theme);
        hits.push({ theme, quote: sentence.trim().slice(0, 240), date: t.date });
      }
    }
  }
  return hits;
}

type StageBand = "early" | "discovery" | "demo" | "proposal" | "negotiation" | "closing" | "unknown";

export function stageBand(stage: string): StageBand {
  const s = stage.toLowerCase();
  if (/(lead|new|prospect|contact made|cold|outreach|mql|sql)/.test(s)) return "early";
  if (/(qualif|discover|needs|meeting (booked|scheduled|arranged)|intro)/.test(s)) return "discovery";
  if (/(demo|present|trial|pilot|poc|proof of concept|evaluation)/.test(s)) return "demo";
  if (/(proposal|quote|pricing|offer|scope|sow)/.test(s)) return "proposal";
  if (/(negotiat|contract|legal|procure|terms|commercial)/.test(s)) return "negotiation";
  if (/(verbal|closing|commit|won pending|signature)/.test(s)) return "closing";
  return "unknown";
}

// ── The prompt ───────────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function clientBlock(ctx: CollateralContext): string {
  const d = ctx.deal;
  const lines = [
    `Client: ${ctx.org?.name ?? "(organisation not recorded)"}${ctx.org?.industry ? ` — ${ctx.org.industry}` : ""}${ctx.org?.website ? ` — ${ctx.org.website}` : ""}`,
    `Deal: "${d.title}" — ${money(d.value, d.currency)}, stage "${d.stage}"${d.pipeline ? ` (${d.pipeline})` : ""}${d.expectedClose ? `, expected close ${d.expectedClose}` : ""}, status ${d.status}`,
  ];
  if (ctx.people.length) {
    lines.push("People involved:");
    for (const p of ctx.people.slice(0, 8)) {
      const persona = personaOf(p.jobTitle);
      lines.push(`- ${p.name}${p.jobTitle ? `, ${p.jobTitle}` : ""}${persona ? ` (likely ${PERSONA_LABEL[persona]})` : ""}`);
    }
  }
  if (ctx.meetings.length) {
    lines.push("What was said in meetings (newest first, from our CRM notes):");
    for (const m of ctx.meetings.slice(0, 4)) {
      lines.push(`- ${(m.doneTime ?? m.dueDate ?? m.updateTime).slice(0, 10)} ${m.type} "${m.subject}": ${clip((m.note ?? "").replace(/\s+/g, " "), 900)}`);
    }
  }
  if (ctx.notes.length) {
    lines.push("Other notes:");
    for (const n of ctx.notes.slice(0, 4)) lines.push(`- ${n.addTime.slice(0, 10)}: ${clip(n.content.replace(/\s+/g, " "), 500)}`);
  }
  if (ctx.planned.length) {
    lines.push("Planned next steps:");
    for (const a of ctx.planned.slice(0, 3)) lines.push(`- ${a.type} "${a.subject}"${a.dueDate ? ` on ${a.dueDate}` : ""}`);
  }
  return lines.join("\n");
}

function sellerBlock(ctx: CollateralContext): string {
  return ctx.sellerContext?.trim()
    ? `About us${ctx.sellerCompany ? ` (${ctx.sellerCompany})` : ""}:\n${clip(ctx.sellerContext.trim(), 2_500)}`
    : `About us${ctx.sellerCompany ? ` (${ctx.sellerCompany})` : ""}: [paste your value proposition, 3 differentiators and the proof you can stand behind — case studies, metrics, customer quotes]`;
}

const RULES = `Rules:
- Use only facts from the client context and "About us" below. Do not invent statistics, customer names, logos, quotes or competitor facts.
- Where proof is missing, leave a clearly marked placeholder like [PROOF: case study in their industry] and list at the end what I need to supply.
- Mirror the client's own words from the meeting notes. Tie every claim to an outcome they care about (revenue, time, risk).
- Keep it scannable: bold headers, short bullets, one idea per section.
- If anything important is unclear, ask me before drafting.`;

function prompt(task: string, structure: string, ctx: CollateralContext): string {
  return `${task}\n\n${structure}\n\n${RULES}\n\n---\n${sellerBlock(ctx)}\n\n---\nClient context (from our CRM):\n${clientBlock(ctx)}`;
}

const STRUCTURE: Record<AssetKind, string> = {
  "discovery-talk-track": "Structure: 30-minute call. Opening and agenda (2 min); 8–10 discovery questions grouped by topic — current process, pain and its cost, decision process and timeline, success criteria; what to listen for; how to close with an agreed next step.",
  "persona-cards": "Structure: one card per person — role, goals, daily pains, top 3 likely objections, how they evaluate solutions, their role in the decision, and the one-sentence messaging angle for them.",
  "intro-one-pager": "Structure (one page): problem in one sentence in their terms; what we do; 3 differentiators versus their likely alternative; one proof point; a specific call to action with a named contact.",
  "demo-script": "Structure: opening and agenda (2 min); recap of what we learned and their priorities (3 min); 3–4 workflows mapped to their stated pains (15–20 min) with interaction questions during each; close with value summary and a dated next step (5 min).",
  "recap-one-pager": "Structure (one page, post-meeting leave-behind): what we heard (their priorities in their words); what we showed and how it addresses each; agreed next steps with owners and dates; open questions.",
  "champion-one-pager": "Structure (one page my champion can forward internally): the problem and its cost to their business; why act now; why us in 3 points; expected outcome and timeline; what approval is needed and from whom. Written for their colleagues, not for my champion.",
  "sales-deck": "Structure (10–12 slides, story arc not feature tour; give headline, body copy and speaker notes per slide): their current problem; its cost; the shift creating urgency; our approach; 3–4 workflows; proof; one case study; implementation timeline; ROI; pricing overview; next steps.",
  proposal: "Structure (5–7 pages): executive summary (their challenge, our solution, expected outcome — one page); proposed solution mapped to their stated requirements; implementation plan with milestones and responsibilities; investment, terms and what is included (no burying the price); next steps and decision timeline. Name the stakeholders we've spoken with.",
  "roi-calculator": "Structure: inputs the client provides (time on the manual process, current tool costs, team size, error or delay rates); the formulas; outputs (annual value, payback in months, 3-year value) with sample numbers clearly labelled as illustrative until they supply real ones. Deliver as a table I can rebuild in a spreadsheet.",
  "objection-response": "Structure: the likely concern behind the objection (and a question to tell two readings apart if both fit); one response I can say as written — acknowledge, address the real concern, one proof point, end with a question; and when NOT to push (if it shows a real fit gap, how to narrow scope or qualify out).",
  "re-engagement-email": "Structure: 3 short email options (under 120 words each) — one that adds new value tied to their stated priority, one that asks a direct yes/no question, one polite close-the-loop. Subject line for each. No guilt-tripping.",
  "win-loss-notes": "Structure: primary reason (one), secondary reasons, the supporting quote or note for each, what we would do differently, and which battle card, objection response or discovery question this should update.",
};

// ── Suggesting ───────────────────────────────────────────────────────────────

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function suggestCollateral(ctx: CollateralContext): CollateralSuggestion[] {
  const d = ctx.deal;
  const band = stageBand(d.stage);
  const out: CollateralSuggestion[] = [];
  const who = ctx.org?.name ?? d.title;
  const add = (kind: AssetKind, title: string, why: string, task: string, audience?: string) =>
    out.push({ kind, title, why, ...(audience ? { audience } : {}), prompt: prompt(task, STRUCTURE[kind], ctx) });

  if (d.status === "lost") {
    add("win-loss-notes", "Win-loss notes", `"${d.title}" was lost${d.lostReason ? ` (${d.lostReason})` : ""}. Capture why while it is fresh.`,
      `Help me write win-loss notes for the lost deal "${d.title}" with ${who}, from the CRM context below.`);
    return out;
  }
  if (d.status === "won") return out;

  const lastMeeting = ctx.meetings[0];
  const meetingAgo = lastMeeting ? daysBetween((lastMeeting.doneTime ?? lastMeeting.dueDate ?? lastMeeting.updateTime).slice(0, 10), ctx.today) : null;
  const objections = objectionsIn(ctx);
  const personas = new Map<Persona, PdPerson[]>();
  for (const p of ctx.people) {
    const k = personaOf(p.jobTitle);
    if (k) personas.set(k, [...(personas.get(k) ?? []), p]);
  }

  // Straight after a meeting: the recap is the highest-value asset there is.
  if (meetingAgo !== null && meetingAgo <= 3) {
    add("recap-one-pager", "Post-meeting recap one-pager",
      `Your ${lastMeeting!.type} "${lastMeeting!.subject}" was ${meetingAgo === 0 ? "today" : `${meetingAgo} day${meetingAgo === 1 ? "" : "s"} ago`} — a recap keeps momentum.`,
      `Write a one-page post-meeting recap for ${who} after our ${lastMeeting!.type} "${lastMeeting!.subject}", using the meeting notes below.`);
  }

  // Objections in the notes: a live-deal response for each theme (max 2).
  for (const o of objections.slice(0, 2)) {
    add("objection-response", `Respond to the ${o.theme.replace("-", " ")} objection`,
      `Noted on ${o.date}: "${clip(o.quote, 140)}"`,
      `In the deal "${d.title}" with ${who}, this came up: "${o.quote}". Help me respond in the next conversation.`);
  }

  if (band === "early" || band === "discovery" || band === "unknown") {
    add("discovery-talk-track", "Discovery call talk track", `"${d.title}" is at ${d.stage}: qualify the pain, the decision process and the timeline before showing anything.`,
      `Write a discovery-call talk track tailored to ${who} for the deal "${d.title}".`);
    if (ctx.people.length > 0) {
      add("persona-cards", "Buyer persona cards", `${ctx.people.length} ${ctx.people.length === 1 ? "person" : "people"} on the deal — know what each cares about.`,
        `Create buyer persona cards for the people on the deal "${d.title}" with ${who}.`);
    }
    if (band === "early") {
      add("intro-one-pager", "Intro one-pager", "Early stage: a short leave-behind that earns the first meeting.",
        `Write an intro one-pager tailored to ${who}.`);
    }
  }

  if (band === "demo") {
    add("demo-script", "Tailored demo script", `At ${d.stage}: show 3–4 workflows mapped to the pains they described, not a feature tour.`,
      `Write a demo script for ${who} for the deal "${d.title}", built on what they told us in the meeting notes.`);
  }

  if (band === "demo" || band === "proposal" || band === "negotiation") {
    const champ = personas.get("end-user")?.[0] ?? personas.get("technical")?.[0] ?? (personas.has("economic") ? undefined : ctx.people[0]);
    if (champ || ctx.people.length > 1) {
      add("champion-one-pager", "Champion one-pager", `Arm ${champ?.name ?? "your contact"} to sell internally${personas.has("economic") ? "" : " — no economic buyer is recorded on the deal yet"}.`,
        `Write a one-pager ${champ?.name ?? "my champion"} at ${who} can forward internally to win approval for "${d.title}".`, champ ? PERSONA_LABEL.champion : undefined);
    }
  }

  if (band === "proposal" || band === "negotiation") {
    add("proposal", "Proposal", `"${d.title}" is at ${d.stage} (${money(d.value, d.currency)}).`,
      `Draft a proposal for ${who} for the deal "${d.title}".`);
    if (personas.has("economic") || objections.some((o) => o.theme === "price")) {
      add("roi-calculator", "ROI calculator", personas.has("economic")
        ? `${personas.get("economic")![0].name}${personas.get("economic")![0].jobTitle ? ` (${personas.get("economic")![0].jobTitle})` : ""} will judge payback and risk.`
        : "Price came up — show the return, not just the cost.",
        `Design an ROI calculator for ${who} for the deal "${d.title}".`, personas.has("economic") ? PERSONA_LABEL.economic : undefined);
    }
  }

  if ((band === "demo" || band === "proposal") && personas.has("economic") && !out.some((x) => x.kind === "sales-deck")) {
    const eb = personas.get("economic")![0];
    add("sales-deck", "Executive deck", `For ${eb.name}${eb.jobTitle ? ` (${eb.jobTitle})` : ""}: lead with outcomes, ROI and risk; keep technical detail light.`,
      `Outline an executive sales deck for ${eb.name} at ${who} for the deal "${d.title}".`, PERSONA_LABEL.economic);
  }

  // Going quiet or past close: re-engage with value, not a nudge.
  const quietDays = daysBetween(d.updateTime.slice(0, 10), ctx.today);
  if ((d.expectedClose && d.expectedClose < ctx.today) || (quietDays >= 14 && ctx.planned.length === 0)) {
    add("re-engagement-email", "Re-engagement emails",
      d.expectedClose && d.expectedClose < ctx.today ? `Past its expected close (${d.expectedClose}) and still open.` : `No update for ${quietDays} days and nothing planned.`,
      `Write re-engagement emails for ${ctx.people[0]?.name ?? "my contact"} at ${who} about "${d.title}".`);
  }

  return out.slice(0, 6);
}
