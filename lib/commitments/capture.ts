import "server-only";
import { z } from "zod";
import { getSentEmails, getEmailBody, type GmailMessage } from "@/lib/google/gmail";
import { createActionTracked } from "@/lib/actions/store";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { getSettings } from "@/lib/settings/store";
import { getTaskSystemPrompt } from "@/lib/ai/system-prompt";
import { generateTextSafe } from "@/lib/ai/generate";
import { SpendCapError } from "@/lib/ai/spend-guard";
import { getTextModel } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { isCalendarInvitation } from "@/lib/email/triage";
import { redactSensitive } from "@/lib/security/sensitive";

/**
 * Promises the user makes in their own sent mail ("I'll send the deck by
 * Friday") become actions to confirm.
 *
 * Basil read sent mail only to CLOSE things (outbound-evidence, resolve-threads)
 * — the commitments a user makes in writing, the ones an assistant should hold
 * them to, were never captured. Each is created with needsReview so the user
 * confirms or dismisses it; nothing lands silently on the list.
 */

const STATE_FILE = "sage-promise-scan.json";
interface ScanState { processed: string[]; lastRunAt?: string }
const EMPTY: ScanState = { processed: [] };

/** How often the Actions page may trigger a scan. The 05:45 ingest always runs. */
export const MIN_INTERVAL_MINUTES = 120;

/**
 * Only the user's own new text: quoted history ("On … wrote:", Outlook
 * headers, "> " lines) holds other people's words and old promises. Pure.
 */
