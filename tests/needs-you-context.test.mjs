// "Needs you", 2026-11-23. Three cards that needed nothing:
//   Guy Saunders — "Anja, Good morning, do you have time to catch up anytime next
//                  week?" Guy asking the Atos contact; Michael only on the To line.
//                  The judge saw a 140-character preview under the premise
//                  "addressed to Michael" and stored "asks if Michael has time".
//   GTM standup 2 Dec and 4 Dec — dates of Ed's repeating standup that Michael
//                  had already said maybe/yes to on 25 and 30 Nov.
// These replay them against the judge, the detector and the invitation filter,
// plus the other routes a card can be answered by (a fresh email, Slack, a meeting).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const zod = require("zod");
const HOUR = 3_600_000;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();

function memStore(initial = {}) {
  const files = structuredClone(initial);
  return {
    files,
    readUserStore: async (_u, f, fb) => structuredClone(files[f] ?? fb),
    updateUserStore: async (_u, f, mut, fb) => { files[f] = mut(structuredClone(files[f] ?? fb)); return files[f]; },
  };
}

const context = () => loadTs("lib/followups/context.ts");

const needsReply = (store, generate) => loadTs("lib/email/needs-reply.ts", {
  zod,
  "@/lib/storage/user-store": store,
  "@/lib/ai/generate": { generateTextSafe: generate ?? (async () => { throw new Error("no model in this test"); }) },
  "@/lib/ai/model-config": { getTextModel: () => "fast-model" },
  "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod }),
});

const GUY_BODY = `Anja,

Good morning, do you have time to catch up anytime next week?

Regards
Guy

On Thu, Nov 5, 2026 at 11:42 AM Guy Saunders <guy@analystgenius.invalid>
wrote:

> Anja, lovely to meet you at the summit. Michael and I would welcome a call.
> Michael, can you send Anja the deck?`;

// ── Reading the whole message ────────────────────────────────────────────────

test("latestMessageText keeps the new message and drops the quoted history", () => {
  const C = context();
  const t = C.latestMessageText(GUY_BODY);
  assert.match(t, /^Anja,/);
  assert.match(t, /catch up anytime next week/);
  assert.doesNotMatch(t, /send Anja the deck/, "the quoted ask to Michael is history, not this message");
  assert.equal(C.latestMessageText("Thanks!\n\n-----Original Message-----\nFrom: x"), "Thanks!");
  assert.equal(C.latestMessageText("Sure.\nFrom: Priya <p@x.invalid>\nSent: Monday\nTo: Michael"), "Sure.");
});

test("the judge is shown who the message went to, the whole message and what happened since — and no 'addressed to you' premise", () => {
  const M = needsReply(memStore());
  const prompt = M.needsReplyPrompt("Michael", [{
    id: "guy", channel: "email", from: "Guy Saunders", subject: "Re: Atos and AnalystGenius", at: "2026-11-20T11:13:44Z",
    to: "anja@atos.invalid, michael@analystgenius.invalid", cc: "",
    text: context().latestMessageText(GUY_BODY),
    earlier: [{ from: "Guy Saunders", at: "2026-11-05T11:42:00Z", text: "Anja, lovely to meet you at the summit." }],
    since: [{ channel: "slack", at: "2026-11-21T09:00:00Z", text: "Saw your note to Anja — I'll join if she says yes" }],
  }], { selfEmails: ["michael@talentgenius.invalid", "michael@analystgenius.invalid"] });
  assert.match(prompt, /To: anja@atos\.invalid, michael@analystgenius\.invalid/);
  assert.match(prompt, /Michael's own addresses: michael@talentgenius\.invalid, michael@analystgenius\.invalid/);
  assert.match(prompt, /Anja,\n\nGood morning, do you have time to catch up anytime next week\?/);
  assert.match(prompt, /Earlier in the conversation:\n  - Guy Saunders/);
  assert.match(prompt, /Since then, Michael has: \n  - slack \(2026-11-21 09:00\): Saw your note to Anja/);
  assert.match(prompt, /addressed to, or asks, someone other than Michael/);
  assert.doesNotMatch(prompt, /addressed to Michael\)/, "the old premise that every message is addressed to the user is gone");
  assert.doesNotMatch(prompt, /\b(him|his|he)\b/i, "the prompt names the user, it does not guess pronouns");
});

