/**
 * lib/email/view-cache.ts — emails ready to open inside Basil.
 *
 * Opening an email on Today used to link out to Gmail. It now expands in place,
 * and that has to be instant: the home page warms this cache for every email
 * card it shows, so a click reads one stored file instead of waiting on Gmail.
 *
 * Per user, capped and expiring — it holds the handful of messages the home
 * page is asking about, not a mailbox.
 */
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { getReplyContext, type Address, type ReplyContext } from "@/lib/google/gmail";

const FILE = "email-view-cache.json";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 60;
const MAX_BODY = 20_000;

export interface EmailView {
  id: string;
  subject: string;
  date: string;
  from: Address;
  /** As sent. */
  to: Address[];
  cc: Address[];
  /** Default reply recipients (see gmail.replyRecipients). */
  replyTo: Address[];
  replyAllCc: Address[];
  /** Plain text — HTML mail is flattened here, never rendered as markup. */
  body: string;
  cachedAt: string;
}

type CacheFile = Record<string, EmailView>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** HTML mail as readable text. Pure — exported for tests. */
export function toPlainText(body: string): string {
  if (!/<\/?(html|body|div|p|br|table|span|td|a)\b/i.test(body)) return body.trim();
  return decodeEntities(
    body
      .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toEmailView(id: string, ctx: ReplyContext, now = new Date()): EmailView {
  return {
    id,
    subject: ctx.subject,
    date: ctx.date,
    from: ctx.from,
    to: ctx.to,
    cc: ctx.cc,
    replyTo: ctx.replyTo,
    replyAllCc: ctx.replyAllCc,
    body: toPlainText(ctx.body).slice(0, MAX_BODY),
    cachedAt: now.toISOString(),
  };
}

/** Drop expired entries, then keep the newest MAX_ENTRIES. Pure — exported for tests. */
export function pruneCache(cache: CacheFile, now = Date.now()): CacheFile {
  const live = Object.values(cache).filter((v) => now - Date.parse(v.cachedAt) < TTL_MS);
  live.sort((a, b) => b.cachedAt.localeCompare(a.cachedAt));
  return Object.fromEntries(live.slice(0, MAX_ENTRIES).map((v) => [v.id, v]));
}

export async function getCachedEmailView(username: string, id: string): Promise<EmailView | null> {
  const cache = await readUserStore<CacheFile>(username, FILE, {});
  const hit = cache[id];
  return hit && Date.now() - Date.parse(hit.cachedAt) < TTL_MS ? hit : null;
}

async function storeViews(username: string, views: EmailView[]): Promise<void> {
  if (views.length === 0) return;
  await updateUserStore<CacheFile>(
    username, FILE,
    (cur) => pruneCache({ ...cur, ...Object.fromEntries(views.map((v) => [v.id, v])) }),
    {},
    { allowShrink: true },
  );
}

/** The email, from the cache when it is there, else from Gmail (and then cached). */
export async function loadEmailView(username: string, id: string, opts: { fresh?: boolean } = {}): Promise<EmailView> {
  if (!opts.fresh) {
    const hit = await getCachedEmailView(username, id);
    if (hit) return hit;
  }
  const view = toEmailView(id, await getReplyContext(username, id));
  await storeViews(username, [view]).catch((e) =>
    console.warn("[email/view-cache] could not cache", id, e instanceof Error ? e.message : e));
  return view;
}

/**
 * Fetch and cache every listed email not cached yet — one write for the batch.
 * Best-effort: a message that fails to load is simply opened live later.
 */
export async function warmEmailViews(username: string, ids: string[]): Promise<number> {
  const cache = await readUserStore<CacheFile>(username, FILE, {});
  const now = Date.now();
  const missing = [...new Set(ids)].filter((id) => !cache[id] || now - Date.parse(cache[id].cachedAt) >= TTL_MS).slice(0, 12);
  const views: EmailView[] = [];
  await Promise.all(missing.map(async (id) => {
    try {
      views.push(toEmailView(id, await getReplyContext(username, id)));
    } catch (e) {
      console.warn("[email/view-cache] warm failed for", id, e instanceof Error ? e.message : e);
    }
  }));
  await storeViews(username, views);
  return views.length;
}
