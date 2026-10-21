// The facts behind a tone read: each person judged against their OWN habits.
// A terse writer who is always terse must not read as cooling; a chatty one who
// goes short, slow and quiet must. (docs/tone-sentiment-review-2026-10-21.md §4.1)
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const R = loadTs("lib/contacts/relationship-signals.ts");
const NOW = Date.parse("2026-10-21T12:00:00Z");
const at = (daysAgo, h = 0) => new Date(NOW - daysAgo * 86_400_000 + h * 3_600_000).toISOString();
const theirs = (daysAgo, text, h = 0) => ({ date: at(daysAgo, h), mine: false, text, source: "slack" });
const mine = (daysAgo, text, h = 0) => ({ date: at(daysAgo, h), mine: true, text, source: "slack" });

// 90 days of a person who always writes 3-word replies within about an hour.
function terseHistory() {
  const msgs = [];
  for (let d = 88; d >= 2; d -= 3) { msgs.push(mine(d, "Can you look at the numbers for Thursday please?")); msgs.push(theirs(d, "Yes, on it.", 1)); }
  return msgs;
}

test("baseline: a terse writer's own normal is short and quick", () => {
  const b = R.baselineOf(terseHistory());
  assert.ok(b.n >= 25, `n=${b.n}`);
  assert.equal(b.medianWords, 3);
  assert.ok(b.shortShare > 0.9);
  assert.equal(b.medianReplyHours, 1);
});

test("a terse writer who is still terse and quick: no facts flag a change", () => {
  const all = terseHistory();
  const b = R.baselineOf(all);
  const recent = all.filter((m) => Date.parse(m.date) > NOW - 30 * 86_400_000);
  const facts = R.describeSignals(b, R.recentSignals(recent, b, NOW));
  assert.ok(facts.some((f) => /mostly one-liners/.test(f)), facts.join(" | "));
  assert.ok(!facts.some((f) => /half their usual|Quiet for|slower|Starting fewer/.test(f)), facts.join(" | "));
  assert.ok(facts.some((f) => /as usual/.test(f)), "reply time reads as usual: " + facts.join(" | "));
});

test("a chatty, quick writer who goes short and slow: the facts say so", () => {
  const msgs = [];
  // Baseline: 60–31 days ago, 40-word replies within 2 hours, and they start half the threads.
  // Threads are 3+ days apart so each opener counts as an initiation: the user
  // opens one, they open the next.
  for (let d = 88; d > 30; d -= 6) {
    msgs.push(mine(d, "Could you send the latest deck when you have a moment?"));
    msgs.push(theirs(d, "Absolutely, here it is with the revised numbers and a note on the two scenarios we discussed, plus the appendix the board asked for last time; shout if anything is missing or unclear and I will turn it round today.", 2));
    msgs.push(mine(d, "Perfect, thank you.", 3));
    msgs.push(theirs(d - 3, "Quick thought on the partner list: I think we should add two more names before Friday, ideally the two from the Manchester event, since both asked for a follow-up and neither has heard from us yet."));
    msgs.push(mine(d - 3, "Good shout, add them.", 1));
  }
  // Recent: 10-word replies after 14 hours, and they start nothing.
  for (let d = 20; d >= 2; d -= 4) {
    msgs.push(mine(d, "Any update on the deck?"));
    msgs.push(theirs(d, "Will get to it tomorrow, few things on today.", 30));
  }
  // Baseline initiation share is ~0.5 (they open the partner-list threads); recently 0.
  const b = R.baselineOf(msgs);
  const recent = msgs.filter((m) => Date.parse(m.date) > NOW - 30 * 86_400_000);
  const sig = R.recentSignals(recent, b, NOW);
  assert.ok(sig.lengthRatio < 0.5, `lengthRatio ${sig.lengthRatio}`);
  assert.ok(sig.replyRatio > 3, `replyRatio ${sig.replyRatio}`);
  const facts = R.describeSignals(b, sig);
  assert.ok(facts.some((f) => /half their usual length/.test(f)), facts.join(" | "));
  assert.ok(facts.some((f) => /Replying in 30h, usually 2h/.test(f)), facts.join(" | "));
  assert.ok(facts.some((f) => /Starting fewer conversations/.test(f)), facts.join(" | "));
});

test("silence is measured against their own rhythm, not a fixed number of days", () => {
  // Someone who writes every day, then nothing for 12 days.
  const msgs = [];
  for (let d = 70; d >= 12; d -= 1) msgs.push(theirs(d, "Morning — here is today's update on the pipeline."));
  const b = R.baselineOf(msgs);
  const sig = R.recentSignals(msgs.filter((m) => Date.parse(m.date) > NOW - 30 * 86_400_000), b, NOW);
  assert.ok(sig.gapRatio >= 8, `gapRatio ${sig.gapRatio}`);
  assert.ok(R.describeSignals(b, sig).some((f) => /Quiet for 12 days/.test(f)));
  // Someone who writes every fortnight: the same 12 days is nothing.
  const slow = [];
  for (let d = 84; d >= 12; d -= 14) slow.push(theirs(d, "Fortnightly check-in: all fine my end."));
  const bs = R.baselineOf(slow);
  const ss = R.recentSignals(slow.filter((m) => Date.parse(m.date) > NOW - 30 * 86_400_000), bs, NOW);
  assert.ok(ss.gapRatio < 2, `gapRatio ${ss.gapRatio}`);
  assert.ok(!R.describeSignals(bs, ss).some((f) => /Quiet for/.test(f)));
});

test("no long history: no facts, so brevity is never read as a signal", () => {
  const few = [theirs(3, "ok"), theirs(2, "fine"), theirs(1, "yes")];
  assert.equal(R.describeSignals(R.baselineOf(few), R.recentSignals(few, R.baselineOf(few), NOW)).length, 0);
});

test("confidence: under 5 messages, or all inside one week, is an early read", () => {
  assert.equal(R.confidenceOf([theirs(1, "a"), theirs(2, "b"), theirs(3, "c"), theirs(4, "d")]), "early");
  assert.equal(R.confidenceOf(Array.from({ length: 8 }, (_, i) => theirs(i * 0.5, "x"))), "early", "8 messages but all in 4 days");
  assert.equal(R.confidenceOf(Array.from({ length: 8 }, (_, i) => theirs(i * 2, "x"))), "normal");
  assert.equal(R.confidenceOf(Array.from({ length: 16 }, (_, i) => theirs(i * 1.5, "x"))), "grounded");
  // The user's own messages never count toward confidence in the other person.
  assert.equal(R.confidenceOf([...Array.from({ length: 20 }, (_, i) => mine(i, "x")), theirs(1, "y")]), "early");
});
