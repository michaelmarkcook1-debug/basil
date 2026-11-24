import { createHash, timingSafeEqual } from 'node:crypto';
import type { Memory } from '@/lib/memory/types';

type Account = { username: string; disabled?: boolean };
type Dependencies = {
  token?: string; account?: string;
  resolveAccount: (identity: string) => Promise<Account | null>;
  read: (username: string) => Promise<unknown>;
  now?: () => number;
};
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
const hash = (value: string) => createHash('sha256').update(value).digest();

/** Dedicated read-only capability. Never accepts a requested account or a session cookie. */
export async function meetingSummaries(request: Request, deps: Dependencies): Promise<Response> {
  if (!deps.token || deps.token.length < 32 || !deps.account?.trim()) return reply({ error: 'Summary connection is not configured.' }, 503);
  const supplied = request.headers.get('authorization') ?? '';
  if (supplied.length > 1024 || !timingSafeEqual(hash(supplied), hash('Bearer ' + deps.token))) return reply({ error: 'Not authorised.' }, 401);
  const params = new URL(request.url).searchParams;
  const cursors = params.getAll('cursor');
  if ([...params.keys()].some(key => key !== 'cursor') || cursors.length > 1 ||
      (cursors.length && !/^[a-f0-9]{64}$/.test(cursors[0]))) return reply({ error: 'Invalid page cursor.' }, 400);
  try {
    const account = await deps.resolveAccount(deps.account.trim());
    if (!account || account.disabled) return reply({ error: 'The connected account is unavailable.' }, 403);
    const raw = await deps.read(account.username.toLowerCase());
    if (raw !== null && !Array.isArray(raw)) throw new Error('Invalid memory store');
    const now = (deps.now ?? Date.now)();
    const summaries = (raw ?? []).filter((m: Memory) => m?.kind === 'context' && typeof m.content === 'string' && /^\[(Zoom meeting|Recording) — [^\]]+\]/.test(m.content)).map((m: Memory) => {
      const title = m.content.match(/^\[(?:Zoom meeting|Recording) — ([^\]]+)\]/)![1];
      // Keep the saved summary unchanged. Do not read transcript, contacts or action stores.
      if (!m.id || m.id.length > 160 || title.length > 500 || m.content.length > 24000 ||
          !Number.isFinite(Date.parse(m.createdAt)) || !Number.isFinite(Date.parse(m.updatedAt))) throw new Error('Invalid meeting summary');
      return {
        id: m.id, title, summary: m.content, createdAt: m.createdAt, updatedAt: m.updatedAt,
        sourceRef: m.sourceRef ?? null, expiresAt: m.expiresAt ?? null,
        expired: !m.pinned && !!m.expiresAt && Date.parse(m.expiresAt) < now,
        needsReview: typeof m.needsReview === 'boolean' ? m.needsReview : null, confidence: m.confidence ?? null,
      };
    }).filter((m: {summary: string}) => !/^\[Zoom meeting[^\]]*\]\s*\d{4}-\d{2}-\d{2}\.\s*Duration:/.test(m.summary))
      .sort((a: {updatedAt: string; id: string}, b: {updatedAt: string; id: string}) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    const position = (row: {id: string; updatedAt: string}) => createHash('sha256').update(JSON.stringify([account.username, row.id, row.updatedAt])).digest('hex');
    const index = cursors.length ? summaries.findIndex((row: {id: string; updatedAt: string}) => position(row) === cursors[0]) : -1;
    if (cursors.length && index < 0) return reply({error: 'Source changed; restart from the first page.'}, 409);
    const page = summaries.slice(index + 1, index + 51);
    const more = index + 1 + page.length < summaries.length;
    const body = { schema: 'basil-meeting-summaries-v1', account: account.username.toLowerCase(), retrievedAt: new Date(now).toISOString(),
      summaries: page, hasMore: more, nextCursor: more ? position(page[page.length - 1]) : null };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 2_000_000) throw new Error('Summary response exceeds limit');
    return reply(body);
  } catch {
    // Storage failures are not reported as an empty successful result. No private content in logs.
    return reply({ error: 'Meeting summaries are temporarily unavailable.' }, 503);
  }
}