export function ownText(body: string): string {
  const text = body
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"');
  const cut = [
    /^\s*On .{3,200}(wrote|écrit|schrieb):\s*$/im,
    /^\s*-{2,}\s*Original Message\s*-{2,}/im,
    /^\s*From:\s.+\n\s*(Sent|Date):\s/im,
    /^\s*_{10,}\s*$/m,
  ].map((re) => text.search(re)).filter((i) => i >= 0);
  const head = cut.length ? text.slice(0, Math.min(...cut)) : text;
  return head.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// First-person future commitments and deadline phrasing. A cheap gate so the
// model only reads mail that can contain a promise. Pure — exported for tests.
const PROMISE_MARKERS = /\b(i['’]ll|i will|i['’]m going to|i am going to|i shall|let me (send|check|get|find|share|come back|circle back|follow up|look into|confirm)|i can (send|share|get|have|do)|will (send|share|get back|follow up|circle back|revert|confirm)|(get|come|circle) back to you|by (monday|tuesday|wednesday|thursday|friday|tomorrow|end of (the )?(day|week)|eod|eow|cob|next week))\b/i;

export function looksLikePromise(text: string): boolean {
  return PROMISE_MARKERS.test(text);
}

const Extracted = z.object({
  commitments: z.array(z.object({
    text: z.string().min(3),
    to: z.string().optional().default(""),
    dueDate: z.string().nullable().optional(),
    quote: z.string().optional().default(""),
  })).default([]),
});

export function extractionPrompt(first: string, msg: { to: string; subject: string; date: string }, own: string, today: string): string {
  return `Below is an email ${first} SENT. List the commitments ${first} made in it: things ${first} personally promised to do later ("I'll send the deck by Friday", "I will get back to you on pricing", "Let me check with Ed and come back to you").

Rules:
- Only ${first}'s own promises written in this email. Not requests to others, not things already done, not plans the other person made.
- Skip pleasantries with no deliverable ("I'll keep you posted", "talk soon", "let me know").
- text: a to-do for ${first} naming the person and the thing, e.g. "Send Olivia the updated deck".
- to: who the promise was made to (a name), or "".
- dueDate: YYYY-MM-DD only if the email states or clearly implies a date (today is ${today}); otherwise null.
- quote: the sentence containing the promise, at most 200 characters.
Return JSON only: {"commitments":[{"text":"","to":"","dueDate":null,"quote":""}]} — an empty list when there are none.

Sent: ${msg.date.slice(0, 10)}
To: ${msg.to}
Subject: ${msg.subject}

${own.slice(0, 3_000)}`;
}

export interface CaptureDeps {
  sent?: (username: string, max: number, days: number) => Promise<GmailMessage[]>;
  body?: (username: string, id: string) => Promise<string>;
  extract?: (prompt: string, system: string) => Promise<string>;
  now?: number;
}

/**
 * Scan recent sent mail for promises and file each as an action to confirm.
 * Idempotent: a message id is remembered once it has been read to a verdict —
 * no promise wording, or its promises extracted and filed — so it is read once.
 *
 * A message whose read FAILED (body fetch, spend cap, provider error, an answer
 * that does not parse, a failed save) is left unrecorded so the next scan
 * retries it while it is still inside the look-back window. It used to be
 * marked before the extraction ran, so any failure lost that email's promises
 * for good (2026-11-10 bug pass, B2). The spend cap stops the scan outright:
 * every later message would fail the same way.
 */
export async function captureSentPromises(
  username: string,
  opts: { force?: boolean; maxMessages?: number } = {},
  deps: CaptureDeps = {},
): Promise<{ skipped?: "recent"; scanned: number; candidates: number; created: number; failed?: number; stopped?: "spend-cap" }> {
  const now = deps.now ?? Date.now();
  const state = await readUserStore<ScanState>(username, STATE_FILE, EMPTY, { fresh: true });
  if (!opts.force && state.lastRunAt && now - Date.parse(state.lastRunAt) < MIN_INTERVAL_MINUTES * 60_000) {
    return { skipped: "recent", scanned: 0, candidates: 0, created: 0 };
  }
  // First run looks back a week, so the feature has something to show at once.
  const days = state.lastRunAt ? 3 : 7;
  const seen = new Set(state.processed);
  const sent = await (deps.sent ?? getSentEmails)(username, opts.maxMessages ?? 30, days);
  const fresh = sent.filter((m) => !seen.has(m.id) && !isCalendarInvitation(m.subject));

  const settings = await getSettings(username);
  const first = settings.name.split(" ")[0] || settings.name;
  const today = new Date(now).toISOString().slice(0, 10);
  let candidates = 0, created = 0, failed = 0;
  let stopped: "spend-cap" | undefined;
  const done: string[] = [];

  for (const m of fresh) {
    try {
      const raw = deps.body ? await deps.body(username, m.id) : (await getEmailBody(username, m.id)).body;
      const own = redactSensitive(ownText(raw)).text;
      // Nothing that could be a promise: a deliberate skip, recorded.
      if (!own || !looksLikePromise(own)) { done.push(m.id); continue; }
      candidates++;
      const prompt = extractionPrompt(first, { to: m.to, subject: m.subject, date: m.date }, own, today);
      const text = deps.extract
        ? await deps.extract(prompt, "")
        : (await generateTextSafe({
            model: getTextModel("fast"),
            maxOutputTokens: 500,
            system: await getTaskSystemPrompt(username, undefined, { memories: 0, glossaryFor: own }),
            prompt,
          }, "fast", { username, feature: "promise-capture" })).text;
      const parsed = parseAndValidate(text, Extracted, "[promise-capture]");
      // An answer that does not parse is a failed read, not "no promises".
      if (!parsed.ok) { failed++; continue; }
      for (const c of parsed.data.commitments.slice(0, 5)) {
        const due = c.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(c.dueDate) ? c.dueDate : undefined;
        const { created: isNew } = await createActionTracked(username, {
          text: c.text.trim().slice(0, 200),
          owner: first,
          dueDate: due,
          source: "email",
          sourceRef: `gmail:${m.id}`,
          confidence: 0.7,
          // The user confirms or dismisses every captured promise.
          needsReview: true,
          commitment: { to: c.to.trim().slice(0, 80), quote: c.quote.trim().slice(0, 200), sentAt: m.date },
        });
        if (isNew) created++;
      }
      // Read to a verdict and every promise filed (createActionTracked dedupes
      // by sourceRef, so a retry after a partial save does not double up).
      done.push(m.id);
    } catch (err) {
      failed++;
      if (err instanceof SpendCapError) {
        console.warn(`[promise-capture] ${username}: AI budget reached (${err.scope}) — stopping; unread messages are retried next scan`);
        stopped = "spend-cap";
        break;
      }
      console.warn(`[promise-capture] message ${m.id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  await updateUserStore<ScanState>(username, STATE_FILE, (cur) => ({
    processed: [...new Set([...(cur.processed ?? []), ...done])].slice(-1_000),
    lastRunAt: new Date(now).toISOString(),
  }), EMPTY);
  if (created) console.log(`[promise-capture] ${username}: ${created} promise(s) from ${candidates} of ${fresh.length} sent message(s)`);
  if (failed) console.warn(`[promise-capture] ${username}: ${failed} message(s) not read to a verdict — left for the next scan`);
  return { scanned: fresh.length, candidates, created, ...(failed ? { failed } : {}), ...(stopped ? { stopped } : {}) };
}