// ── Verdicts: when a stored one still counts ──────────────────────────────────

test("verdicts made from a preview (v1) are judged again; a v2 'still waiting' is re-checked when something new happens with the sender", async () => {
  const store = memStore({ "email-reply-judgments.json": {
    guy: { needsReply: true, reason: "Asks if Michael has time to meet next week", at: "2026-11-23T01:45:11Z" },
    fyi: { needsReply: false, reason: "update", at: "2026-11-22T00:00:00Z", v: 2, sig: "0" },
    ask: { needsReply: true, reason: "asks for pricing", at: "2026-11-22T00:00:00Z", v: 2, sig: "0" },
  } });
  const M = needsReply(store);
  const judged = [];
  const judge = async (_f, batch, opts) => {
    judged.push(...batch.map((c) => c.id));
    assert.deepEqual([...opts.selfEmails], ["me@x.invalid"], "the user's addresses reach the judge");
    return new Map(batch.map((c) => [c.id, c.id === "guy"
      ? { needsReply: false, reason: "asks Anja, not Michael" }
      : { needsReply: false, reason: "answered by email since" }]));
  };
  const cands = [
    { id: "guy", from: "Guy", subject: "s", text: "Anja, …", sinceSig: "0" },
    { id: "fyi", from: "x", subject: "s", text: "t", sinceSig: "2:2026-11-23T00:00:00Z" },
    { id: "ask", from: "Priya", subject: "Pricing", text: "Can you confirm pricing?", sinceSig: "1:2026-11-23T08:00:00Z" },
  ];
  const noReply = await M.filterNoReplyNeeded("u", "Michael", cands, judge, { selfEmails: ["me@x.invalid"] });
  assert.equal(judged.sort().join(","), "ask,guy", "a v2 'no reply needed' stands; v1 and a changed 'still waiting' are judged again");
  assert.equal([...noReply.keys()].sort().join(","), "ask,fyi,guy");
  const stored = store.files["email-reply-judgments.json"];
  assert.equal(stored.guy.v, 2);
  assert.equal(stored.ask.sig, "1:2026-11-23T08:00:00Z");

  // Nothing new since: nothing is judged again.
  judged.length = 0;
  await M.filterNoReplyNeeded("u", "Michael", cands, judge, { selfEmails: ["me@x.invalid"] });
  assert.equal(judged.length, 0);
});

// ── Other routes a card can be answered by ──────────────────────────────────

