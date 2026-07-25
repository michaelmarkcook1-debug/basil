/**
 * tests/slack-channel-relevance.test.mjs
 *
 * Regression guard: Slack signals/actions/decisions must only surface from
 * channels the user actually participates in. The owner reported receiving
 * intelligence from public channels they never joined and aren't mentioned in.
 *
 * Rules enforced (per-user, no hardcoded identity — satisfies
 * tests/no-hardcoded-users.test.mjs):
 *   – getRecentSlackMessages filters public/private channels by `is_member`
 *     (channels the user hasn't joined are dropped at fetch time)
 *   – Mention detection matches the Slack user id token `<@U…>` on RAW text,
 *     NOT a substring of the app username (the old, broken behaviour)
 *   – SlackMessage and IngestPayload.hints carry an `isMember` flag
 *   – shouldClassifySlack hard-rejects known non-member, non-addressed messages
 *   – The relevance signal derives from the authenticated Slack identity
 *     (resolveSelfUserId / auth.test), never a literal name
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

// ── Fetch-time membership filter ──────────────────────────────────────────────

test("client.ts: getRecentSlackMessages filters channels by is_member", () => {
  const src = read("lib/slack/client.ts");
  assert.ok(
    /\.filter\(\([^)]*\)\s*=>\s*[^)]*\bis_member\s*===\s*true\)/.test(src),
    "public/private channel list must be filtered to is_member === true"
  );
});

test("client.ts: mention detection matches the Slack <@id> token, not the username substring", () => {
  const src = read("lib/slack/client.ts");
  // The corrected helper must exist and match the raw <@id> token.
  assert.ok(
    src.includes("function mentionsSelf"),
    "mentionsSelf() helper must exist"
  );
  assert.ok(
    src.includes("`<@${selfUserId}>`"),
    "mentionsSelf must match the raw Slack mention token <@selfUserId>"
  );
  // The old broken pattern must be gone everywhere.
  assert.ok(
    !/isMention:\s*\([^)]*\)\.toLowerCase\(\)\.includes\(username\)/.test(src),
    "the old username-substring mention check must be removed"
  );
});

test("client.ts: self id derives from the authenticated token (auth.test), not a literal", () => {
  const src = read("lib/slack/client.ts");
  assert.ok(
    src.includes("function resolveSelfUserId") && src.includes("web.auth.test()"),
    "self user id must come from auth.test() on the active token"
  );
});

// ── isMember threaded through the payload ─────────────────────────────────────

test("SlackMessage and IngestPayload.hints carry isMember", () => {
  assert.ok(/isMember\??:\s*boolean/.test(read("lib/slack/client.ts")),
    "SlackMessage must declare isMember");
  assert.ok(/isMember\?:\s*boolean/.test(read("lib/events/types.ts")),
    "IngestPayload.hints must declare isMember");
  assert.ok(read("app/api/events/poll-ingest/route.ts").includes("isMember"),
    "poll-ingest must populate/pass isMember");
});

// ── Classify relevance gate ───────────────────────────────────────────────────

test("shouldClassifySlack hard-rejects non-addressed channel messages (stricter than isMember)", () => {
  const src = read("lib/slack/classify-slack.ts");
  // The gate evolved to be STRICTER than the old isMember check: channel
  // chatter is never classified unless it's a DM / Group DM / @-mention.
  assert.ok(
    /if\s*\(opts\.isDM\s*\|\|\s*opts\.isGroupDM\s*\|\|\s*opts\.isMention\)\s*return\s*true/.test(src),
    "DMs, Group DMs and @-mentions must be classified"
  );
  assert.ok(
    /void\s+opts\.isMember;[\s\S]{0,200}return\s+false/.test(src),
    "all other channel messages must be rejected regardless of isMember"
  );
});
