/**
 * Learning from mistakes (audit item 5, 2026-11-24): reopened items teach the
 * done-judge, sent/edited/rejected drafts teach the drafter, confirms vs
 * deletes set each source's review bar, and the app sends "opened".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

// ── A. Reopened items ────────────────────────────────────────────────────────

const L = loadTs("lib/actions/done-lessons-shape.ts");

test("Basil's own close note is read back as the reason it closed the item", () => {
  const notes = "first note\nClosed by Basil on 2026-11-20: looks done — sent the deck (2, jane@acme.com). Reopen it if not.";
  assert.equal(L.lastCloseReason(notes), "looks done — sent the deck (2, jane@acme.com)");
  assert.equal(L.lastCloseReason("Closed by Basil on 2026-11-21: the moment for this has passed — trip over. Reopen it if it still matters."), "the moment for this has passed — trip over");
  assert.equal(L.lastCloseReason("no close note"), null);
});

test("lessons become a 'don't repeat this' block; none → nothing", () => {
  assert.equal(L.lessonsBlock([], "Michael"), "");
  const block = L.lessonsBlock([{ actionId: "a", text: "Send Jane the deck", closedAs: "done", reason: "looks done — emailed Jane", reopenedAt: "2026-11-24" }], "Michael");
  assert.match(block, /Michael reopened them/);
  assert.match(block, /"Send Jane the deck" — you called it done \(looks done — emailed Jane\)/);
  assert.match(block, /answer "open"/);
});

test("the judge sees the lessons, and a reopened item is judged only on later messages", () => {
  const C = loadTs("lib/actions/check-done.ts", {
    zod: require("zod"),
    "@/lib/actions/utils": { isWaitingOnOthers: () => false },
    "@/lib/briefing/outbound-evidence": { fromOwnSlackMessage: (x) => x, fromSentEmail: (x) => x },
    "@/lib/actions/store": {}, "@/lib/google/gmail": {}, "@/lib/slack/client": {}, "@/lib/self-identity": {}, "@/lib/settings/store": {},
    "@/lib/away/store": {}, "@/lib/ai/generate": {}, "@/lib/ai/model-config": {}, "@/lib/ai/parse-json": {},
    "@/lib/actions/done-lessons": { readDoneLessons: async () => [], lessonsBlock: L.lessonsBlock },
  });
  const events = [
    { at: "2026-11-18T10:00:00Z", channel: "email", to: "jane@acme.com", subject: "deck", text: "Here is the Acme deck" },
    { at: "2026-11-23T10:00:00Z", channel: "email", to: "jane@acme.com", subject: "deck v2", text: "Acme deck, final version" },
  ];
  const action = { text: "Send Jane the Acme deck", createdAt: "2026-11-17T09:00:00Z", owner: "me" };
  assert.equal(C.evidenceFor(action, events).length, 2);
  const reopened = C.evidenceFor({ ...action, reopenedAt: "2026-11-20T00:00:00Z" }, events);
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].subject, "deck v2");
  const prompt = C.doneCheckPrompt({ firstName: "Michael", today: "Tue 24 Nov 2026", action: { ...action, source: "email" }, evidence: [], absences: [],
    lessons: [{ actionId: "x", text: "Book the venue", closedAs: "expired", reason: "date passed", reopenedAt: "2026-11-22" }] });
  assert.match(prompt, /Mistakes to learn from/);
  assert.match(prompt, /"Book the venue" — you called it expired/);
});

test("reopening an item Basil closed records the lesson and the reopen time", () => {
  const route = src("app/api/actions/[id]/route.ts");
  assert.match(route, /prior\?\.closedByBasil && prior\.status === "done"/);
  assert.match(route, /patch\.reopenedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(route, /recordDoneMistake\(username, prior\)/);
  assert.match(src("lib/actions/check-done.ts"), /readDoneLessons\(username\)/);
});

// ── B. Drafting style ────────────────────────────────────────────────────────

const S = loadTs("lib/drafts/style.ts");
const ex = (o) => ({ to: "jane@acme.com", toName: "Jane Doe", channel: "email", draft: "", outcome: "edited", at: "2026-11-20", ...o });

test("outcomes, greetings and sign-offs are read from the text", () => {
  assert.equal(S.outcomeOf("Hi Jane,\n\nYes.", "Hi Jane,  \n\n\n\nYes."), "unchanged");
  assert.equal(S.outcomeOf("Hi Jane, yes.", "Yes."), "edited");
  assert.equal(S.greetingOf("Hey Jane,\nSounds good."), "Hey Jane,");
  assert.equal(S.greetingOf("Sounds good, see you then."), null);
  assert.equal(S.signOffOf("Sounds good.\n\nBest,\nMichael"), "Best, Michael");
  assert.equal(S.signOffOf("Sounds good.\nM"), "M");
});

test("habits: how much shorter, how they open and sign off, what they always cut", () => {
  const filler = "I hope this email finds you well.";
  const examples = [1, 2, 3, 4].map((i) => ex({
    to: `p${i}@x.com`,
    draft: `Hi Sam,\n\n${filler} Thanks for the note about item ${i}. I will look at it and come back to you by Friday with full details and next steps.\n\nBest regards,\nMichael`,
    sent: `Sam —\n\nWill look at item ${i}, back to you Friday.\n\nM`,
  }));
  const h = plain(S.habitsFrom([...examples, ex({ draft: "x", outcome: "rejected" })]));
  assert.equal(h.samples, 5);
  assert.equal(h.rejected, 1);
  assert.ok(h.lengthRatio < 0.5, `ratio ${h.lengthRatio}`);
  assert.deepEqual(h.signOffs, ["M"]);
  assert.ok(h.cut.some((c) => c.startsWith("i hope this email finds you well")), JSON.stringify(h.cut));
});

test("the style block teaches per person, and is empty before any sends", () => {
  assert.equal(S.styleBlock([], { address: "jane@acme.com" }, "Michael"), "");
  const examples = [
    ex({ draft: "Hi Jane, thank you so much for reaching out about the contract renewal.", sent: "Jane — renewal's fine, sign it." }),
    ex({ to: "bob@x.com", toName: "Bob", draft: "Dear Bob, please find attached.", sent: "Bob, attached." }),
    ex({ draft: "Hi Jane, generic holding reply.", outcome: "rejected", sent: undefined }),
  ];
  const block = S.styleBlock(examples, { address: "JANE@acme.com", name: "Jane Doe" }, "Michael");
  assert.match(block, /How Michael actually writes \(learned from 3 drafts/);
  assert.match(block, /How Michael rewrote earlier drafts to Jane Doe/);
  assert.match(block, /Michael sent: "Jane — renewal's fine, sign it\."/);
  assert.match(block, /Threw away: "Hi Jane, generic holding reply\."/);
  assert.doesNotMatch(block, /Bob, attached/, "another person's rewrites aren't shown as this person's");
});

test("wired in: the reply box, both drafters and approve-and-send learn from drafts", () => {
  const form = src("components/email/reply-form.tsx");
  assert.match(form, /rejectedDraft: basilDraft/);
  assert.match(form, /basilDraft \? \{ basilDraft \}/);
  assert.match(src("app/api/email/[id]/reply/route.ts"), /recordDraftOutcome\(g\.username, \{ to: sent\.to\[0\]\.email/);
  const dr = src("app/api/email/[id]/draft-reply/route.ts");
  assert.match(dr, /draftStyleFor\(username/);
  assert.match(dr, /recordDraftOutcome\(username, \{ to: ctx\.from\.email, toName: ctx\.from\.name, channel: "email", draft: rejectedDraft \}\)/);
  assert.match(src("lib/events/drafter.ts"), /learnedStyle \? "Follow the learned style below\." : getToneGuidance\(from\)/);
  assert.match(src("lib/events/executor.ts"), /if \(learnFromSend\) await recordDraftOutcome/);
});

// ── C. Review bar per source ─────────────────────────────────────────────────

const K = loadTs("lib/learning/calibration.ts");
const ev = (i, action, sourceKey, extra = {}) => ({ id: `e${i}`, itemId: `i${i}`, sourceKey, action, ts: "2026-11-20T10:00:00Z", inferred: true, ...extra });
const NOW = Date.parse("2026-11-24T00:00:00Z");

test("a source that is nearly always right asks less; one often wrong asks more; little data → default", () => {
  const events = [
    ...Array.from({ length: 10 }, (_, i) => ev(i, "confirmed", "email")),
    ...Array.from({ length: 5 }, (_, i) => ev(100 + i, "confirmed", "slack:C1")),
    ...Array.from({ length: 5 }, (_, i) => ev(200 + i, "delete", "slack:C2")),
    ...Array.from({ length: 3 }, (_, i) => ev(300 + i, "delete", "meeting")),
  ];
  const cal = plain(K.calibrate(events, NOW));
  assert.equal(cal.email.precision, 1);
  assert.equal(cal.email.autoBar, 0.5);
  assert.equal(cal.slack.precision, 0.5);
  assert.equal(cal.slack.autoBar, 0.7);
  assert.equal(cal.meeting.autoBar, 0.6, "3 judged items is too few to move the bar");
  assert.equal(cal.teams.autoBar, 0.6);
});

test("only items that went to review count, each once by its latest verdict, within 120 days", () => {
  const events = [
    ...Array.from({ length: 8 }, (_, i) => ev(i, "delete", "email")),
    ev(0, "confirmed", "email", { id: "late", ts: "2026-11-21T10:00:00Z" }),     // item 0 later confirmed
    ...Array.from({ length: 6 }, (_, i) => ev(50 + i, "delete", "email", { inferred: false })), // auto items: not a review verdict
    ...Array.from({ length: 6 }, (_, i) => ev(80 + i, "confirmed", "email", { ts: "2026-05-01T00:00:00Z" })), // too old
  ];
  const cal = plain(K.calibrate(events, NOW));
  assert.equal(cal.email.confirmed, 1);
  assert.equal(cal.email.deleted, 7);
  assert.equal(cal.email.autoBar, 0.75, "1 of 8 right → the bar tops out at 0.75");
  assert.equal(K.sourceTypeOf("slack:C123"), "slack");
  assert.equal(K.sourceTypeOf("zoom"), "meeting");
});

test("the tiers honour the learned bar but never move the skip floor", () => {
  const P = loadTs("lib/trust/policy.ts");
  assert.equal(P.actionTier(0.55), "review");
  assert.equal(P.actionTier(0.55, 0.5), "auto");
  assert.equal(P.actionTier(0.65, 0.7), "review");
  assert.equal(P.actionTier(0.2, 0.1), "skip", "a low bar can't make something below the floor appear");
  assert.equal(P.zoomActionTier(0.52, 0.5), "auto");
  assert.equal(P.zoomActionTier(0.25, 0.1), "skip");
  for (const f of ["lib/email/materialize-email.ts", "lib/slack/materialize-slack.ts", "lib/teams/materialize-teams.ts"]) {
    assert.match(src(f), /actionTier\(intel\.confidence, await actionAutoBar\(username, "(email|slack|teams)"\)\)/, f);
  }
  assert.match(src("lib/zoom/process-meeting.ts"), /actionTier\(item\.confidence, meetingBar\)/);
  assert.match(src("lib/email/process-gmail-message.ts"), /zoomActionTier\(itemConf, meetingBar\)/);
});

// ── D. "opened" ──────────────────────────────────────────────────────────────

test("opening an item's source sends 'opened' — Today card links and Reply on an email action", () => {
  assert.match(src("lib/learning/log-opened.ts"), /action: "opened"/);
  assert.match(src("components/today/today-card.tsx"), /onOpen=\{actionId \? \(\) => logOpened\(actionId\) : undefined\}/);
  assert.match(src("components/today/today-card.tsx"), /onClick=\{onOpen\}/);
  assert.match(src("components/email/reply-composer.tsx"), /logOpened\(actionId\)/);
});

test("every delete is logged once, by the server, whichever page it came from", () => {
  const route = src("app/api/actions/[id]/route.ts");
  assert.match(route, /action: "delete", ts: new Date\(\)\.toISOString\(\), inferred: !!item\.needsReview/);
  assert.doesNotMatch(src("components/actions/action-controls.tsx"), /logInteraction\(actionId, "delete"\)/, "no second, client-side delete log");
});
