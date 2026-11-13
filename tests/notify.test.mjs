// Notifications Basil sends without being asked (2026-11-10): lib/notify.
// Before this, a follow-up date passed without a word and a revoked Slack token
// looked like a quiet inbox until the user noticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const R = loadTs("lib/notify/rules.ts", { "@/lib/actions/utils": loadTs("lib/actions/utils.ts", {}) });

const action = (over = {}) => ({ id: "a1", text: "Send Dana the revised SOW", owner: "Michael Cook", status: "open", source: "email", createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z", ...over });
const ME = ["Michael Cook"];

test("reminders: the user's own follow-ups that have come round, things due today, and overdue ones", () => {
  const list = R.dueReminders([
    action({ id: "f", followUpDate: "2026-11-10" }),
    action({ id: "f-late", followUpDate: "2026-11-07" }),
    action({ id: "d", dueDate: "2026-11-10" }),
    action({ id: "o", dueDate: "2026-11-03" }),
    action({ id: "future", followUpDate: "2026-11-12", dueDate: "2026-11-20" }),
    action({ id: "done", dueDate: "2026-11-10", status: "done" }),
    action({ id: "review", dueDate: "2026-11-10", needsReview: true }),
    action({ id: "theirs", dueDate: "2026-11-10", owner: "Carter Diaz" }),
  ], "2026-11-10", "Europe/London", ME);
  assert.equal(JSON.stringify(list.map((r) => [r.id, r.reason])), JSON.stringify([["o", "overdue"], ["d", "due-today"], ["f-late", "follow-up"], ["f", "follow-up"]]));
});

test("reminders: a timestamped due date counts in the user's time zone", () => {
  // 23:30 UTC on the 9th is 10:30 on the 10th in Sydney.
  const due = R.dueReminders([action({ dueDate: "2026-11-09T23:30:00Z" })], "2026-11-10", "Australia/Sydney", ME);
  assert.equal(due[0]?.reason, "due-today");
  assert.equal(R.localDay("2026-11-09T23:30:00Z", "Europe/London"), "2026-11-09");
});

test("reminders: each action reminds once per date, and again only when the date moves", () => {
  const [r] = R.dueReminders([action({ followUpDate: "2026-11-10" })], "2026-11-10", "UTC", ME);
  const [moved] = R.dueReminders([action({ followUpDate: "2026-11-12" })], "2026-11-12", "UTC", ME);
  assert.notEqual(R.reminderKey(r), R.reminderKey(moved));
  assert.equal(R.reminderKey(r), R.reminderKey({ ...r }));
});

test("reminders arrive as one notification, never one per action", () => {
  assert.equal(R.reminderNotification([]), null);
  const one = R.reminderNotification([{ id: "a", text: "Chase the PO", reason: "follow-up", date: "2026-11-10" }]);
  assert.equal(one.title, "Follow up: Chase the PO");
  assert.equal(one.url, "/dashboard/actions");
  const many = R.reminderNotification([
    { id: "a", text: "A", reason: "overdue", date: "2026-11-01" },
    { id: "b", text: "B", reason: "due-today", date: "2026-11-10" },
    { id: "c", text: "C", reason: "follow-up", date: "2026-11-10" },
    { id: "d", text: "D", reason: "follow-up", date: "2026-11-10" },
  ]);
  assert.equal(many.title, "4 things to pick up today (1 overdue)");
  assert.match(many.body, /…and 1 more$/);
  assert.equal(many.tag, "basil-reminders", "a second morning replaces the first on the device");
});

test("connections: only failures that need signing in again are reported", () => {
  const broken = R.brokenConnections({
    slackTokenInvalid: true,
    lastPollErrors: { email: { message: "invalid_grant", fatal: true }, calendar: { message: "429", fatal: false }, teams: { message: "401", fatal: true } },
  });
  assert.equal(JSON.stringify(broken), JSON.stringify([{ source: "slack", label: "Slack" }, { source: "email", label: "Gmail" }, { source: "teams", label: "Microsoft Teams" }]));
  const n = R.connectionNotification(broken);
  assert.equal(n.title, "Slack, Gmail and Microsoft Teams stopped working");
  assert.equal(n.url, "/dashboard/settings?tab=sources");
  assert.equal(R.connectionNotification([]), null);
});

test("working-day helpers: start hour and local hour", () => {
  assert.equal(R.startHour("08:30"), 8);
  assert.equal(R.startHour("nonsense"), 9);
  assert.equal(R.hourIn(Date.parse("2026-11-10T09:10:00Z"), "Europe/London"), 9);
  assert.equal(R.hourIn(Date.parse("2026-07-10T08:10:00Z"), "Europe/London"), 9, "summer time");
  assert.equal(R.hourIn(Date.parse("2026-11-10T00:10:00Z"), "UTC"), 0);
});

test("the briefing push shows the first line of Critical today, without markdown", () => {
  assert.equal(R.briefingTeaser({ criticalToday: "\n**1. Board pack** due to Guy by noon\n- other" }), "Board pack due to Guy by noon");
  assert.equal(R.briefingTeaser({ criticalToday: null }), "Open Basil to see what needs you today.");
});

// ── Sending ──────────────────────────────────────────────────────────────────

function sender({ devices = [], prefs = {}, pushOutcome = () => ({}), env = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" }, emailOk = true } = {}) {
  let file = { devices, prefs, sent: {}, alerted: [] };
  const pushes = [];
  const emails = [];
  const store = {
    readUserStore: async () => JSON.parse(JSON.stringify(file)),
    updateUserStore: async (_u, _f, fn) => { file = JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(file))))); return file; },
  };
  const N = loadTs("lib/notify/index.ts", {
    "web-push": { __esModule: true, default: { sendNotification: async (sub, body, opts) => {
      pushes.push({ endpoint: sub.endpoint, body: JSON.parse(body), opts });
      const out = pushOutcome(sub.endpoint);
      if (out.status) throw Object.assign(new Error("push failed"), { statusCode: out.status });
      return { statusCode: 201 };
    } } },
    "@/lib/storage/user-store": store,
    "@/lib/email/send": { sendEmail: async (m) => { emails.push(m); return emailOk ? { ok: true } : { ok: false, error: "nope" }; } },
    "@/lib/http/origin": { publicOrigin: () => "https://basil.example" },
    "@/lib/users": { getUsers: async () => [{ username: "u", email: "u@example.com" }] },
    "@/lib/notify/rules": R,
  }, env);
  return { N, pushes, emails, file: () => file };
}

