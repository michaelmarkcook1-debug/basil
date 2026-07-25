/**
 * tests/audit2-fixes.test.mjs
 *
 * Guards the three fixes from the 2026-07-19 full audit:
 *
 * 1. Cmd-K quick-creates were DEAD: the palette linked to ?new=1 on
 *    actions/decisions/memory but none of the pages read the param — the
 *    shortcut navigated and silently did nothing.
 *
 * 2. Duplicate scheduling commitments: findDuplicate's fuzzy layers are
 *    time-bounded to 7 days, so a recurring calendar invite re-ingested later
 *    minted an IDENTICAL open action every time (fresh sourceRef per email ⇒
 *    layer 1 never fired). Observed live: 4 visible copies of one Olivia
 *    scheduling row, 16 duplicate open actions total. Also, Google's
 *    "Updated invitation:"/"Accepted:" subject churn generated differently-
 *    worded actions for the same event.
 *
 * 3. 422/432 open actions had NO dueDate: the prompt said "omit if none"
 *    (passive), and the synthesized scheduling path never set one even though
 *    Google puts the event date in the subject.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const actionsPage = read("app/dashboard/actions/page.tsx");
const decisionsPage = read("app/dashboard/decisions/page.tsx");
const memoryPage = read("app/dashboard/memory/page.tsx");
const palette = read("components/command-palette.tsx");
const store = read("lib/actions/store.ts");
const materialize = read("lib/email/materialize-email.ts");
const classify = read("lib/email/classify-email.ts");

test("every ?new=1 target advertised by the palette actually implements it", () => {
  // Derive the targets FROM the palette so adding a quick action without
  // wiring its page fails this test.
  const targets = [...palette.matchAll(/href: "([^"]+)\?new=1"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 3, `palette should advertise ≥3 quick-creates, found ${targets.length}`);
  const pageFor = {
    "/dashboard/actions": actionsPage,
    "/dashboard/decisions": decisionsPage,
    "/dashboard/memory": memoryPage,
  };
  for (const t of targets) {
    const src = pageFor[t];
    assert.ok(src, `no page source mapped for palette target ${t}`);
    assert.ok(/params\.get\("new"\)|p\.get\("new"\)/.test(src),
      `${t} must read the ?new param the palette advertises`);
    assert.ok(/searchParams\.delete\("new"\)/.test(src),
      `${t} must clean the ?new param so refresh doesn't re-trigger`);
  }
});

test("exact-duplicate open actions are merged at ANY age (Layer 0)", () => {
  assert.ok(/function normalizeExact/.test(store), "normalizeExact must exist");
  const fn = store.slice(store.indexOf("function findDuplicate"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  const layer0 = body.indexOf("normalizeExact(text) === normalizeExact(item.text)");
  const timeBound = body.indexOf("itemAge < sevenDaysAgo");
  assert.ok(layer0 > -1, "findDuplicate must compare exact normalized text");
  assert.ok(timeBound > -1 && layer0 < timeBound,
    "the exact-match layer must run BEFORE the 7-day bound, or old recurring invites still duplicate");
});

test("calendar-churn subject prefixes are canonicalised before action text", () => {
  assert.ok(/updated invitation:/i.test(materialize),
    "materialize must strip the 'Updated invitation:' prefix");
  assert.ok(/(accepted|declined|tentatively accepted)/i.test(materialize),
    "RSVP-churn prefixes must also canonicalise to Invitation:");
  const canonIdx = materialize.indexOf("canonicalSubject");
  const shortIdx = materialize.indexOf("const shortSubject");
  assert.ok(canonIdx > -1 && canonIdx < shortIdx,
    "canonicalisation must happen BEFORE truncation to shortSubject");
});

test("the classifier is told to ACTIVELY infer dueDate, with format", () => {
  assert.ok(/dueDate: format YYYY-MM-DD/.test(classify),
    "prompt must specify the dueDate format");
  assert.ok(/ACTIVELY infer/.test(classify),
    "prompt must instruct active inference, not the old passive 'omit if none'");
  assert.ok(/dueDate = the EVENT date/.test(classify),
    "invitations must map dueDate to the event date");
});

test("calendar attendance counts toward contact recency (gone-quiet accuracy)", () => {
  const touch = read("lib/contacts/touch-recency.ts");
  const poll = read("app/api/events/poll-ingest/route.ts");
  // The "Stakeholder has gone quiet" signal reads contact.lastInteraction, which
  // was only ever advanced by Slack + Zoom touches — someone you meet 3×/week in
  // a recurring standup still read as silent (observed: Trey Carlson flagged
  // "no activity for 13 days" two days after a shared accepted meeting).
  assert.ok(/email\?: string/.test(touch),
    "RecencyTouch must carry an email — calendar attendees are often raw emails");
  assert.ok(/c\.email\?\.trim\(\)\.toLowerCase\(\) === emailLower/.test(touch),
    "matcher must try exact email equality before name heuristics");
  assert.ok(/source: "calendar"/.test(poll),
    "poll-ingest must emit calendar attendance touches");
  assert.ok(/endMs > now\.getTime\(\)/.test(poll),
    "only meetings that already ENDED may touch recency (cron runs at 05:45, before the day's meetings)");
  assert.ok(/\[\.\.\.slackRecencyTouches, \.\.\.calendarTouches\]/.test(poll),
    "calendar touches must flow through the same touchContactsRecency batch");
});

test("the gone-quiet delta reads contacts FRESH, not a warm instance's /tmp copy", () => {
  const today = read("app/api/today/route.ts");
  // /tmp has no TTL: without fresh, the cron's recency touches are invisible to
  // whichever warm instance serves the dashboard — stale "gone quiet" all day.
  assert.ok(/listUserContacts\(username, \{ fresh: true \}\)/.test(today),
    "/api/today must read contacts with { fresh: true } for accurate silence math");
});

test("expired invite-responses auto-retire like past meetings", () => {
  const utils = read("lib/actions/utils.ts");
  // With dueDate = event date (see next test), a passed invite-response is as
  // moot as a passed meeting. Without this pattern, expired scheduling asks sat
  // in the open list forever (5 of 9 Olivia rows referenced past events).
  assert.ok(/\^respond to scheduling request\\b/.test(utils),
    "MEETING_ATTENDANCE_PATTERNS must include the synthesized scheduling-response shape");
});

test("synthesized scheduling actions get a deterministic event date", () => {
  assert.ok(/function inferEventDateFromSubject/.test(materialize),
    "the subject date parser must exist");
  assert.ok(/dueDate: intel\.category === "scheduling_signal"\s*\?\s*inferEventDateFromSubject\(subject, date\)/.test(materialize),
    "the synthesized path must use it for scheduling_signal (raw subject, not the truncated one)");
  // Sanity-bound: a garbage parse must never date an action.
  assert.ok(/366 \* 24 \* 60 \* 60 \* 1000/.test(materialize),
    "parsed dates must be rejected outside ±1 year of the email");
});
