/**
 * "Take me there" for an action (2026-11-13): the place the user can actually
 * do it, not the Actions list.
 *
 *   email   → the email itself, opened in Basil (reply or RSVP in place), plus
 *             the main link inside it when the work happens in another app
 *             ("review the answers on the Evidence tab" → that tab)
 *   slack   → the message in Slack
 *   linear  → the issue
 *   other   → Ask Basil, with the task already written, to draft or do it
 *
 * Pure and browser-safe; the route (app/api/actions/[id]/destination) fills in
 * what needs a server call (the email body, the Slack permalink).
 */

export interface ActionLink { href: string; label: string; external: boolean }

export interface ActionDestination {
  /** Gmail message to open in place, when the action came from an email. */
  emailId?: string;
  /** The best place to act, in priority order. */
  links: ActionLink[];
}

/** Ask Basil with the task written for it. */
export function askBasilLink(text: string): ActionLink {
  return { href: `/dashboard/chat?q=${encodeURIComponent(`Help me get this done: ${text}`)}`, label: "Do it with Basil", external: false };
}

const JUNK = /unsubscribe|optout|opt-out|preferences|privacy|terms|manage[-_ ]?(?:notifications|subscription)|email[-_]?settings|\/track|\/open\?|pixel|beacon|list-manage|facebook\.com|twitter\.com|x\.com\/|linkedin\.com\/(?:company|in)\/|instagram\.com|youtube\.com|\.(?:png|jpe?g|gif|svg|webp)(?:\?|$)/i;
const ACT_WORDS = /\b(review|view|open|respond|reply|approve|accept|reject|sign|complete|submit|answer|evidence|rfi|go to|see|launch|join|confirm|update|edit)\b/i;

/**
 * The main link inside an email: not an unsubscribe, tracking, social or image
 * link. Links near words like "review", "open" or words from the task win.
 */
export function pickActionLink(body: string, taskText: string): ActionLink | null {
  const task = new Set((taskText.toLowerCase().match(/[a-z]{4,}/g) ?? []));
  const found: { href: string; score: number; index: number }[] = [];
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  for (const m of body.matchAll(re)) {
    const href = m[0].replace(/[.,;:!?]+$/, "");
    if (JUNK.test(href)) continue;
    const before = body.slice(Math.max(0, (m.index ?? 0) - 120), m.index ?? 0).toLowerCase();
    let score = ACT_WORDS.test(before) ? 3 : 0;
    for (const w of before.match(/[a-z]{4,}/g) ?? []) if (task.has(w)) score += 1;
    for (const w of href.toLowerCase().match(/[a-z]{4,}/g) ?? []) if (task.has(w)) score += 1;
    found.push({ href, score, index: m.index ?? 0 });
  }
  if (found.length === 0) return null;
  const best = found.sort((a, b) => b.score - a.score || a.index - b.index)[0];
  let host = "the link";
  try { host = new URL(best.href).host.replace(/^www\./, ""); } catch { /* keep the generic label */ }
  return { href: best.href, label: `Open in ${host}`, external: true };
}

/** What can be known without a server call. */
export function baseDestination(action: { text: string; source: string; sourceRef?: string }): ActionDestination {
  const ref = action.sourceRef ?? "";
  const links: ActionLink[] = [];
  let emailId: string | undefined;
  if (ref.startsWith("gmail:")) emailId = ref.slice("gmail:".length);
  if (ref.startsWith("linear:")) links.push({ href: "/dashboard/linear", label: `Open ${ref.slice("linear:".length)} in Linear`, external: false });
  links.push(askBasilLink(action.text));
  return { emailId, links };
}
