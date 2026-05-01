import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { readProjectsStore } from "@/lib/ai-projects/store";
import { syncProjects } from "@/lib/ai-projects/sync";

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** GET — return cached store, trigger sync if >30 min stale */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const data = await readProjectsStore(username);
    const lastSync = data.lastSyncedAt ? new Date(data.lastSyncedAt).getTime() : 0;
    const stale = Date.now() - lastSync > STALE_THRESHOLD_MS;

    if (stale) {
      // Sync in background — don't await so the response is fast
      syncProjects(username).catch((e) =>
        console.error("[ai-projects] background sync error:", e)
      );
    }

    return NextResponse.json(data);
  } catch (e) {
    console.error("[ai-projects] GET error:", e);
    return NextResponse.json({ error: "Failed to load projects" }, { status: 500 });
  }
}

/** POST — force sync, return fresh data */
export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const data = await syncProjects(username);
    return NextResponse.json(data);
  } catch (e) {
    console.error("[ai-projects] POST sync error:", e);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
