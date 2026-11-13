// Asks that are already done, or whose moment has passed, close themselves;
// each row on Today gets Complete / Ongoing / Take me there (2026-11-13).
// On 2026-11-13 "You promised" showed four overdue items the user (or someone
// else) had already finished: Basil only re-read the source thread of email and
// Slack actions, never meeting actions, never what the user sent elsewhere, and
// had no idea of "that date has gone".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const utils = loadTs("lib/actions/utils.ts", {});
const outbound = loadTs("lib/briefing/outbound-evidence.ts");
const same = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

function load({ actions = [], judge, sent = [] } = {}) {
  const writes = [];
  const D = loadTs("lib/actions/check-done.ts", {
    zod: require("zod"),
    "@/lib/actions/utils": utils,
    "@/lib/briefing/outbound-evidence": outbound,
    "@/lib/actions/store": { listActions: async () => actions, bulkUpdateActions: async (_u, ups) => { writes.push(...ups); } },
    "@/lib/google/gmail": { getSentEmails: async () => sent },
    "@/lib/slack/client": { getRecentSlackMessages: async () => [] },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ names: ["Michael Cook"], emails: [] }) },
    "@/lib/settings/store": { getSettings: async () => ({ name: "Michael Cook", timezone: "Europe/London" }) },
    "@/lib/away/store": { getWorkCalendar: async () => ({ away: [{ start: "2026-10-24", end: "2026-11-07", label: "Honeymoon" }] }) },
    "@/lib/ai/generate": { generateTextSafe: async () => { throw new Error("no model in tests"); } },
    "@/lib/ai/model-config": { getTextModel: () => "balanced" },
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod: require("zod") }),
  });
  return { D, writes };
}

