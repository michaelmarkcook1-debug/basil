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
import { warmEmailViews } from "@/lib/email/view-cache";
import { getTodayAway } from "@/lib/away/store";
import { overlayWorkstreams } from "@/lib/workstreams/classify";
import { feedSubject, workstreamTotals } from "@/lib/workstreams/attach";
import { isWorkstream, type Workstream } from "@/lib/workstreams/types";
import { readAutomation } from "@/lib/pipedrive/automation";
import { listActions } from "@/lib/actions/store";

/**
 * The user's latest corrections and rules over a cached feed (no classifier
 * call) — and Pipedrive follow-ups they dismissed or booked since it was cached,
 * and commitments completed or removed since (so Today and Actions agree).
 */
async function withCurrentWorkstreams(username: string, feed: TodayFeedResponse): Promise<TodayFeedResponse> {
  try {
    let base = feed.items ?? [];
    if (base.some((i) => i.kind === "change" && i.change.source === "actions")) {
      const open = await listActions(username).then(
        (all) => new Set(all.filter((a) => a.status !== "done").map((a) => a.id)),
        (e) => { console.warn("[today] actions unreadable for the overlay:", e instanceof Error ? e.message : e); return null; },
      );
      if (open) base = base.filter((i) => !(i.kind === "change" && i.change.source === "actions" && i.change.entityId && !open.has(i.change.entityId)));
    }
    if (base.some((i) => i.kind === "pipedrive" && i.followup)) {
      const auto = await readAutomation(username).catch((e) => {
        console.warn("[today] pipedrive automation unreadable:", e instanceof Error ? e.message : e);
        return null;
      });
      if (auto) base = base.filter((i) => !(i.kind === "pipedrive" && i.followup && (auto.mode === "off" || auto.dismissed[i.followup.id] || auto.booked[i.followup.id])));
    }
    const items = await overlayWorkstreams(username, base, (i) => feedSubject(i));
    return { ...feed, items, workstreamTotals: workstreamTotals(items) };
  } catch {
    return feed;
  }
}
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
/** Gmail message ids behind the feed's email cards, in rank order. */
function emailIdsOf(feed: TodayFeedResponse): string[] {
  return (feed.items ?? []).flatMap((i) =>
    i.kind === "followup" && i.followup.source === "gmail" ? [i.followup.id.replace(/^gmail:/, "")] : []);
}

/** Pre-fetch those emails so opening one on Today is instant. After the response. */
function warmEmails(username: string, feed: TodayFeedResponse): void {
  const ids = emailIdsOf(feed);
  if (ids.length === 0) return;
  after(async () => {
    try {
      await warmEmailViews(username, ids);
    } catch (e) {
      console.warn("[today] email warm-up failed:", e instanceof Error ? e.message : e);
    }
  });
}

export async function GET(req: NextRequest) {
  const username = await getSessionUser();
  // ?full=1 — the whole queue, for /dashboard/threads. The cache holds the
  // uncapped feed; the cap is applied at presentation.
  const full = req.nextUrl.searchParams.get("full") === "1";
  // ?workstream=product — one workstream, filtered before the display cap.
  const wsParam = req.nextUrl.searchParams.get("workstream");
  const workstream: Workstream | "unsorted" | undefined = isWorkstream(wsParam) || wsParam === "unsorted" ? wsParam : undefined;
  const present = async (feed: TodayFeedResponse) => presentFeed(await withCurrentWorkstreams(username!, feed), { full, workstream });
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    // fresh: read Blob, not the per-instance /tmp copy — the whole point is a
    // cache that's shared across instances.
    // Away status is read on every request, never cached with the feed: it
    // changes at midnight and when the user says they are going or back.
    const [cached, away] = await Promise.all([
      readGenerateCache<TodayFeedResponse>(username, "today-feed", { fresh: true }),
      getTodayAway(username),
    ]);

    if (cached?.content) {
      if (isCacheValid(cached)) {
        warmEmails(username, cached.content);
        return NextResponse.json({ ...(await present(cached.content)), away, cache: "hit" });
      }
      // Stale: hand back what we have immediately, refresh after the response.
      after(async () => {
        try {
          const fresh = await computeTodayFeed(username);
          await writeGenerateCache(username, "today-feed", fresh, {
            inputHash: computeInputHash(username, fresh.generatedAt),
            ttlMs: TODAY_FEED_TTL_MS,
          });
          await warmEmailViews(username, emailIdsOf(fresh));
        } catch (e) {
          console.error("[today] background refresh failed:", e instanceof Error ? e.message : e);
        }
      });
      return NextResponse.json({ ...(await present(cached.content)), away, cache: "stale" });
    }

    // Cold start — pay for it once.
    const fresh = await computeTodayFeed(username);
    await writeGenerateCache(username, "today-feed", fresh, {
      inputHash: computeInputHash(username, fresh.generatedAt),
      ttlMs: TODAY_FEED_TTL_MS,
    }).catch((e) => console.error("[today] cache write failed:", e));
    warmEmails(username, fresh);
    return NextResponse.json({ ...(await present(fresh)), away, cache: "miss" });
  } catch (err) {
    console.error("[today]", err);
    return NextResponse.json({ error: "Failed to build today feed." }, { status: 500 });
  }
}

