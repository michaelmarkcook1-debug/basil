// Audit 2026-11-24, Part 3 entry 19: briefing history — "on your list since…".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const H = loadTs("lib/briefing/history.ts");

test("items are the bullet lines of a section", () => {
  assert.equal(JSON.stringify(H.itemsOf("- **Reply to Jane** about the Acme SOW\n2. Book the board pre-read slot\nok\n")), JSON.stringify(["Reply to Jane about the Acme SOW", "Book the board pre-read slot"]));
  assert.equal(H.itemsOf(null).length, 0);
});

test("the same item reworded is recognised; different items are not", () => {
  assert.equal(H.sameItem("Reply to Jane about the Acme SOW", "Jane still needs the Acme SOW reply"), true);
  assert.equal(H.sameItem("Reply to Jane about the Acme SOW", "Book the board pre-read slot"), false);
});

test("history keeps 60 days, one entry per day, newest first", () => {
  let h = [];
  h = H.withDay(h, "2026-09-01", ["old"]);
  h = H.withDay(h, "2026-11-20", ["a"]);
  h = H.withDay(h, "2026-11-20", ["a2"]);
  h = H.withDay(h, "2026-11-24", ["b"]);
  assert.equal(JSON.stringify(h.map((d) => [d.day, d.items[0]])), JSON.stringify([["2026-11-24", "b"], ["2026-11-20", "a2"]]));
});

test("recurring: items from the last briefing seen on 3+ days, with since and count", () => {
  const h = [
    { day: "2026-11-21", items: ["Reply to Jane about the Acme SOW", "Book the board pre-read slot"] },
    { day: "2026-11-20", items: ["Jane still needs the Acme SOW reply"] },
    { day: "2026-11-18", items: ["Reply to Jane re Acme SOW"] },
    { day: "2026-11-24", items: ["today's own run is ignored"] },
  ];
  const r = H.recurringItems(h, "2026-11-24");
  assert.equal(r.length, 1);
  assert.equal(r[0].text, "Reply to Jane about the Acme SOW");
  assert.equal(r[0].days, 3);
  assert.equal(r[0].since, "2026-11-18");
  const block = H.recurringBlock(r, "Michael");
  assert.match(block, /in 3 briefings since 2026-11-18/);
  assert.match(block, /If the sources show it was done, leave it out/);
  assert.equal(H.recurringBlock([], "Michael"), "");
});

test("the briefing reads the history into its prompt and records each morning's items", () => {
  const b = readFileSync(new URL("../app/api/generate/briefing/route.ts", import.meta.url), "utf8");
  assert.match(b, /recurringItems\(await readBriefingHistory\(username\), todayDate\)/);
  assert.match(b, /\$\{catchUpBlock\}\$\{recurringText \?/);
  assert.match(b, /if \(briefingType === "morning"\) await recordBriefingDay\(username, todayDate, briefingData\);/);
});
