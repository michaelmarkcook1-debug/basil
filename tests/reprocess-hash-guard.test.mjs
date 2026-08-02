/**
 * tests/reprocess-hash-guard.test.mjs
 *
 * The daily reprocess cron must not re-classify content it has already seen.
 *
 * Measured on production 2026-07-30 from the real spend log:
 *   classify:slack = $14.63 of a $18.53 day (79%), essentially all of it inside
 *   the 06:00 UTC /api/cron/reprocess run — on a day the owner never opened the
 *   app. 2,438 calls / 19.4M input tokens for the month.
 *
 * The cause was subtle: reprocess DID compute hashContent(...) and DID call
 * recordIngest with it — so the guard looked present — but it never read the
 * hash back before classifying. It wrote a skip-marker it never honoured, so
 * every Slack/Teams thread in the window was re-classified from scratch every
 * morning whether or not a word had changed. poll-ingest had the read-side
 * check all along; reprocess simply never gained it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const reprocess = read("app/api/events/reprocess/route.ts");

test("reprocess checks the ingest hash before paying for classification", () => {
  assert.ok(/isHashUnchanged/.test(reprocess),
    "reprocess must READ the hash guard, not only write it");

  for (const [label, classifier] of [["slack", "classifySlack("], ["teams", "classifyTeams("]]) {
    const at = reprocess.indexOf(classifier);
    assert.ok(at > -1, `${label} classifier must still be present`);
    const before = reprocess.slice(0, at);
    const guardAt = before.lastIndexOf("isHashUnchanged");
    assert.ok(guardAt > -1,
      `${label}: the unchanged-content check must run BEFORE the AI call, not after`);
    // The guard must actually short-circuit, not merely be evaluated.
    assert.ok(/continue;/.test(before.slice(guardAt)),
      `${label}: an unchanged item must be skipped outright`);
  }
});

test("the hash that gates the skip is the hash that gets recorded", () => {
  // Recomputing it separately invites the two drifting apart, which would make
  // every item look changed forever and silently restore the old bill.
  assert.ok(/hash: slackHash/.test(reprocess),
    "slack must record the same hash value the guard compared");
  assert.ok(!/hash: hashContent\(channelName, transcript\)/.test(reprocess),
    "no re-derived hash at the record site — reuse the compared value");
});

test("skips are counted and logged", () => {
  assert.ok(/skippedUnchanged/.test(reprocess), "skips must be counted");
  assert.ok(/skipped as unchanged/.test(reprocess),
    "the count must be logged — if it collapses to 0 the guard has broken and the bill climbs again");
});

test("poll-ingest keeps its own guard (no regression)", () => {
  const poll = read("app/api/events/poll-ingest/route.ts");
  assert.ok((poll.match(/isHashUnchanged/g) || []).length >= 2,
    "poll-ingest must retain its unchanged-content checks");
});
