// Audit 2026-11-24, Part 3 entry 10: urgent messages pushed in real time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const R = loadTs("lib/notify/urgent-rules.ts");
const now = Date.parse("2026-11-24T11:00:00Z");
const base = { source: "email", urgency: "high", category: "action_required", confidence: 0.85, from: "Jane Doe <jane@acme.com>", text: "Contract", actionText: "Sign the order form today", ref: "gmail:1", date: "2026-11-24T10:30:00Z" };

test("high-urgency asks with confidence ≥ 0.7 are urgent", () => {
  assert.equal(R.isUrgent(base), true);
  assert.equal(R.isUrgent({ ...base, confidence: 0.65 }), false);
  assert.equal(R.isUrgent({ ...base, category: "informational_only" }), false);
  assert.equal(R.isUrgent({ ...base, urgency: "medium" }), false);
});

test("legal, money and investor mail is urgent at medium urgency", () => {
  assert.equal(R.isUrgent({ ...base, urgency: "medium", category: "informational_only", text: "Re: term sheet", confidence: 0.62 }), true);
  assert.equal(R.isUrgent({ ...base, urgency: "medium", category: "informational_only", text: "Payment failed for invoice 1043" }), true);
  assert.equal(R.isUrgent({ ...base, urgency: "low", category: "informational_only", text: "Our lawyer says hi" }), false);
  assert.equal(R.isUrgent({ ...base, urgency: "medium", category: "informational_only", text: "Lunch on Friday?" }), false);
});

test("Slack/Teams channel chatter never pushes; DMs and addressed messages can", () => {
  const slack = { ...base, source: "slack", category: "escalation" };
  assert.equal(R.isUrgent({ ...slack, addressed: false }), false);
  assert.equal(R.isUrgent({ ...slack, addressed: true }), true);
});

test("only fresh messages: never a backfill or a reprocess of old mail", () => {
  assert.equal(R.isFresh("2026-11-24T10:30:00Z", now), true);
  assert.equal(R.isFresh("2026-11-24T07:30:00Z", now), false);
  assert.equal(R.isFresh("not a date", now), false);
});

test("working hours in the user's time zone", () => {
  assert.equal(R.inWorkingHours(now, "Europe/London", "09:00", "18:00"), true);
  assert.equal(R.inWorkingHours(Date.parse("2026-11-24T07:30:00Z"), "Europe/London", "09:00", "18:00"), false);
  assert.equal(R.inWorkingHours(Date.parse("2026-11-24T18:00:00Z"), "Europe/London", "09:00", "18:00"), false);
  // 11:00 UTC is 06:00 in New York.
  assert.equal(R.inWorkingHours(now, "America/New_York", "09:00", "18:00"), false);
  // Overnight shift.
  assert.equal(R.inWorkingHours(Date.parse("2026-11-24T23:00:00Z"), "Europe/London", "22:00", "06:00"), true);
});

test("the push names the source and sender, and opens Basil", () => {
  const n = R.urgentNotification(base);
  assert.equal(n.kind, "urgent");
  assert.equal(n.title, "Urgent · Email from Jane Doe");
  assert.equal(n.body, "Sign the order form today");
  assert.equal(n.tag, "urgent:gmail:1");
});

test("gates: off-hours, away, daily cap of 5, once per message, never throws", () => {
  const src = readFileSync(new URL("../lib/notify/urgent.ts", import.meta.url), "utf8");
  assert.match(src, /if \(!isFresh\(s\.date, now\)\) return \{ skipped: "stale" \}/);
  assert.match(src, /st === "away" \|\| st === "non-working"/);
  assert.match(src, /sentToday >= DAILY_CAP/);
  assert.match(src, /onceKeys: \[`urgent:\$\{today\}:\$\{s\.ref\}`\]/);
  assert.equal(R.DAILY_CAP, 5);
  for (const f of ["lib/email/materialize-email.ts", "lib/slack/materialize-slack.ts", "lib/teams/materialize-teams.ts"]) {
    assert.match(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /if \(actionsCreated > 0\) \{\n\s+(const addressed[^\n]*\n\s+)?await pushIfUrgent\(username,/, f);
  }
});

test("urgent is a notification choice, on by default", () => {
  const rules = readFileSync(new URL("../lib/notify/rules.ts", import.meta.url), "utf8");
  assert.match(rules, /urgent: true/);
  assert.match(readFileSync(new URL("../components/settings/notifications-card.tsx", import.meta.url), "utf8"), /key: "urgent"/);
});