test("touches: mail sent to the person in any thread, and meetings with them, after they wrote", () => {
  const C = context();
  const since = "2026-11-20T11:13:44.000Z";
  const sent = [
    { id: "s1", date: "2026-11-21T10:00:00.000Z", to: "Guy Saunders <guy@ag.invalid>", cc: "", subject: "Atos", snippet: "I'll take the Anja call", from: "", fromEmail: "", unread: false },
    { id: "s2", date: "2026-11-19T10:00:00.000Z", to: "guy@ag.invalid", cc: "", subject: "older", snippet: "before he wrote", from: "", fromEmail: "", unread: false },
    { id: "s3", date: "2026-11-22T10:00:00.000Z", to: "someone@else.invalid", cc: "", subject: "x", snippet: "y", from: "", fromEmail: "", unread: false },
  ];
  const t = C.touchesFromSent(sent, "GUY@ag.invalid", since);
  assert.equal(t.length, 1);
  assert.match(t[0].text, /Atos — I'll take the Anja call/);

  const events = [
    { summary: "Atos catch-up", start: "2026-11-26T10:00:00Z", end: "2026-11-26T10:30:00Z", myResponseStatus: "accepted", attendeeDetails: [{ name: "Guy", email: "guy@ag.invalid" }], recurring: false },
    { summary: "Declined thing", start: "2026-11-27T10:00:00Z", end: "x", myResponseStatus: "declined", attendeeDetails: [{ name: "Guy", email: "guy@ag.invalid" }] },
    { summary: "Before", start: "2026-11-19T10:00:00Z", end: "x", myResponseStatus: "accepted", attendeeDetails: [{ name: "Guy", email: "guy@ag.invalid" }] },
    { summary: "AG weekly", start: "2026-11-24T10:00:00Z", end: "x", myResponseStatus: "accepted", organizerEmail: "guy@ag.invalid", recurring: true },
  ];
  const m = C.touchesFromEvents(events, "guy@ag.invalid", since);
  assert.deepEqual([...m.map((x) => x.text)], ["AG weekly (repeating meeting)", "Atos catch-up"]);
  assert.equal(C.touchSignature([]), "0");
  assert.equal(C.touchSignature([...t, ...m]), "3:2026-11-26T10:00:00Z");
});

test("touches: what the user wrote in their Slack DM with the person since", async () => {
  const C = context();
  const web = {
    users: { list: async () => ({ members: [{ id: "UGUY", profile: { email: "guy@ag.invalid" } }, { id: "UBOT", is_bot: true, profile: { email: "bot@ag.invalid" } }] }) },
    conversations: {
      list: async () => ({ channels: [{ id: "DGUY", user: "UGUY" }] }),
      history: async ({ channel, oldest }) => {
        assert.equal(channel, "DGUY");
        assert.equal(Number(oldest), Date.parse("2026-11-20T11:13:44.000Z") / 1000);
        return { messages: [{ user: "UME", text: "Re Atos — happy to join the Anja call", ts: "1763740000.0001" }, { user: "UGUY", text: "great", ts: "1763740100.0001" }] };
      },
    },
  };
  const dir = await C.slackDirectory(web);
  assert.equal(dir.idByEmail.get("guy@ag.invalid"), "UGUY");
  assert.equal(dir.idByEmail.has("bot@ag.invalid"), false);
  const t = await C.touchesFromSlackDm(web, "UME", dir, "Guy@ag.invalid", "2026-11-20T11:13:44.000Z");
  assert.equal(t.length, 1);
  assert.equal(t[0].channel, "slack");
  assert.match(t[0].text, /happy to join the Anja call/);
  assert.equal((await C.touchesFromSlackDm(web, "UME", dir, "nobody@x.invalid", "2026-11-20T00:00:00Z")).length, 0);
});

// ── The detector hands the judge all of it ──────────────────────────────────

test("detector: the judge gets the full email, To/Cc, the earlier thread and the user's email to the sender since", async () => {
  const seen = [];
  const D = loadTs("lib/followups/detect.ts", {
    "@/lib/followups/context": context(),
    "@/lib/google/gmail": {
      getRecentEmails: async () => [{ id: "guy", threadId: "t1", from: "Guy Saunders", fromEmail: "guy@ag.invalid",
        to: "anja@atos.invalid, michael@ag.invalid", cc: "", subject: "Re: Atos and AnalystGenius",
        snippet: "Anja, Good morning, do you have time to catch up anytime next week? Regards Guy On Thu", date: ago(70), labels: ["INBOX"], bulk: false }],
      getGmailAddress: async () => "michael@ag.invalid",
      getThreadState: async () => ({ later: [], earlier: [{ fromName: "Guy Saunders", fromEmail: "guy@ag.invalid", date: ago(400), snippet: "Anja, lovely to meet you" }] }),
      getEmailBody: async () => ({ body: GUY_BODY }),
      getSentEmails: async () => [{ id: "s1", date: ago(20), to: "guy@ag.invalid", cc: "", subject: "Atos", snippet: "I'll take the Anja call", from: "", fromEmail: "", unread: false }],
    },
    "@/lib/email/known-senders": { loadKnownSenders: async () => ({ isKnown: () => true }) },
    "@/lib/google/calendar": { getEventsForDateRange: async () => [] },
    "@/lib/followups/invitation-rsvp": { findAnsweringCalendarEvent: () => null },
    "@/lib/slack/client": { getSlackUserClientForUser: async () => null, isSlackConnected: async () => false },
    "@/lib/google/auth": { isGoogleConnected: async () => true },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: ["michael@ag.invalid"], names: ["Michael Cook"] }), isSelf: () => false },
    "@/lib/email/needs-reply": {
      filterNoReplyNeeded: async (_u, first, cands, _judge, opts) => {
        seen.push({ first, cands, opts });
        return new Map(cands.map((c) => [c.id, { needsReply: false, reason: "asks Anja" }]));
      },
    },
    "@/lib/email/view-cache": { decodeEntities: (s) => s },
  });
  const quiet = console.log; console.log = () => {};
  let res;
  try { res = await D.detectPendingFollowups("u-ctx", { staleHours: 24 }); } finally { console.log = quiet; }
  assert.equal(res.items.length, 0, "the judge's 'asks Anja' verdict removes the card");
  const c = seen[0].cands[0];
  assert.equal(seen[0].first, "Michael");
  assert.deepEqual([...seen[0].opts.selfEmails], ["michael@ag.invalid"]);
  assert.match(c.text, /^Anja,\n\nGood morning/, "the whole latest message, not the preview");
  assert.doesNotMatch(c.text, /send Anja the deck/);
  assert.equal(c.to, "anja@atos.invalid, michael@ag.invalid");
  assert.equal(c.earlier[0].text, "Anja, lovely to meet you");
  assert.equal(c.since.length, 1);
  assert.equal(c.since[0].channel, "email");
  assert.match(c.sinceSig, /^1:/);
});

