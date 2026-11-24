// Audit 2026-11-24, Part 3 entry 16: relationship nudges as a weekly push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const R = loadTs("lib/contacts/reach-out-shape.ts");
const ch = (over) => ({ id: Math.random().toString(36), category: "relationship", severity: "high", score: 0.5, title: "Stakeholder has gone quiet", subject: "Jane Doe", context: "Jane Doe — no activity for 21 days", occurredAt: "", source: "contacts", seen: false, ...over });

test("cadence breaches, key people quiet and cooling tone make the list, strongest first, deduped", () => {
  const list = R.reachOutList([
    ch({ subject: "Tom Smith", context: "Tom Smith — 40 days since contact; you asked to stay in touch every 30 days", severity: "critical", score: 0.9 }),
    ch({ subject: "Ann Lee", title: "Stakeholder cooling", context: "Ann Lee — shorter replies", severity: "critical", score: 0.8 }),
    ch({ score: 0.5 }),
    ch({ score: 0.4 }),
    ch({ subject: "Low One", severity: "medium", score: 0.95 }),
    ch({ subject: "Engaged", title: "Stakeholder re-engaged", score: 0.99 }),
  ]);
  assert.equal(JSON.stringify(list.map((p) => [p.name, p.why])), JSON.stringify([
    ["Tom Smith", "40 days, you said every 30"], ["Ann Lee", "tone cooling"], ["Jane Doe", "21 days quiet"],
  ]));
});

test("at most 5 people; nothing to say → no push", () => {
  const many = Array.from({ length: 9 }, (_, i) => ch({ subject: `Person ${i}`, score: i / 10 }));
  assert.equal(R.reachOutList(many).length, 5);
  assert.equal(R.reachOutNotification([]), null);
  const n = R.reachOutNotification(R.reachOutList([ch({})]));
  assert.equal(n.title, "Reach out to Jane Doe this week");
  assert.match(n.body, /^Jane \(21 days quiet\)\./);
});

test("cron: weekly, an hour into the first working day, behind its own choice, once", () => {
  const src = readFileSync(new URL("../app/api/cron/reminders/route.ts", import.meta.url), "utf8");
  assert.match(src, /hour === startHour\(settings\.workStart\) \+ 1/);
  assert.match(src, /rstate\.prefs\.relationships/);
  assert.match(src, /isFirstWorkingDayOfWeek\(rday, rcal\)/);
  assert.match(src, /onceKeys: \[`reach-out:\$\{rday\}`\]/);
  assert.match(readFileSync(new URL("../lib/contacts/reach-out.ts", import.meta.url), "utf8"), /computeDeltas\(/);
});
