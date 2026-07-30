/**
 * Declared explicitly — a broad sweep query over a multi-week window means
 * `searchEmails` does its per-message metadata fetch (sequential inside each
 * query) for potentially 50+ candidates. Three queries run in parallel via
 * Promise.all, but the slowest branch still needs real headroom.
 */
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";
import { searchEmails } from "@/lib/google/gmail";
import { hasExternalId } from "@/lib/events/store";
import { ZOOM_GMAIL_QUERY, ZOOM_FORWARDED_GMAIL_QUERY, detectZoomEmail } from "@/lib/google/zoom-email-detector";

/**
 * Retrospective sweep, deliberately broader than either production query.
 * ZOOM_GMAIL_QUERY / ZOOM_FORWARDED_GMAIL_QUERY encode what we currently know
 * to look for — but "meeting assets" proved that list is discovered
 * incrementally, one missed real email at a time. This bare-keyword query
 * catches candidates neither production query would, and relies entirely on
 * detectZoomEmail() downstream to reject non-Zoom noise.
 */
const ZOOM_AUDIT_SWEEP_QUERY =
  '(zoom OR "meeting summary" OR "meeting recap" OR "meeting notes" OR "AI Companion" OR ' +
  '"recording available" OR "transcript available" OR "meeting assets" OR "cloud recording" OR ' +
  '"meeting highlights" OR "smart summary")';

interface AuditHit {
  id: string;
  subject: string;
  from: string;
  date: string;
  confidence: number;
  signals: string[];
  forwarded: boolean;
  gmailLink: string;
}

/**
 * GET /api/admin/zoom-audit?days=21&username=michael
 *
 * Read-only. Diffs "Zoom-artifact emails detectable in Gmail over the last N
 * days" against "Zoom-artifact emails already ingested as events" — surfaces
 * anything the pipeline (at whatever point it ran during that window) missed.
 * Never creates events, actions, decisions, or memory. Safe to re-run anytime.
 *
 * Auth mirrors poll-ingest: CRON_SECRET bearer for server-to-server/manual
 * runs (username required as a query param in that mode), or an admin
 * session cookie (audits the session's own username).
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  const { searchParams } = new URL(req.url);
  const days = Math.max(1, Math.min(60, Number(searchParams.get("days")) || 21));

  let username: string;
  if (isCronCall) {
    const paramUser = searchParams.get("username");
    if (!paramUser) {
      return NextResponse.json({ error: "username query param required with bearer auth" }, { status: 400 });
    }
    username = paramUser;
  } else {
    const sessionUser = await getSessionUser();
    if (!sessionUser) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    if (!isAdminUser(sessionUser)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    username = sessionUser;
  }

  const CAPS = { direct: 30, forwarded: 20, sweep: 40 } as const;

  try {
  const [direct, forwarded, sweep] = await Promise.all([
    searchEmails(username, ZOOM_GMAIL_QUERY, CAPS.direct, days),
    searchEmails(username, ZOOM_FORWARDED_GMAIL_QUERY, CAPS.forwarded, days),
    searchEmails(username, ZOOM_AUDIT_SWEEP_QUERY, CAPS.sweep, days),
  ]);

  const possibleTruncation = (
    [
      ["direct", direct] as const,
      ["forwarded", forwarded] as const,
      ["sweep", sweep] as const,
    ] as const
  )
    .filter(([, list]) => list.length >= CAPS[list === direct ? "direct" : list === forwarded ? "forwarded" : "sweep"])
    .map(([name]) => name);

  // Dedupe by message id — direct wins (it's the highest-confidence source),
  // forwarded next, sweep last, matching the trust ordering used elsewhere.
  const byId = new Map<string, { m: (typeof direct)[number]; forwarded: boolean }>();
  for (const m of direct) byId.set(m.id, { m, forwarded: false });
  for (const m of forwarded) if (!byId.has(m.id)) byId.set(m.id, { m, forwarded: true });
  for (const m of sweep) if (!byId.has(m.id)) byId.set(m.id, { m, forwarded: /^\s*(?:fwd?|fw)\s*:/i.test(m.subject) });

  const missed: AuditHit[] = [];
  let alreadyIngested = 0;
  let consideredNotZoom = 0;

  for (const { m, forwarded: isFwd } of byId.values()) {
    const signal = detectZoomEmail({ from: m.from, subject: m.subject, snippet: m.snippet });
    if (!signal.isZoom) {
      consideredNotZoom++;
      continue;
    }
    if (await hasExternalId(username, `gmail:${m.id}`)) {
      alreadyIngested++;
      continue;
    }
    missed.push({
      id: m.id,
      subject: m.subject || "(no subject)",
      from: m.from,
      date: m.date,
      confidence: signal.confidence,
      signals: signal.signals,
      forwarded: isFwd,
      gmailLink: `https://mail.google.com/mail/u/0/#all/${m.id}`,
    });
  }

  missed.sort((a, b) => b.date.localeCompare(a.date));

  return NextResponse.json({
    windowDays: days,
    username,
    queried: { direct: direct.length, forwarded: forwarded.length, sweep: sweep.length },
    candidatesScanned: byId.size,
    alreadyIngested,
    consideredNotZoom,
    missedCount: missed.length,
    missed,
    possibleTruncation: possibleTruncation.length ? possibleTruncation : undefined,
  });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[zoom-audit] failed for ${username}:`, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
