/**
 * GET  /api/plaud                     → { connected, lastSyncAt, lastResult, synced }
 * POST /api/plaud { action: "sync", days? } → sync now (days: reach back further, max 365)
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isPlaudConnected } from "@/lib/plaud/oauth";
import { readPlaudSync, syncPlaud } from "@/lib/plaud/sync";

export const maxDuration = 300;

async function view(username: string) {
  const [connected, s] = await Promise.all([isPlaudConnected(username), readPlaudSync(username)]);
  return { connected, lastSyncAt: s.lastSyncAt ?? null, lastResult: s.lastResult ?? null, synced: Object.keys(s.processed).length };
}

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  return NextResponse.json(await view(username));
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { action?: unknown; days?: unknown } | null; // ci-ok: bad body → 400 below
  if (body?.action !== "sync") return NextResponse.json({ error: "unknown action" }, { status: 400 });
  const days = typeof body.days === "number" ? Math.min(365, Math.max(1, Math.round(body.days))) : undefined;
  try {
    await syncPlaud(username, days ? { days } : {});
  } catch (e) {
    return NextResponse.json({ ...(await view(username)), error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  return NextResponse.json(await view(username));
}