const dev = (endpoint) => ({ endpoint, keys: { p256dh: "k", auth: "a" }, label: "Mac · Chrome", createdAt: "2026-11-10T09:00:00Z" });
const note = (kind = "reminders") => ({ kind, title: "T", body: "B", url: "/dashboard/actions", tag: "t" });

test("send: every device gets it; a device the browser dropped is forgotten", async () => {
  const s = sender({ devices: [dev("https://push.example/a"), dev("https://push.example/b")], pushOutcome: (e) => (e.endsWith("/b") ? { status: 410 } : {}) });
  const out = await s.N.notifyUser("u", note(), { onceKeys: ["k1"] });
  assert.equal(out.pushed, 1);
  assert.equal(s.pushes.length, 2);
  assert.equal(s.pushes[0].body.url, "/dashboard/actions");
  assert.equal(JSON.stringify(s.file().devices.map((d) => d.endpoint)), JSON.stringify(["https://push.example/a"]));
  assert.ok(s.file().devices[0].lastOkAt);
  assert.ok(s.file().sent.k1);
});

test("send: once-only keys stop a second send, and a turned-off kind is not sent", async () => {
  const s = sender({ devices: [dev("https://push.example/a")] });
  await s.N.notifyUser("u", note(), { onceKeys: ["k1"] });
  const again = await s.N.notifyUser("u", note(), { onceKeys: ["k1"] });
  assert.equal(again.skipped, "already-sent");
  assert.equal(s.pushes.length, 1);
  const off = sender({ devices: [dev("https://push.example/a")], prefs: { briefing: false } });
  assert.equal((await off.N.notifyUser("u", note("briefing"))).skipped, "pref-off");
  assert.equal(off.pushes.length, 0);
});

test("send: a connection problem is emailed when no device has notifications on; reminders are not unless chosen", async () => {
  const s = sender();
  const conn = await s.N.notifyUser("u", note("connections"));
  assert.equal(conn.emailed, true);
  assert.equal(s.emails[0].to, "u@example.com");
  assert.match(s.emails[0].text, /https:\/\/basil\.example\/dashboard\/actions/);
  const rem = await s.N.notifyUser("u", note("reminders"), { onceKeys: ["r1"] });
  assert.equal(rem.skipped, "no-channel");
  assert.equal(s.file().sent.r1, undefined, "an undelivered reminder is not marked as sent");
  const opted = sender({ prefs: { emailReminders: true } });
  assert.equal((await opted.N.notifyUser("u", note("reminders"))).emailed, true);
});

