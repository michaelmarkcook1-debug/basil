/**
 * tests/follow-up-rules.test.mjs
 *
 * Standing follow-up rules ("follow up with demo attendees two weeks after
 * each demo") are stored in memory by chat and applied to NEW calendar events
 * by the daily poll-ingest cron.
 *
 * The dangers, in order: creating DUPLICATES on every cron run, resurrecting a
 * follow-up the user already completed, spamming follow-ups for solo calendar
 * blocks, and shifting dates across the BST boundary. All four are pinned here.
 *
 * House pattern (same as resolve-calendar.test.mjs): source assertions on the
 * real module + a contract-lock reimplementation of the core decision logic.
 * If lib/actions/follow-up-rules.ts changes behaviour, update BOTH.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const mod = read("lib/actions/follow-up-rules.ts");
const poll = read("app/api/events/poll-ingest/route.ts");

// ── Source assertions ────────────────────────────────────────────────────────

test("the module encodes its safety guarantees", () => {
  assert.ok(/CANONICAL_RE/.test(mod) && /FOLLOW-UP RULE:/.test(mod),
    "must parse the canonical format the prompt instructs Basil to save");
  assert.ok(/LOOSE_RE/.test(mod),
    "must also parse natural-prose rules saved before the canonical format existed");
  assert.ok(/attendees \?\? \[\]\)\.length === 0\) continue/.test(mod),
    "an event with no other attendees (focus blocks, lunch) must never generate a follow-up");
  // The word "attendees" in the PROSE of the template is fine; an INTERPOLATION
  // of the attendee list (`${...attendees...}`) is what would defeat dedupe.
  const textTemplate = mod.slice(mod.indexOf("const text ="), mod.indexOf("const text =") + 200);
  assert.ok(/NO attendee names/.test(mod) && !/\$\{[^}]*attendees[^}]*\}/.test(textTemplate),
    "generated text must not interpolate attendee names — they change between runs and defeat dedupe");
  assert.ok(/Date\.UTC\(/.test(mod),
    "date arithmetic must run on pure date parts via UTC (the BST toISOString trap)");
  assert.ok(/existing\.has\(key\)/.test(mod),
    "idempotency must check against existing actions of ANY status");
});

test("the cron wires rules in with a cap, logging, and local-date today", () => {
  assert.ok(/extractFollowUpRules\(memories\)/.test(poll) && /applyFollowUpRules\(rules, windowEvents/.test(poll),
    "poll-ingest must apply stored rules to the calendar window");
  assert.ok(/toLocaleDateString\("en-CA"\)/.test(poll.slice(poll.indexOf("Standing follow-up rules"))),
    "today must be the LOCAL date (en-CA), never toISOString — the BST trap");
  assert.ok(/candidates\.slice\(0, CAP\)/.test(poll) && /capped at \$\{CAP\}/.test(poll),
    "the per-run cap must exist AND be logged when it truncates — no silent caps");
});

// ── Contract lock: reimplements extraction + application ─────────────────────

const WORDS = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10 };
const CANON = /FOLLOW-UP RULE:\s*match\s*"([^"]{2,60})"[\s\S]{0,120}?offset\s*(\d+)\s*days?/i;
const LOOSE = /follow[\s-]?up[\s\S]{0,80}?\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(days?|weeks?|months?)\s+after\s+(?:each|every|all|any|a|the)\s+([a-z][a-z0-9 -]{2,40})/i;
const extract = (content) => {
  const c = CANON.exec(content);
  if (c) return { keyword: c[1].toLowerCase(), offsetDays: parseInt(c[2], 10) };
  const l = LOOSE.exec(content);
  if (!l) return null;
  const n = /^\d+$/.test(l[1]) ? +l[1] : WORDS[l[1].toLowerCase()];
  const mult = l[2].startsWith("week") ? 7 : l[2].startsWith("month") ? 30 : 1;
  return { keyword: l[3].replace(/\s*(call|meeting|session|event|invite)s?\s*$/i, "").trim().toLowerCase(), offsetDays: n * mult };
};
const addDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,"0")}-${String(t.getUTCDate()).padStart(2,"0")}`;
};

test("behaviour: canonical and loose rule phrasings both extract", () => {
  assert.deepEqual(
    extract('FOLLOW-UP RULE: match "demo" — follow up with attendees — offset 14 days'),
    { keyword: "demo", offsetDays: 14 });
  assert.deepEqual(
    extract("Michael wants to follow up with attendees two weeks after each demo"),
    { keyword: "demo", offsetDays: 14 });
  assert.deepEqual(
    extract("follow up 3 days after every QBR meeting"),
    { keyword: "qbr", offsetDays: 3 },
    "trailing generic words (meeting/call) must be stripped from the keyword");
  assert.equal(extract("remember that Malcolm prefers short emails"), null,
    "unrelated memories must not become rules");
});

test("behaviour: date arithmetic is BST-safe", () => {
  // 2026-07-30 + 14 = 2026-08-13 (the real Kyndryl-era case). A local-midnight
  // Date + toISOString() in BST yields the PREVIOUS day — this must not.
  assert.equal(addDays("2026-07-30", 14), "2026-08-13");
  assert.equal(addDays("2026-08-03", 14), "2026-08-17");
  assert.equal(addDays("2026-03-28", 5), "2026-04-02", "crosses the BST switch-over");
  assert.equal(addDays("2026-01-01", -2), "2025-12-30", "negative offsets cross year boundary");
});

test("behaviour: idempotency, solo-event and stale skips", () => {
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const events = [
    { summary: "AnalystGenius Demo", start: "2026-07-30T14:00", attendees: ["regina@pwc.com"] },
    { summary: "Focus time (demo prep)", start: "2026-07-30T09:00", attendees: [] },      // solo
    { summary: "AnalystGenius Demo", start: "2026-05-01T14:00", attendees: ["x@y.com"] }, // stale
  ];
  const rule = { keyword: "demo", offsetDays: 14 };
  const today = "2026-07-28";
  const staleFloor = addDays(today, -2);
  const existing = new Set([norm('Follow up with attendees of "AnalystGenius Demo" (2026-07-30)')]);

  const out = [];
  for (const ev of events) {
    const day = ev.start.slice(0, 10);
    if ((ev.attendees ?? []).length === 0) continue;
    if (!ev.summary.toLowerCase().includes(rule.keyword)) continue;
    const dueDate = addDays(day, rule.offsetDays);
    if (dueDate < staleFloor) continue;
    const text = `Follow up with attendees of "${ev.summary}" (${day})`;
    if (existing.has(norm(text))) continue;
    out.push(text);
  }

  assert.deepEqual(out, [], [
    "run against a state where the follow-up ALREADY EXISTS (even completed):",
    "the real one is deduped, the solo focus block is skipped, the May demo is stale —",
    "a second cron run must create NOTHING",
  ].join(" "));

  // And with an empty tracker, exactly the one real demo generates a follow-up.
  const out2 = [];
  for (const ev of events) {
    const day = ev.start.slice(0, 10);
    if ((ev.attendees ?? []).length === 0) continue;
    if (!ev.summary.toLowerCase().includes(rule.keyword)) continue;
    const dueDate = addDays(day, rule.offsetDays);
    if (dueDate < staleFloor) continue;
    out2.push({ text: `Follow up with attendees of "${ev.summary}" (${day})`, dueDate });
  }
  assert.deepEqual(out2, [{ text: 'Follow up with attendees of "AnalystGenius Demo" (2026-07-30)', dueDate: "2026-08-13" }]);
});