// ── Invitations ──────────────────────────────────────────────────────────────

const inv = () => loadTs("lib/calendar/invitations.ts");
const standup = (date, status) => ({
  id: `alof6_${date}`, summary: "TalentGenius GTM standup", seriesId: "alof6_R20261109",
  start: `${date}T18:30:00Z`, end: `${date}T19:00:00Z`, myResponseStatus: status, isOrganizer: false,
});

test("invitations: dates of a repeating meeting you already said yes or maybe to are not invitations", () => {
  const now = Date.parse("2026-11-23T10:00:00Z");
  const events = [standup("2026-11-25", "tentative"), standup("2026-11-30", "accepted"), standup("2026-12-02", "needsAction"), standup("2026-12-04", "needsAction")];
  assert.equal(inv().pendingInvitations(events, now).length, 0);
  assert.equal(events.filter((e) => inv().needsAnswer(e, now)).length, 2, "the per-date rule alone shows both — the bug");
});

test("invitations: a new repeating meeting shows once, at its first date; one-off invitations all show", () => {
  const now = Date.parse("2026-11-23T10:00:00Z");
  const fresh = (date) => ({ ...standup(date, "needsAction"), id: `new_${date}`, seriesId: "new_R", summary: "New weekly" });
  const oneOff = { id: "o1", summary: "Atos call", start: "2026-11-26T10:00:00Z", end: "2026-11-26T10:30:00Z", myResponseStatus: "needsAction" };
  const declinedSeries = [{ ...standup("2026-11-24", "declined"), seriesId: "d_R", id: "d1" }, { ...standup("2026-11-26", "needsAction"), seriesId: "d_R", id: "d2" }];
  const out = inv().pendingInvitations([fresh("2026-12-03"), fresh("2026-11-26"), oneOff, ...declinedSeries], now);
  assert.deepEqual([...out.map((e) => e.id)].sort(), ["d2", "new_2026-11-26", "o1"], "declining one date does not answer the series");
});