test("send: without VAPID keys push is off, and email still covers connection problems", async () => {
  const s = sender({ devices: [dev("https://push.example/a")], env: {} });
  assert.equal(s.N.isPushConfigured(), false);
  const out = await s.N.notifyUser("u", note("connections"));
  assert.equal(s.pushes.length, 0);
  assert.equal(out.emailed, true);
});

test("connections are reported once per break, and again after recovering and breaking again", async () => {
  const s = sender({ devices: [dev("https://push.example/a")] });
  const slack = [{ source: "slack", label: "Slack" }];
  await s.N.alertBrokenConnections("u", slack, R.connectionNotification);
  await s.N.alertBrokenConnections("u", slack, R.connectionNotification);
  assert.equal(s.pushes.length, 1, "still broken an hour later: not repeated");
  await s.N.alertBrokenConnections("u", [], R.connectionNotification);
  assert.equal(JSON.stringify(s.file().alerted), "[]", "recovered: forgotten");
  await s.N.alertBrokenConnections("u", slack, R.connectionNotification);
  assert.equal(s.pushes.length, 2, "broke again: reported again");
});

test("subscriptions: only https push endpoints are stored; devices are shown by id, never by endpoint", async () => {
  const s = sender();
  assert.equal(s.N.isValidSubscription({ endpoint: "http://push.example/a", keys: { p256dh: "k", auth: "a" } }), false);
  assert.equal(s.N.isValidSubscription({ endpoint: "https://push.example/a", keys: { p256dh: "k" } }), false);
  assert.equal(s.N.isValidSubscription({ endpoint: "https://push.example/a", keys: { p256dh: "k", auth: "a" } }), true);
  await s.N.addDevice("u", { endpoint: "https://push.example/a", keys: { p256dh: "k", auth: "a" } }, "Mac · Chrome");
  await s.N.addDevice("u", { endpoint: "https://push.example/a", keys: { p256dh: "k2", auth: "a2" } }, "Mac · Chrome");
  assert.equal(s.file().devices.length, 1, "re-subscribing replaces, not duplicates");
  const id = s.N.deviceId("https://push.example/a");
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(await s.N.removeDevice("u", id), true);
  assert.equal(s.file().devices.length, 0);
  assert.doesNotMatch(src("app/api/notify/route.ts"), /endpoint: d\.endpoint/, "the API never returns endpoints");
});

test("wiring: hourly cron, briefing push, service worker, Settings card", () => {
  const vercel = JSON.parse(src("vercel.json"));
  assert.ok(vercel.crons.some((c) => c.path === "/api/cron/reminders" && c.schedule === "10 * * * *"));
  const cron = src("app/api/cron/reminders/route.ts");
  assert.match(cron, /!cronSecret \|\| req\.headers\.get\("authorization"\) !== `Bearer \$\{cronSecret\}`/);
  assert.match(cron, /status\?\.state === "away" \|\| status\?\.state === "non-working"/, "nothing on days off");
  assert.match(src("app/api/cron/generate-briefing/route.ts"), /kind: "briefing"/);
  const sw = src("public/sw.js");
  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /addEventListener\("notificationclick"/);
  assert.match(sw, /data\.url\.startsWith\("\/"\)/, "only paths inside Basil are opened");
  assert.match(src("app/dashboard/settings/page.tsx"), /<NotificationsCard \/>/);
  assert.match(src("components/settings/notifications-card.tsx"), /iOS 16\.4/);
  assert.equal(require(path.join(ROOT, "package.json")).dependencies["web-push"], "3.6.7");
});

test("an unparsed briefing is never delivered: no email, Slack or push; the page labels it", () => {
  const cron = src("app/api/cron/generate-briefing/route.ts");
  const skip = cron.indexOf("if (briefing.unparsed)");
  assert.ok(skip > 0 && skip < cron.indexOf("deliverBriefing(user.username, briefing)") && skip < cron.indexOf('kind: "briefing"'));
  assert.match(src("app/dashboard/briefing/page.tsx"), /\{briefing\.unparsed && \(/);
  const memory = src("app/dashboard/memory/page.tsx");
  assert.match(memory, /if \(data\.partial\) \{/, "a partial memory import keeps the text and says what was missed");
});
