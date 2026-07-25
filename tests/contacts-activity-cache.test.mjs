/**
 * tests/contacts-activity-cache.test.mjs
 *
 * /api/contacts/activity fans out across Calendar + Gmail + Slack + Drive +
 * Memory + Linear and took ~14s on EVERY request (People was the slowest surface
 * in the app; it was the only data route with no cache at all). It now serves
 * stale-while-revalidate off the per-user generate-cache: 14,000ms → ~194ms.
 *
 * The counter-trap this locks down: a cache that outlives a MUTATION. Deleting a
 * contact left the 30-minute cache serving the old list, so the deleted person
 * kept appearing on People — which reads as "the delete didn't work". Every
 * contact mutation must therefore invalidate the cache.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const activity = read("app/api/contacts/activity/route.ts");
const cacheStore = read("lib/generate-cache/store.ts");
const byId = read("app/api/contacts/user/[id]/route.ts");
const collection = read("app/api/contacts/user/route.ts");

test("activity is cached, and serves stale instantly rather than blocking", () => {
  assert.ok(/readGenerateCache<ActivityPayload>\(username, "contact-activity"/.test(activity),
    "activity must read the per-user cache");
  assert.ok(/writeGenerateCache\(username, "contact-activity"/.test(activity),
    "activity must populate the cache");
  assert.ok(/after\(/.test(activity),
    "a stale entry must refresh in the BACKGROUND via after(), never make the user wait 14s");
  assert.ok(/cache: "stale"/.test(activity) && /cache: "hit"/.test(activity),
    "responses must report cache state so this is verifiable from the client");
});

test("the cache type + TTL exist and the TTL stays short", () => {
  assert.ok(/\| "contact-activity"/.test(cacheStore), "CacheType must include contact-activity");
  const m = cacheStore.match(/CONTACT_ACTIVITY_TTL_MS\s*=\s*([\d\s*_]+);/);
  assert.ok(m, "CONTACT_ACTIVITY_TTL_MS must be defined");
  // eslint-disable-next-line no-eval
  const ttl = eval(m[1].replace(/_/g, ""));
  assert.ok(ttl <= 60 * 60 * 1000, `TTL (${ttl}ms) should stay <= 1h — activity shifts as mail/meetings land`);
});

test("after() work fits the route budget", () => {
  const m = activity.match(/maxDuration\s*=\s*(\d+)/);
  assert.ok(m, "activity must declare maxDuration — after() runs on the same invocation");
  // Cold compute measured ~14-19s; the background refresh pays that again.
  assert.ok(Number(m[1]) >= 60, `maxDuration (${m?.[1]}s) must cover a full ~19s recompute in after()`);
});

test("the invalidated cache is read FRESH, or invalidation cannot work", () => {
  // /tmp is per-lambda-instance and has no TTL. deleteGenerateCache() clears
  // /tmp only on the instance that served the delete, so any other warm
  // instance keeps serving a deleted contact. Blob is the only cross-instance
  // truth — this cache must bypass /tmp.
  assert.ok(/readGenerateCache<ActivityPayload>\(username, "contact-activity", \{ fresh: true \}\)/.test(activity),
    "activity must read the cache with { fresh: true } — a /tmp hit defeats invalidation across instances");
  assert.ok(/fresh\?: boolean/.test(cacheStore) && /\{ fresh: opts\?\.fresh \}/.test(cacheStore),
    "readGenerateCache must support and forward the fresh option");
});

test("future meetings do NOT count as interactions", () => {
  // The month window includes upcoming events; without an end<=now bound,
  // recurring standups weeks ahead inflated lastInteraction into the FUTURE
  // ("last interaction: Jul 31" reported on Jul 19).
  assert.ok(/new Date\(event\.end \|\| event\.start\)\.getTime\(\) > nowMs\) continue/.test(activity),
    "calendar interactions must exclude events that haven't ended yet");
});

test("EVERY contact mutation invalidates the activity cache", () => {
  // Without this, a deleted contact keeps showing on People for 30 minutes.
  for (const [name, src] of [["contacts/user/[id]", byId], ["contacts/user", collection]]) {
    assert.ok(/deleteGenerateCache\(username, "contact-activity"\)/.test(src),
      `${name} must invalidate the activity cache on mutation`);
  }
  // PATCH + DELETE + POST(add) + POST(bulk import) = 4 mutation paths.
  const calls = (byId.match(/invalidateActivityCache\(username\)/g) || []).length
              + (collection.match(/invalidateActivityCache\(username\)/g) || []).length;
  assert.ok(calls >= 4, `expected every mutation path to invalidate; found ${calls}`);
});
