/**
 * Commitments file themselves and agree across the app (2026-11-24).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("unsorted open commitments are sorted in the background and in the daily run", () => {
  assert.match(src("app/api/actions/route.ts"), /after\(\(\) => sortOpenActions\(username\)/);
  assert.match(src("app/api/events/reprocess/route.ts"), /sortOpenActions\(username!, \{ force: true \}\)/);
  const sorter = src("lib/workstreams/sort-actions.ts");
  assert.match(sorter, /!store\.verdicts\[actionKey\(a\.id\)\]/, "only commitments without a verdict");
  assert.match(sorter, /MIN_GAP_MS = 10 \* 60 \* 1000/, "at most every 10 minutes from page reads");
});

test("Today drops commitments completed or removed since its cached copy", () => {
  assert.match(src("app/api/today/route.ts"), /i\.change\.source === "actions" && i\.change\.entityId && !open\.has\(i\.change\.entityId\)/);
});
