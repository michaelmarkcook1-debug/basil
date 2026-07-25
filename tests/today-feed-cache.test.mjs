/**
 * tests/today-feed-cache.test.mjs
 *
 * Guards the fix for "latency is awful" — the home-screen Radar feed.
 *
 * /api/today ran its full Gmail + Slack + Linear + delta fan-out INLINE on
 * every load (~5s, measured live). The only mitigation was a 90s per-instance
 * memo inside detectPendingFollowups, which almost never hits in prod because
 * each lambda instance has its own memory. The fix lifts it to the repo's
 * Blob-backed stale-while-revalidate cache (the same pattern that took
 * /api/contacts/activity from 14s to ~200ms).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const route = read("app/api/today/route.ts");
const store = read("lib/generate-cache/store.ts");

test("/api/today serves from the shared SWR cache, not inline fan-out", () => {
  assert.ok(/readGenerateCache<TodayFeedResponse>\(username, "today-feed", \{ fresh: true \}\)/.test(route),
    "GET must read the shared today-feed cache with fresh:true (cross-instance, not /tmp)");
  assert.ok(/after\(async \(\) => \{/.test(route) && /cache: "stale"/.test(route),
    "a stale cache must be served instantly with an after() background refresh");
  assert.ok(/cache: "miss"/.test(route) && /writeGenerateCache\(username, "today-feed"/.test(route),
    "a cold start must compute once and write the cache");
});

test("the today-feed cache type + TTL exist, and the route budget covers after()", () => {
  assert.ok(/\| "today-feed"/.test(store), "generate-cache must define the today-feed CacheType");
  assert.ok(/export const TODAY_FEED_TTL_MS/.test(store), "TODAY_FEED_TTL_MS must be exported");
  assert.ok(/export const maxDuration = 120/.test(route),
    "maxDuration must cover the after() recompute (it runs on the same invocation)");
});
