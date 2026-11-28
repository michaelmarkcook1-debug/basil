// Live audit 2026-11-28: Basil's notices reach the user from their own Gmail
// (Resend refused the unverified domain), and unanswered pending events expire
// after 30 days instead of piling up forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("briefing email and notification fallback go through emailUser (Gmail to self, Resend fallback)", () => {
  assert.match(read("lib/briefing/delivery.ts"), /await emailUser\(username, \{ to: user\.email, subject, html, text \}\)/);
  assert.doesNotMatch(read("lib/briefing/delivery.ts"), /isEmailConfigured\(\)/);
  assert.match(read("lib/notify/index.ts"), /await emailUser\(username, \{\n\s+to: user\.email/);
  const u = read("lib/email/to-user.ts");
  assert.match(u, /sendNoticeToSelf\(username, msg\.to/);
  assert.ok(u.indexOf("sendNoticeToSelf") < u.indexOf("sendEmail({"), "Gmail first, Resend second");
});

test("Basil's own notices are marked and never ingested back", () => {
  const g = read("lib/google/gmail.ts");
  assert.match(g, /X-Basil-Notice: 1/);
  assert.match(g, /Auto-Submitted: auto-generated/);
  const w = read("app/api/webhooks/gmail/route.ts");
  assert.match(w, /"X-Basil-Notice"\]/);
  assert.match(w, /if \(h\("X-Basil-Notice"\)\) return;/);
});

test("pending drafts and notices expire after 30 days, are kept to 45, and expiry alone triggers a write", () => {
  const s = read("lib/events/store.ts");
  assert.match(s, /export const EXPIRE_AFTER_DAYS = 30;/);
  assert.match(s, /const EXPIRED_KEEP_DAYS = 45;/);
  assert.match(s, /if \(pruned > 0 \|\| expiredCount > 0\)/);
  assert.match(read("lib/events/types.ts"), /\| "expired";/);
});

import { loadTs } from "./_helpers/load-ts.mjs";
test("expireIfStale: only pending drafts/notices over 30 days", () => {
  const S = loadTs("lib/events/store.ts", {
    "@/lib/storage/user-store": { readUserStore: async () => [], writeUserStore: async () => {} },
    "./lock": { withLock: async (_k, fn) => fn() },
  });
  const now = "2026-11-28T12:00:00Z";
  const ev = (o) => ({ id: "e", source: "slack", headline: "", context: "", disposition: "draft", priority: "normal", status: "pending", rationale: "", tags: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "", ...o });
  assert.equal(S.expireIfStale(ev({}), now).status, "expired");
  assert.equal(S.expireIfStale(ev({ disposition: "notify" }), now).status, "expired");
  assert.equal(S.expireIfStale(ev({ createdAt: "2026-11-10T00:00:00Z" }), now).status, "pending");
  assert.equal(S.expireIfStale(ev({ status: "executing" }), now).status, "executing");
  assert.equal(S.expireIfStale(ev({ disposition: "auto" }), now).status, "pending");
});
