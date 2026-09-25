/**
 * Follow-up sources: a read that threw is DEGRADED, not "not connected".
 * Plus the layout guard: every dashboard page mounts once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plain = (v) => structuredClone(v);

function detector({ gmailThrows = false, slackThrows = false, googleConnected = true, slackConnected = true } = {}) {
  return loadTs("lib/followups/detect.ts", {
    "@/lib/google/gmail": {
      getRecentEmails: async () => { if (gmailThrows) throw new Error("429 rate limited"); return []; },
      getGmailAddress: async () => "fixture@example.invalid", checkThreadForSentReply: async () => null,
    },
    "@/lib/google/calendar": { getEventsForDateRange: async () => [] },
    "@/lib/followups/invitation-rsvp": { findAnsweringCalendarEvent: () => null },
    "@/lib/slack/client": {
      getSlackUserClientForUser: async () => { if (slackThrows) throw new Error("slack down"); return null; },
      isSlackConnected: async () => slackConnected,
    },
    "@/lib/google/auth": { isGoogleConnected: async () => googleConnected },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ names: [], emails: [] }), isSelf: () => false },
  });
}

test("a Gmail read that throws is reported as degraded — and Gmail stays connected", async () => {
  const quiet = console.warn; console.warn = () => {};
  try {
    const r = await detector({ gmailThrows: true }).detectPendingFollowups("fixture", { maxAgeDays: 7, staleHours: 24 });
    assert.deepEqual(plain(r.degraded), ["Gmail"]);
    assert.equal(r.sources.gmail, true, "it IS connected; it did not answer");
    assert.equal(r.items.length, 0);
  } finally { console.warn = quiet; }
});

test("a degraded result is never served from the cache on the next call", async () => {
  const quiet = console.warn; console.warn = () => {};
  try {
    const D = detector({ gmailThrows: true });
    await D.detectPendingFollowups("fixture", { maxAgeDays: 7, staleHours: 24 });
    const again = await D.detectPendingFollowups("fixture", { maxAgeDays: 7, staleHours: 24 });
    assert.deepEqual(plain(again.degraded), ["Gmail"], "second call re-ran the detection rather than trusting a known-bad empty");
  } finally { console.warn = quiet; }
});

test("the feed carries follow-up degradation through to the dashboard", async () => {
  const quiet = console.warn; console.warn = () => {};
  try {
    const F = loadTs("lib/today/feed.ts", {
      "@/lib/delta/compute": { computeDeltas: () => ({ changes: [] }) },
      "@/lib/delta/types": { SEVERITY_WEIGHT: { critical: 1, high: 0.7, medium: 0.4 }, CATEGORY_CONFIG: { urgency: { weight: 1 } } },
      "@/lib/delta/store": { getSinceDate: async () => new Date().toISOString() },
      "@/lib/actions/store": { listActions: async () => [] }, "@/lib/decisions/store": { listDecisions: async () => [] },
      "@/lib/contacts/user-store": { listUserContacts: async () => [] }, "@/lib/contacts/overrides-store": { getAllOverridesFromStore: async () => ({}) },
      "@/lib/linear/client": { isLinearConnected: async () => true, getMyOpenIssues: async () => { throw new Error("linear outage"); } },
      "@/lib/followups/detect": { detectPendingFollowups: async () => ({ items: [], sources: { gmail: true, slack: true }, degraded: ["Gmail"] }) },
      "@/lib/learning/store": { getLearning: async () => ({}) }, "@/lib/settings/store": { getSettings: async () => ({}) },
      "@/lib/learning/priors": { computeCategoryPriors: () => ({}) },
    });
    const feed = await F.computeTodayFeed("fixture");
    assert.deepEqual(plain(feed.degraded), ["Gmail", "Linear"]);
    assert.equal(feed.sources.followups.gmail, true);
    const X = loadTs("lib/today/executive.ts");
    assert.match(X.emptyBoardMessage([], feed.degraded), /Gmail and Linear could not be read/);
  } finally { console.warn = quiet; }
});

test("the dashboard layout mounts its page exactly once", () => {
  const src = readFileSync(path.join(ROOT, "app/dashboard/layout.tsx"), "utf8");
  assert.equal((src.match(/\{children\}/g) ?? []).length, 1, "two shells meant every page fetched, ran and announced twice");
  assert.equal((src.match(/<main\b/g) ?? []).length, 1);
});
