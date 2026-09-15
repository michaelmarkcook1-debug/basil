import { NextResponse, after, type NextRequest } from "next/server";
import {
  readGenerateCache,
  writeGenerateCache,
  isCacheValid,
  computeInputHash,
  TODAY_FEED_TTL_MS,
} from "@/lib/generate-cache/store";
import { getSessionUser } from "@/lib/auth";
import { computeTodayFeed, presentFeed } from "@/lib/today/feed";
import type { TodayFeedResponse } from "@/lib/today/types";
// after() background refreshes run on the same invocation, so the budget must
// cover a full fan-out recompute — mirrors contacts/activity.
export const maxDuration = 120;

/**
 * GET /api/today — stale-while-revalidate over computeTodayFeed.
 *
 * Was: the full fan-out ran INLINE on every home-screen load (~5s). The only
 * mitigation was a 90s per-instance memo inside detectPendingFollowups, which
 * almost never hits in prod — each lambda instance has its own memory.
 *
 * Now (the same shape as /api/contacts/activity, 14s → ~200ms):
 *   fresh cache  → instant
 *   stale cache  → serve INSTANTLY, recompute in the background via after()
 *   no cache     → compute once, then it's warm
 */
export async function GET(req: NextRequest) {
  const username = await getSessionUser();
  // ?full=1 — the whole queue, for /dashboard/threads. The cache holds the
  // uncapped feed; the cap is applied at presentation.
  const full = req.nextUrl.searchParams.get("full") === "1";
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    // fresh: read Blob, not the per-instance /tmp copy — the whole point is a
    // cache that's shared across instances.
    const cached = await readGenerateCache<TodayFeedResponse>(username, "today-feed", { fresh: true });

    if (cached?.content) {
      if (isCacheValid(cached)) {
        return NextResponse.json({ ...presentFeed(cached.content, { full }), cache: "hit" });
      }
      // Stale: hand back what we have immediately, refresh after the response.
      after(async () => {
        try {
          const fresh = await computeTodayFeed(username);
          await writeGenerateCache(username, "today-feed", fresh, {
            inputHash: computeInputHash(username, fresh.generatedAt),
            ttlMs: TODAY_FEED_TTL_MS,
          });
        } catch (e) {
          console.error("[today] background refresh failed:", e instanceof Error ? e.message : e);
        }
      });
      return NextResponse.json({ ...presentFeed(cached.content, { full }), cache: "stale" });
    }

    // Cold start — pay for it once.
    const fresh = await computeTodayFeed(username);
    await writeGenerateCache(username, "today-feed", fresh, {
      inputHash: computeInputHash(username, fresh.generatedAt),
      ttlMs: TODAY_FEED_TTL_MS,
    }).catch((e) => console.error("[today] cache write failed:", e));
    return NextResponse.json({ ...presentFeed(fresh, { full }), cache: "miss" });
  } catch (err) {
    console.error("[today]", err);
    return NextResponse.json({ error: "Failed to build today feed." }, { status: 500 });
  }
}

