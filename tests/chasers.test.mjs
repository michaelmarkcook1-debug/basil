// Audit 2026-11-24, Part 3 entry 14: chasers for what others owe the user.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const C = loadTs("lib/actions/chasers.ts", { "@/lib/actions/utils": loadTs("lib/actions/utils.ts", {}) });
const now = Date.parse("2026-11-24T09:00:00Z");
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();
const act = (over = {}) => ({ id: "a1", text: "Send the signed SOW", owner: "Olivia Price", status: "open", createdAt: daysAgo(8), updatedAt: daysAgo(6), ...over });
const self = ["michael cook"];

test("waiting 5+ days and quiet 3+ days: chased, longest wait first", () => {
  const list = C.chaseCandidates([act(), act({ id: "a2", owner: "Tom Smith", createdAt: daysAgo(12), updatedAt: daysAgo(4) })], self, now);
  assert.equal(JSON.stringify(list.map((c) => [c.action.id, c.days])), JSON.stringify([["a2", 12], ["a1", 8]]));
});

test("the user's own items, done, in review, too new or recently active are not chased", () => {
  for (const a of [act({ owner: "Michael" }), act({ status: "done" }), act({ needsReview: true }), act({ createdAt: daysAgo(3) }), act({ lastActivityAt: daysAgo(1) }), act({ createdAt: daysAgo(45), updatedAt: daysAgo(40) })]) {
    assert.equal(C.chaseCandidates([a], self, now).length, 0, JSON.stringify(a));
  }
});

test("delegated items count from the day they were handed over", () => {
  const list = C.chaseCandidates([act({ owner: "Michael", delegatedTo: "Olivia Price", delegatedAt: daysAgo(6), createdAt: daysAgo(30), updatedAt: daysAgo(6) })], self, now);
  assert.equal(list.length, 1);
  assert.equal(list[0].days, 6);
  assert.equal(list[0].who, "Olivia Price");
});

test("once a week per item", () => {
  const week = Math.floor(now / (7 * 86_400_000));
  assert.equal(C.chaseKey("a1", now), `chase:a1:w${week}`);
  assert.notEqual(C.chaseKey("a1", now), C.chaseKey("a1", now + 7 * 86_400_000));
});

test("the draft chaser and the push", () => {
  const [c] = C.chaseCandidates([act()], self, now);
  const d = C.chaserDraft(c, "Michael");
  assert.equal(d.subject, "Following up: Send the signed SOW");
  assert.match(d.body, /^Hi Olivia,\n\nJust checking in on send the signed SOW\./);
  assert.match(d.body, /Thanks,\nMichael$/);
  const n = C.chaseNotification([c]);
  assert.equal(n.title, "Olivia owes you something, 8 days");
  assert.equal(C.chaseNotification([]), null);
});

test("cron: at most 3 a morning, drafts only with a known address, queued as pending, never sent", () => {
  const src = readFileSync(new URL("../app/api/cron/reminders/route.ts", import.meta.url), "utf8");
  assert.match(src, /\.slice\(0, MAX_PER_DAY\)/);
  assert.match(src, /if \(!email\) continue;/);
  assert.match(src, /status: "pending",\s+actionType: "send_email"/);
  assert.doesNotMatch(src, /sendEmail\(/);
  assert.equal(C.MAX_PER_DAY, 3);
});