const act = (over) => ({ id: "a", text: "x", owner: "Michael Cook", status: "open", source: "meeting", createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z", ...over });
const ev = (over) => ({ channel: "email", to: "", subject: "", text: "", at: "2026-11-05T09:00:00Z", explicitlyDone: false, ...over });

test("every open ask of the user's is checked, meetings and chat too; others' commitments and unconfirmed ones are not", () => {
  const { D } = load();
  const now = Date.parse("2026-11-13T07:00:00Z");
  assert.equal(D.dueForDoneCheck(act({ source: "meeting" }), ["Michael Cook"], now), true, "meeting actions were never checked before");
  assert.equal(D.dueForDoneCheck(act({ source: "chat", status: "overdue" }), ["Michael Cook"], now), true);
  assert.equal(D.dueForDoneCheck(act({ owner: "Carter Diaz" }), ["Michael Cook"], now), false, "waiting on someone else");
  assert.equal(D.dueForDoneCheck(act({ needsReview: true }), ["Michael Cook"], now), false);
  assert.equal(D.dueForDoneCheck(act({ status: "done" }), ["Michael Cook"], now), false);
  assert.equal(D.dueForDoneCheck(act({ doneCheckedAt: "2026-11-13T01:00:00Z" }), ["Michael Cook"], now), false, "once a day");
});

test("evidence: what the user sent since the ask, to the people it names or about what it says", () => {
  const { D } = load();
  const ask = act({ text: "Send Ed and the pod team the Exec Genius data package: data structure spec and sample data" });
  const events = [
    ev({ to: "Ed Baum <ed@example.com>", subject: "Exec Genius data package", text: "Attached: data structure spec and sample data for 5 companies", at: "2026-11-06T10:00:00Z" }),
    ev({ to: "Dana", subject: "Lunch?", text: "Free Thursday?" }),
    ev({ to: "Ed Baum", subject: "Old thread", text: "before the ask", at: "2026-11-01T10:00:00Z" }),
  ];
  const picked = D.evidenceFor(ask, events);
  same(picked.map((e) => e.subject), ["Exec Genius data package"], "unrelated and earlier messages are left out");
  const mine = D.properNouns("Wrap up AIE work so the team can carry on without Michael", ["Michael Cook"]);
  assert.ok(!mine.has("michael"), "the user's own name matches every message they sign, so it is not evidence");
  assert.ok(mine.has("aie"));
});

test("the judge is told today's date, the user's time away and the evidence, and to keep anything doubtful open", () => {
  const { D } = load();
  const prompt = D.doneCheckPrompt({
    firstName: "Michael", today: "Fri, 13 Nov 2026",
    action: act({ text: "Wrap up AIE work before the honeymoon so the team can carry on without Michael" }),
    evidence: [], absences: ["2026-10-24 to 2026-11-07 (Honeymoon)"],
  });
  assert.match(prompt, /Today is Fri, 13 Nov 2026/);
  assert.match(prompt, /time away: 2026-10-24 to 2026-11-07 \(Honeymoon\)/);
  assert.match(prompt, /"expired": the item is tied to a specific date or event that has clearly passed/);
  assert.match(prompt, /choose "open" whenever in doubt/);
});

test("a close is marked as Basil's, says why, and can be reopened; open only moves the check time", () => {
  const { D } = load();
  const done = D.patchFor({ notes: "mine" }, { state: "done", reason: "sent Ed the package", evidence: "1, Ed Baum" }, "2026-11-13T07:00:00.000Z");
  assert.equal(done.status, "done");
  assert.equal(done.archivedReason, "promise-kept");
  assert.equal(done.closedByBasil, true);
  assert.match(done.notes, /^mine\nClosed by Basil on 2026-11-13: looks done — sent Ed the package \(1, Ed Baum\)\. Reopen it if not\.$/);
  const past = D.patchFor({}, { state: "expired", reason: "12 Nov has passed" }, "2026-11-13T07:00:00.000Z");
  assert.equal(past.archivedReason, "expired");
  assert.match(past.notes, /the moment for this has passed — 12 Nov has passed/);
  same(D.patchFor({}, { state: "open", reason: "" }, "2026-11-13T07:00:00.000Z"), { doneCheckedAt: "2026-11-13T07:00:00.000Z" });
});

test("the run closes what the judge is sure of, leaves the rest, and fails safe", async () => {
  const actions = [
    act({ id: "ed", text: "Send Ed the Exec Genius data package" }),
    act({ id: "malcolm", source: "email", text: "Confirm or respond to Malcolm Frank's request to move the TG Leadership event to Thu, Nov 12 at 12:00 PM." }),
    act({ id: "rfi", source: "email", text: "Review the 27 submitted answers from Mike's Test RFI" }),
    act({ id: "carter", owner: "Carter Diaz", text: "Carter to send the brochure" }),
  ];
  const sent = [{ to: "Ed Baum", subject: "Exec Genius data package", snippet: "Here it is", date: "2026-11-06T10:00:00Z" }];
  const verdicts = { ed: { state: "done", reason: "emailed Ed the package" }, malcolm: { state: "expired", reason: "12 Nov has passed" } };
  const seen = [];
  const { D, writes } = load({ actions, sent });
  const judge = async (prompt) => {
    const id = prompt.includes("Ed the Exec") ? "ed" : prompt.includes("Malcolm") ? "malcolm" : "rfi";
    seen.push(id);
    if (id === "rfi") throw new Error("model down"); // a broken judge must keep it open
    return verdicts[id];
  };
  const safeJudge = async (p) => { try { return await judge(p); } catch { return { state: "open", reason: "" }; } };
  const out = await D.checkDoneActions("michael", { judge: safeJudge, now: Date.parse("2026-11-13T07:00:00Z") });
  assert.equal(out.checked, 3, "Carter's commitment is not the user's to close");
  same(out.closed.map((c) => [c.id, c.state]).sort(), [["ed", "done"], ["malcolm", "expired"]]);
  const byId = Object.fromEntries(writes.map((w) => [w.id, w.patch]));
  assert.equal(byId.rfi.status, undefined, "kept open");
  assert.ok(byId.rfi.doneCheckedAt);
  assert.equal(byId.ed.closedByBasil, true);
});

test("Ongoing: in hand, not overdue, and it checks in again at its follow-up date", () => {
  const X = loadTs("lib/today/executive.ts");
  const now = new Date("2026-11-13T09:00:00Z");
  const b = X.bucketCommitments([
    act({ id: "o", dueDate: "2026-11-01", ongoing: true, followUpDate: "2026-11-20" }),
    act({ id: "late", dueDate: "2026-11-01" }),
    act({ id: "checkin", dueDate: "2026-11-01", ongoing: true, followUpDate: "2026-11-12" }),
  ], now, "Europe/London");
  same(b.overdue.map((a) => a.id), ["late", "checkin"], "an ongoing item whose check-in has come is back in view");
  same(b.ongoing.map((a) => a.id), ["o"]);
  const R = loadTs("lib/notify/rules.ts", { "@/lib/actions/utils": utils });
  same(R.dueReminders([act({ id: "o", dueDate: "2026-11-01", ongoing: true, followUpDate: "2026-11-20" })], "2026-11-13", "Europe/London", ["Michael Cook"]), [], "no overdue nagging");
  same(R.dueReminders([act({ id: "c", dueDate: "2026-11-01", ongoing: true, followUpDate: "2026-11-13" })], "2026-11-13", "Europe/London", ["Michael Cook"]).map((r) => r.reason), ["follow-up"], "the weekly check-in");
  const route = src("app/api/actions/[id]/route.ts");
  assert.match(route, /ongoing: z\.boolean\(\)\.optional\(\)/);
  assert.match(route, /if \(!parsed\.data\.followUpDate\) patch\.followUpDate = new Date\(Date\.now\(\) \+ 7 \* 86_400_000\)/);
  assert.match(route, /if \(parsed\.data\.status === "open"\) \{\s*patch\.archivedReason = undefined;\s*patch\.closedByBasil = undefined;/, "reopening a Basil close makes it the user's again");
});

test("Take me there: the email in place, the work link inside it, the Slack message, or Ask Basil", () => {
  const T = loadTs("lib/actions/destination.ts");
  const body = `Mike submitted 27 answers.\nReview them on the Evidence tab: https://app.agentgenius.ai/rfi/123/evidence\n\nManage notifications: https://app.agentgenius.ai/settings/notifications\nUnsubscribe https://mail.example.com/unsubscribe?u=1\nhttps://cdn.example.com/logo.png`;
  same(T.pickActionLink(body, "Review the 27 submitted answers from Mike's Test RFI on the Evidence tab"),
    { href: "https://app.agentgenius.ai/rfi/123/evidence", label: "Open in app.agentgenius.ai", external: true });
  assert.equal(T.pickActionLink("Unsubscribe: https://x.com/unsubscribe", "anything"), null);
  const email = T.baseDestination({ text: "Confirm the move", source: "email", sourceRef: "gmail:18abc" });
  assert.equal(email.emailId, "18abc", "opened in Basil, where it can be answered or RSVP'd");
  const meeting = T.baseDestination({ text: "Send Ed the data package", source: "meeting" });
  assert.equal(meeting.links.length, 1);
  assert.equal(meeting.links[0].href, `/dashboard/chat?q=${encodeURIComponent("Help me get this done: Send Ed the data package")}`);
  const route = src("app/api/actions/[id]/destination/route.ts");
  assert.match(route, /pickActionLink\(mail\.body, action\.text\)/);
  assert.match(route, /chat\.getPermalink\(\{ channel, message_ts: ts \}\)/);
});

test("Today: each promise has Complete, Ongoing and Take me there, and the list tidies itself when opened", () => {
  const row = src("components/today/promise-row.tsx");
  for (const label of ["Complete", "Ongoing", "Take me there"]) assert.match(row, new RegExp(`\\} ${label}\\n|\\{dest \\? "Close" : "${label}"\\}`), label);
  assert.match(row, /body: JSON\.stringify\(body\)/);
  const today = src("app/dashboard/page.tsx");
  assert.match(today, /<PromiseRow key=\{a\.id\} action=\{a\}/);
  assert.match(today, /fetch\("\/api\/actions\/resolve-threads", \{ method: "POST" \}\)/);
  assert.match(today, /due: "Ongoing"/);
  assert.match(src("app/api/actions/resolve-threads/route.ts"), /await checkDoneActions\(username\)/);
  assert.match(src("app/api/events/poll-ingest/route.ts"), /await checkDoneActions\(username\)/);
});
