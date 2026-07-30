/**
 * tests/events-compaction-cap.test.mjs
 *
 * The hard cap in compactEvents must never delete a just-ingested event.
 *
 * Production, 2026-07-30: the events store held 359 records, ALL of them
 * status "pending" (nothing ever transitions them), against MAX_EVENTS = 300.
 * The cap computed `slice(0, MAX_EVENTS - mustKeep.length)` → `slice(0, -59)`,
 * and a negative end index slices from the END — so every evictable event was
 * discarded, newest first, on every run. poll-ingest reported
 * `ingested: 19, zoom.ingested: 15` while the store returned to exactly 359
 * each time. The reported `eventsCompacted: 34` was a count of data destroyed,
 * not of housekeeping done. Three weeks of Zoom recaps could not be backfilled
 * because of it.
 *
 * Contract-lock (house pattern): the cap decision is reimplemented below. If
 * compactEvents changes behaviour, update BOTH.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const MAX_EVENTS = 300;
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Mirror of the hard-cap branch in compactEvents. */
function applyCap(all, now = Date.now()) {
  const cutoff = now - PRUNE_AGE_MS;
  if (all.length <= MAX_EVENTS) return all;
  const isOperational = (e) =>
    e.status === "pending" || e.status === "executing" || e.status === "approved";
  const isRecent = (e) => new Date(e.createdAt).getTime() > cutoff;
  const protectedEvents = all.filter((e) => isOperational(e) || isRecent(e));
  const evictable = all
    .filter((e) => !isOperational(e) && !isRecent(e))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const room = Math.max(0, MAX_EVENTS - protectedEvents.length);
  return [...protectedEvents, ...evictable.slice(0, room)];
}

const iso = (msAgo, now = Date.now()) => new Date(now - msAgo).toISOString();

test("source no longer computes a negative slice bound", () => {
  const src = read("lib/events/store.ts");
  assert.ok(!/\.slice\(0,\s*MAX_EVENTS - mustKeep\.length\)/.test(src),
    "slice(0, MAX_EVENTS - mustKeep.length) goes negative and deletes from the end");
  assert.ok(/Math\.max\(0,\s*MAX_EVENTS - /.test(src),
    "the cap's end index must be clamped at 0");
});

test("behaviour: the exact production shape — 359 pending vs a 300 cap", () => {
  const now = Date.now();
  // 359 old pending events, exactly as observed in production.
  const stored = Array.from({ length: 359 }, (_, i) => ({
    id: `old-${i}`, status: "pending", source: "slack",
    createdAt: iso(30 * 24 * 3600_000 + i * 1000, now), // ~30 days old
  }));
  // A poll ingests 34 fresh records (19 regular + 15 zoom), as reported.
  const fresh = Array.from({ length: 34 }, (_, i) => ({
    id: `new-${i}`, status: "acknowledged", source: i < 15 ? "zoom_email" : "email",
    createdAt: iso(1000 - i, now),
  }));

  const kept = applyCap([...stored, ...fresh], now);
  const keptIds = new Set(kept.map((e) => e.id));

  for (const f of fresh) {
    assert.ok(keptIds.has(f.id),
      `just-ingested ${f.id} was deleted by the cap — this is the production bug`);
  }
  assert.equal(kept.filter((e) => e.source === "zoom_email").length, 15,
    "all 15 zoom recaps must survive compaction");
});

test("behaviour: the cap still evicts genuinely old resolved events", () => {
  const now = Date.now();
  const oldPending = Array.from({ length: 250 }, (_, i) => ({
    id: `p-${i}`, status: "pending", createdAt: iso(30 * 24 * 3600_000 + i * 1000, now),
  }));
  const oldResolved = Array.from({ length: 200 }, (_, i) => ({
    id: `r-${i}`, status: "acknowledged", createdAt: iso(30 * 24 * 3600_000 + i * 1000, now),
  }));

  const kept = applyCap([...oldPending, ...oldResolved], now);
  assert.equal(kept.length, MAX_EVENTS, "with room to spare the cap is still enforced");
  assert.equal(kept.filter((e) => e.status === "pending").length, 250, "pending is never evicted");
  assert.equal(kept.filter((e) => e.status === "acknowledged").length, 50,
    "the newest 50 resolved events fill the remaining room");
});

test("behaviour: an oversized protected set is kept, not silently truncated", () => {
  const now = Date.now();
  const all = Array.from({ length: 400 }, (_, i) => ({
    id: `p-${i}`, status: "pending", createdAt: iso(30 * 24 * 3600_000 + i * 1000, now),
  }));
  const kept = applyCap(all, now);
  assert.equal(kept.length, 400,
    "staying over the cap beats deleting live records — losing data is the worse failure");

  const src = read("lib/events/store.ts");
  assert.ok(/console\.warn\(/.test(src.slice(src.indexOf("Hard cap"))),
    "an intentionally oversized store must announce itself — silence is how this hid");
});
