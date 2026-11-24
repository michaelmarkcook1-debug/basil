// What a personality profile is built from (docs/personality-profiles-review-2026-10-21.md §4).
// The user's stated notes outrank inference and survive regeneration; the
// previous profile is revised, not restarted; habits are measured, not guessed;
// and nobody is ever typed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const E = loadTs("lib/contacts/profile-evidence.ts");
const P = loadTs("lib/contacts/profile-prompt.ts", { "@/lib/contacts/profile-evidence": E });
const plain = (v) => JSON.parse(JSON.stringify(v));

const items = (over = {}) => E.numberEvidence({
  notes: over.notes ?? [],
  habits: over.habits ?? [],
  messages: over.messages ?? [],
});
const base = { name: "Priya Shah", directory: "work", selfFirst: "Michael", items: items() };

test("evidence is numbered and grouped by who said it: stated, measured, written by them, others", () => {
  const it = items({
    notes: ["Priya prefers numbers before narrative."],
    habits: ["Usually replies within the hour."],
    messages: [
      { channel: "email", by: "them", date: "2026-11-10", title: "Scenario B", text: "Scenario B only." },
      { channel: "zoom", by: "others", date: "2026-11-12", title: "QBR", text: "Priya pushed for a cheaper tier." },
    ],
  });
  assert.deepEqual([...it.map((e) => e.id)], ["N1", "H1", "E1", "E2"], "notes, habits, then messages newest first");
  assert.equal(it.find((e) => e.id === "E1").channel, "zoom");
  const p = P.buildProfilePrompt({ ...base, items: it });
  assert.match(p, /## STATED BY MICHAEL — facts; they outrank anything inferred\n\[N1\] Priya prefers numbers/);
  assert.match(p, /## MEASURED — computed from message history; facts, not guesses\n\[H1\] Usually replies/);
  assert.match(p, /## WRITTEN BY PRIYA SHAH — the only evidence of how they communicate\n\[E2\] 2026-11-10 Scenario B only\./);
  assert.match(p, /## SAID BY OTHERS, OR ABOUT PRIYA SHAH — context only, never evidence of their style\n\[E1\]/);
  assert.match(p, /plus Michael's own notes/);
});

test("the prompt asks for cited claims and says uncited ones are deleted", () => {
  const p = P.buildProfilePrompt(base);
  assert.match(p, /Every claim lists the ids it rests on/);
  assert.match(p, /A claim with no valid citation is deleted/);
  assert.match(p, /\*\*personality\*\*, \*\*reachThem\*\* and \*\*silence\*\* \(how they communicate and respond\) must cite at least one WRITTEN BY, MEASURED or STATED item/);
  assert.match(p, /"personality": \[\{ "text": "\.\.\.", "evidence": \["E1"\] \}\]/);
  assert.match(p, /replaced with "Not enough evidence yet\." by code — do not pad/);
});

test("regeneration revises: the current profile goes in, but is not evidence", () => {
  const p = P.buildProfilePrompt({ ...base, prior: { personality: "Short decisive bursts.", generatedAt: "2026-06-03T10:00:00Z" } });
  assert.match(p, /THE CURRENT PROFILE \(written 2026-06-03\) — revise, do not restart/);
  assert.match(p, /- personality: Short decisive bursts\./);
  assert.match(p, /The current profile is NOT evidence and cannot be cited/);
  assert.match(p, /"changes": "\.\.\."/);
  assert.doesNotMatch(P.buildProfilePrompt(base), /THE CURRENT PROFILE/);
});

test("measured habits become lines of evidence; under five messages there are none", () => {
  const lines = P.habitLines({ n: 24, medianWords: 3, shortShare: 0.8, medianReplyHours: 0.5, initiationShare: 0.6 }, ["Replies got shorter this month."]);
  assert.match(lines[0], /24 messages from them; median 3 words a message \(mostly one-liners\)/);
  assert.ok(lines.includes("Usually replies within the hour."));
  assert.ok(lines.includes("Starts 60% of the conversations between you."));
  assert.ok(lines.includes("Replies got shorter this month."));
  assert.deepEqual(plain(P.habitLines({ n: 3, medianWords: 3, shortShare: 1 }, ["x"])), []);
});

test("the hard rules: no trait types, behaviour not inner states, terse is a style", () => {
  const p = P.buildProfilePrompt(base);
  assert.match(p, /NEVER assign a personality type or trait label — no DISC, MBTI, Big Five/);
  assert.match(p, /Describe behaviour, not inner states/);
  assert.match(p, /Terse or direct writing is a style, not a mood/);
  assert.match(p, /Open with the single most actionable line: it is shown beside their name/);
});

test("no signal and no notes: the prompt says so and forbids invention", () => {
  const p = P.buildProfilePrompt(base);
  assert.match(p, /0 message\(s\) over 90 days, no personal notes/);
  assert.match(p, /NO SIGNAL: return empty claim lists/);
  assert.equal(P.signalCount(base.items), 0);
});

// ── Citations checked and strength counted in code ───────────────────────────

const day = (n) => `2026-10-${String(n).padStart(2, "0")}`;
const them = (n, ch = "email") => ({ channel: ch, by: "them", date: day(n), text: `msg ${n}` });

test("a claim citing nothing real is dropped; a style claim resting only on others' words is dropped", () => {
  const it = items({ messages: [them(1), them(10), them(20), { channel: "zoom", by: "others", date: day(25), text: "Zoom says she is blunt" }] });
  const zoomId = it.find((e) => e.channel === "zoom").id;
  const ids = it.filter((e) => e.by === "them").map((e) => e.id);
  const out = E.finalizeClaims({
    personality: [
      { text: "Writes short replies.", evidence: ids },
      { text: "Is blunt in meetings.", evidence: [zoomId] },
      { text: "Loves golf.", evidence: ["E99"] },
    ],
  }, it);
  assert.equal(out.text.personality, "Writes short replies.");
  assert.deepEqual(plain(out.evidence.dropped.map((d) => d.why)).sort(), ["no-valid-citation", "style-without-their-words"]);
  assert.equal(out.evidence.cited.length, 3, "only cited items are kept for display");
});

test("thin fields say 'Not enough evidence yet' — under three items, or all within two weeks", () => {
  const few = items({ messages: [them(1), them(20)] });
  const a = E.finalizeClaims({ watchOut: [{ text: "Goes quiet before deadlines.", evidence: few.map((e) => e.id) }] }, few);
  assert.equal(a.text.watchOut, E.NOT_ENOUGH);
  assert.equal(a.evidence.strength.watchOut.level, "thin");
  assert.deepEqual(plain(a.evidence.claims.watchOut), []);
  const burst = items({ messages: [them(1), them(3), them(5), them(8)] });
  assert.equal(E.finalizeClaims({ watchOut: [{ text: "x", evidence: burst.map((e) => e.id) }] }, burst).text.watchOut, E.NOT_ENOUGH, "one busy week is not a pattern");
  const spread = items({ messages: [them(1), them(10, "slack"), them(20)] });
  const ok = E.finalizeClaims({ watchOut: [{ text: "Goes quiet before deadlines.", evidence: spread.map((e) => e.id) }] }, spread);
  assert.equal(ok.text.watchOut, "Goes quiet before deadlines.");
  assert.equal(ok.evidence.strength.watchOut.level, "some");
  assert.equal(ok.activitySource, "Email, Slack");
});

test("the user's own note is enough on its own; measured habits carry their own 90-day span", () => {
  const it = items({ notes: ["Old friend from Atos; prefers calls."], habits: ["Usually replies within 3 hours.", "Starts 20% of the conversations between you."], messages: [them(1)] });
  const out = E.finalizeClaims({
    whatMakesThemTick: [{ text: "From Michael's account, prefers calls.", evidence: ["N1"] }],
    personality: [{ text: "Replies within hours, rarely starts threads.", evidence: ["H1", "H2", "E1"] }],
  }, it);
  assert.equal(out.evidence.strength.whatMakesThemTick.level, "stated");
  assert.equal(out.text.whatMakesThemTick, "From Michael's account, prefers calls.");
  assert.notEqual(out.text.personality, E.NOT_ENOUGH);
});

test("recent activity needs one cited, dated item; nothing cited → not enough", () => {
  const it = items({ messages: [them(1)] });
  assert.equal(E.finalizeClaims({ recentActivity: [{ text: "1 Oct — sent the brief.", evidence: ["E1"] }] }, it).text.recentActivity, "1 Oct — sent the brief.");
  assert.equal(E.finalizeClaims({ recentActivity: [] }, it).text.recentActivity, E.NOT_ENOUGH);
});

test("the generator splits who wrote what by identity and finishes the profile in code", () => {
  const r = src("lib/contacts/generate-profile.ts");
  assert.match(r, /const WINDOW_DAYS = 90/);
  assert.match(r, /getRecentEmails\(username, 400, WINDOW_DAYS\)/);
  assert.match(r, /getRecentSlackMessages\(username, 2500, WINDOW_DAYS\)/);
  assert.match(r, /getEmailBody\(username, e\.id\)/);
  assert.match(r, /ownerNotes = override\?\.ownerNotes/);
  assert.match(r, /settings\.toneSentiment !== false/, "tone & sentiment off → no message data is read");
  assert.match(r, /getUserProfile\(username, email\)/, "Slack identity from their email");
  assert.match(r, /slackIds\.has\(m\.authorId\)/, "authorship by Slack ID — every ID the person has (lib/people)");
  assert.match(r, /schema: ContactProfileClaimsSchema/);
  assert.match(r, /finalizeClaims\(parsed, items, checks\)/);
  assert.match(src("lib/slack/client.ts"), /authorId: msg\.user/);
  assert.match(src("lib/ai/schemas.ts"), /changes:\s+z\.string\(\)\.optional\(\)/);
  assert.match(src("app/api/contacts/overrides/[id]/route.ts"), /ownerNotes: z\.string\(\)\.max\(4000\)\.optional\(\)/);
  assert.match(src("app/api/contacts/overrides/[id]/route.ts"), /profileEvidence: z/);
  assert.match(src("app/dashboard/contacts/page.tsx"), /<CitedField field=\{field\}/);
});

// ── Whose message is it? (2026-11-23: "guy" matched every "you guys") ──────────

test("a one-word name matches its author and address, never the word inside someone else's text", () => {
  const who = P.personMatcher("guy", "guy@talentgenius.io");
  assert.equal(who.sentEmail({ from: "Guy Saunders <guy@talentgenius.io>", fromEmail: "guy@talentgenius.io" }), true);
  assert.equal(who.sentEmail({ from: "Guy Fawkes Ltd <news@fawkes.example>", fromEmail: "news@fawkes.example" }), false);
  assert.equal(who.authored("Guy"), true);
  assert.equal(who.authored("guy.saunders"), true);
  assert.equal(who.authored("Guyana Team"), false);
  assert.equal(who.mentions("thanks you guys, great call"), false);
  assert.equal(who.mentions("the guy from Atos wants a demo"), false);
});

test("a full name matches as whole words, including mentions", () => {
  const who = P.personMatcher("Guy Saunders", "guy@talentgenius.io");
  assert.equal(who.mentions("Spoke to Guy Saunders about Atos"), true);
  assert.equal(who.mentions("guys, saunders is a town"), false);
  assert.equal(who.sentEmail({ from: "Guy Saunders <guy.saunders@atos.example>", fromEmail: "guy.saunders@atos.example" }), true, "same full name, other address");
  const noEmail = P.personMatcher("Will Hart");
  assert.equal(noEmail.sentEmail({ from: "Will Hart <w@x.example>", fromEmail: "w@x.example" }), true);
  assert.equal(noEmail.sentEmail({ from: "Willow Hartley <wh@x.example>", fromEmail: "wh@x.example" }), false);
});

test("the full name comes from the person's own From header when the contact is one word", () => {
  const G = src("lib/contacts/generate-profile.ts");
  assert.match(G, /fullNameFromHeaders\(emailsAll, email\)/);
  assert.match(G, /personMatcher\(fullName, email\)/);
  assert.doesNotMatch(G, /textLower\.includes\(nameFirst/, "no first-name substring search in message text");
});

// ── Review recommendations 5 and 7: the second check, and how to work with them ──

test("the prompt asks for the how-to-work-with-them fields, each cited", () => {
  const p = P.buildProfilePrompt(base);
  for (const f of ["howToLandIt", "reachThem", "decides", "badNews", "silence"]) assert.match(p, new RegExp(`"${f}": \\[\\{ "text"`), f);
  assert.match(p, /\*\*howToLandIt\*\* — ONE claim/);
});

test("a claim the second check found unsupported or contradicted is removed; no verdict keeps it", () => {
  const it = items({ messages: [them(1), them(10), them(20)] });
  const ids = it.map((e) => e.id);
  const raw = { decides: [
    { text: "Decides on numbers.", evidence: ids },
    { text: "Hates being rushed.", evidence: ids },
    { text: "Asks a peer first.", evidence: ids },
  ] };
  const keys = [...E.citedClaims(raw, it).map((c) => c.key)];
  assert.deepEqual(keys, ["decides#0", "decides#1", "decides#2"]);
  const out = E.finalizeClaims(raw, it, new Map([["decides#1", "unsupported"], ["decides#2", "contradicted"]]));
  assert.equal(out.text.decides, "Decides on numbers.");
  assert.deepEqual([...out.evidence.dropped.map((d) => d.why)], ["checker-unsupported", "checker-contradicted"]);
  assert.equal(out.evidence.checked, true);
  const failed = E.finalizeClaims(raw, it, null);
  assert.equal(failed.evidence.checked, false, "the check could not run: said so, nothing removed");
  assert.equal(failed.evidence.claims.decides.length, 3);
});

test("reaching them and silence are about how they respond: never from others' words alone", () => {
  const it = items({ messages: [{ channel: "zoom", by: "others", date: day(1), text: "a" }, { channel: "zoom", by: "others", date: day(10), text: "b" }, { channel: "zoom", by: "others", date: day(20), text: "c" }] });
  const out = E.finalizeClaims({ silence: [{ text: "Silence means no.", evidence: it.map((e) => e.id) }] }, it);
  assert.equal(out.text.silence, E.NOT_ENOUGH);
  assert.equal(out.evidence.dropped[0].why, "style-without-their-words");
});

test("channel and hours are measured: mix of their messages, their busiest three hours, weekday share", () => {
  const at = (d, h) => `2026-11-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:15:00Z`;
  const msgs = [
    ...[3, 4, 5, 6, 10, 11].map((d) => ({ channel: "slack", at: at(d, 8) })),
    { channel: "slack", at: at(12, 9) },
    { channel: "email", at: at(13, 9) },
    { channel: "email", at: at(15, 21) }, // a Sunday evening
  ];
  const lines = [...E.channelAndHourHabits(msgs, "UTC")];
  assert.equal(lines[0], "Of their 9 messages in 90 days: 78% Slack, 22% Email.");
  assert.match(lines[1], /^89% of them are sent between (06|07|08):00 and (09|10|11):00 \(UTC\); 89% on weekdays\.$/);
  assert.deepEqual([...E.channelAndHourHabits(msgs.slice(0, 7), "UTC")], [], "under eight messages: no habit");
});

test("the second check reads each claim with only its own sources, and fails open", async () => {
  const C = loadTs("lib/contacts/profile-check.ts", { "@/lib/ai/generate": { generateTextSafe: async () => { throw new Error("credit balance is too low"); } } });
  const ev = [{ id: "E1", by: "them", channel: "email", text: "Numbers first please.", label: "Email" }, { id: "E2", by: "others", channel: "zoom", text: "She was aggressive.", label: "Zoom" }];
  const prompt = C.checkPrompt([{ key: "personality#0", text: "Leads with numbers.", evidence: [ev[0]] }, { key: "personality#1", text: "Is aggressive.", evidence: [ev[1]] }]);
  assert.match(prompt, /### personality#0\nCLAIM: Leads with numbers\.\nSOURCES:\n- \(written by the person\) Numbers first please\./);
  assert.match(prompt, /- \(said by someone else\) She was aggressive\./);
  assert.match(prompt, /only supported by sources written by them, measured, or the user's own note/);
  assert.equal(await C.checkClaims("michael", [{ key: "k", text: "t", evidence: [ev[0]] }]), null);
  assert.deepEqual(plain([...C.parseChecks('```json\n[{"key":"a","v":"supported"},{"key":"b","v":"maybe"}]\n```')]), [["a", "supported"]]);
  const g = src("lib/contacts/generate-profile.ts");
  assert.match(g, /checkClaims\(username, citedClaims\(parsed, items\)\)/);
  assert.match(g, /finalizeClaims\(parsed, items, checks\)/);
  assert.match(g, /channelAndHourHabits\(theirTimes/);
});

test("'how to land it' beside a name prefers the dedicated line and never shows 'Not enough evidence yet'", () => {
  const r = src("app/api/contacts/approach/route.ts");
  assert.match(r, /Not enough evidence yet/);
  assert.match(r, /firstSentence\(ov\.workingStyle\?\.howToLandIt, 140\)/);
});

// ── Review recommendations 3 and 6: both sides, and the setting ──────────────

test("your asks are paired with what they did next: a reply and how long, or nothing", () => {
  const t = (d, h, m = 0) => `2026-11-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  const convo = [
    { fromUser: true, fromThem: false, at: t(3, 9), text: "Can you send the Q3 numbers?" },
    { fromUser: false, fromThem: true, at: t(3, 9, 40), text: "Sent." },
    { fromUser: true, fromThem: false, at: t(5, 10), text: "Thanks — great work" },
    { fromUser: true, fromThem: false, at: t(6, 10), text: "Any chance of a call Friday?" },
    { fromUser: true, fromThem: false, at: t(9, 10), text: "Friday still on?" },
    { fromUser: false, fromThem: true, at: t(9, 15), text: "yes 3pm" },
    { fromUser: true, fromThem: false, at: t(12, 10), text: "Could you review the contract?" },
  ];
  const xs = E.exchangesIn(convo);
  assert.equal(xs.length, 3, "a statement is not an ask; back-to-back messages are one ask");
  assert.equal(xs[0].reply.text, "Sent.");
  assert.equal(xs[1].ask, "Friday still on?");
  assert.equal(xs[2].reply, undefined);
  const ev = E.exchangeEvidence(xs[0], "slack", "Michael", "Dana Price");
  assert.equal(ev.by, "them");
  assert.equal(ev.setting, "1:1");
  assert.match(ev.text, /Michael asked: "Can you send the Q3 numbers\?"\n→ Dana replied 40 min later: "Sent\."/);
  assert.match(E.exchangeEvidence(xs[2], "slack", "Michael", "Dana Price").text, /No reply from Dana/);
  assert.deepEqual([...E.askHabits(xs)], [], "under four asks: no habit");
  const many = [...xs, ...xs];
  assert.match(E.askHabits(many)[0], /^Of 6 questions or requests you sent them one-to-one, they answered 4, typically \d+ h later; 2 got no reply/);
});

test("their habits are measured per setting, and each item carries its setting", () => {
  const msgs = [
    ...["ok", "yes 3pm", "sent", "can you call me?"].map((text) => ({ setting: "1:1", text })),
    ...["Team, here is the long plan for the quarter with all the details", "Please review the doc by Friday", "Great work all", "Who owns the launch checklist?"].map((text) => ({ setting: "group", text })),
  ];
  const lines = [...E.settingHabits(msgs)];
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^One-to-one \(DMs, direct email\): 4 messages from them, median \d+ words; 25% ask a question, 25% ask for something\.$/);
  assert.match(lines[1], /^In group channels and group email: 4 messages from them/);
  const it = E.numberEvidence({ notes: [], habits: [], messages: [{ channel: "slack", by: "them", setting: "group", date: "2026-11-02", text: "x" }] });
  assert.match(P.buildProfilePrompt({ ...base, items: it }), /\[E1\] 2026-11-02 \(group\) x/);
  assert.match(it[0].label, /Slack · group/);
  assert.match(P.buildProfilePrompt(base), /when a claim rests on one setting, say so/);
});

test("the generator reads each full email with its thread, pairs DM asks with replies, and measures per setting", () => {
  const g = src("lib/contacts/generate-profile.ts");
  assert.match(g, /getThreadState\(username, e\.id\)/);
  assert.match(g, /Answering \$\{before\.sent/);
  assert.match(g, /exchangesIn\(c\)/);
  assert.match(g, /settingHabits\(theirMessages\)/);
  assert.match(g, /askHabits\(exchanges\)/);
});

// ── Review recommendation 8: grading ─────────────────────────────────────────

const Q = loadTs("lib/contacts/profile-quality.ts");

test("edit ratio: 0 untouched, 1 rewritten, word-level", () => {
  assert.equal(Q.editRatio("Leads with numbers.", "Leads with numbers"), 0);
  assert.equal(Q.editRatio("Leads with numbers.", "Prefers calls on Fridays"), 1);
  assert.equal(Q.editRatio("Replies within two hours, in short lines.", "Replies within a day, in short lines."), 0.29);
  assert.equal(Q.editRatio("", ""), 0);
});

test("your thumbs carry into the next draft: up becomes a stated fact, down a do-not-repeat", () => {
  const store = { runs: [], verdicts: [
    { contactId: "c1", field: "personality", text: "Leads with numbers.", verdict: "up", at: "2026-11-20T00:00:00Z" },
    { contactId: "c1", field: "watchOut", text: "Hates being rushed.", verdict: "down", at: "2026-11-21T00:00:00Z" },
    { contactId: "c2", field: "watchOut", text: "Other person.", verdict: "down", at: "2026-11-21T00:00:00Z" },
  ] };
  assert.deepEqual(plain(Q.verdictsFor(store, "c1")), { confirmed: ["Leads with numbers."], rejected: ["Hates being rushed."] });
  const p = P.buildProfilePrompt({ ...base, rejected: ["Hates being rushed."] });
  assert.match(p, /## MICHAEL SAID THESE WERE WRONG — do not repeat them, or anything that means the same\n- "Hates being rushed\."/);
  const g = src("lib/contacts/generate-profile.ts");
  assert.match(g, /confirmed this earlier: "\$\{c\}"/, "confirmed claims become N items, citable");
  assert.match(g, /rejected: judged\.rejected/);
  assert.match(g, /recordRun\(username, \{/);
});

test("the quality summary: profiles, thumbs, what the checks removed, edits per field, review due at 30", () => {
  const runs = Array.from({ length: 31 }, (_, i) => ({ contactId: `c${i}`, at: "2026-11-23T00:00:00Z", kept: 8, dropped: i === 0 ? { "checker-unsupported": 2, "no-valid-citation": 1 } : {}, checked: true, ...(i < 2 ? { edits: { personality: i === 0 ? 0.2 : 0.4 } } : {}) }));
  const q = Q.summariseQuality({ runs, verdicts: [{ verdict: "up" }, { verdict: "down" }, { verdict: "up" }] });
  assert.equal(q.profiles, 31);
  assert.equal(q.thumbsUp, 2);
  assert.equal(q.thumbsDown, 1);
  assert.equal(q.removedShare, 0.01);
  assert.equal(q.removedByCheck, 2);
  assert.equal(q.editsByField.personality, 0.3);
  assert.equal(q.reviewDue, true);
  assert.equal(Q.summariseQuality({ runs: runs.slice(0, 29), verdicts: [] }).reviewDue, false);
});

test("the UI: thumbs on every claim, verdicts loaded per contact, a quality card in Settings", () => {
  assert.match(src("components/contacts/cited-field.tsx"), /aria-label=\{kind === "up" \? "This is right" : "This is wrong"\}/);
  assert.match(src("app/dashboard/contacts/page.tsx"), /\/api\/contacts\/profile-feedback\?contactId=/);
  assert.match(src("app/dashboard/settings/page.tsx"), /<ProfileQualityCard \/>/);
  assert.match(src("app/api/contacts/profile-feedback/route.ts"), /verdict must be up, down or clear/);
});
