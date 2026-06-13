/**
 * tests/slack-cleanup-safety.test.mjs
 *
 * Safety guard for the destructive non-member Slack cleanup
 * (lib/slack/cleanup-nonmember.ts + the admin route). These invariants are what
 * keep the cleanup from ever deleting legitimate data; this test fails loudly if
 * any of them is weakened.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const CLEANUP = "lib/slack/cleanup-nonmember.ts";
const ROUTE = "app/api/admin/cleanup-slack-nonmember/route.ts";

test("getMemberChannelIds is fail-closed: errors and empties return { ok: false }", () => {
  const src = read(CLEANUP);
  // catch block must abort
  assert.ok(/catch\s*\{[^}]*return\s*\{\s*ok:\s*false\s*\}/s.test(src),
    "a Slack API error must return { ok: false }");
  // empty member set must abort (not treated as 'member of nothing')
  assert.ok(/ids\.size\s*===\s*0[^\n]*\n[^\n]*return\s*\{\s*ok:\s*false\s*\}/.test(src)
      || /if\s*\(ids\.size\s*===\s*0\)\s*return\s*\{\s*ok:\s*false\s*\}/.test(src),
    "an empty member set must return { ok: false }");
});

test("purge aborts (deletes nothing) when membership can't be resolved", () => {
  const src = read(CLEANUP);
  assert.ok(/if\s*\(!member\.ok\)\s*return\s+emptyReport/.test(src),
    "purgeNonMemberSlackItems must return emptyReport (aborted) when member.ok is false");
});

test("slackRefsVerdict keeps unless every parseable channel ref is non-member", () => {
  const src = read(CLEANUP);
  // no parseable channel id → keep
  assert.ok(/channelIds\.length\s*===\s*0\)\s*return\s*"keep"/.test(src),
    "an item with no parseable Slack channel ref must be kept");
  // any member ref → keep
  assert.ok(/some\(\(id\)\s*=>\s*memberIds\.has\(id\)\)\)\s*return\s*"keep"/.test(src),
    "an item with any member-channel ref must be kept");
});

test("parseSlackChannelId validates the channel id shape (C/G/D…)", () => {
  const src = read(CLEANUP);
  assert.ok(/\[CGD\]\[A-Z0-9\]/.test(src),
    "channel id must be validated against the C/G/D Slack id pattern");
  assert.ok(/parts\[0\]\s*!==\s*"slack"/.test(src),
    "ref must start with the slack: prefix to be parseable");
});

test("bulk signal-store writes use allowShrink (won't be blocked by the shrink guard)", () => {
  const src = read(CLEANUP);
  assert.ok((src.match(/allowShrink:\s*true/g) || []).length >= 2,
    "both signal-event and thread bulk writes must pass allowShrink: true");
});

test("admin route defaults dryRun to true (destructive op requires explicit opt-in)", () => {
  const src = read(ROUTE);
  assert.ok(/let\s+dryRun\s*=\s*true/.test(src),
    "dryRun must default to true so an accidental call never deletes");
  assert.ok(/x-admin-token/.test(src) && /ADMIN_API_TOKEN/.test(src),
    "route must be protected by ADMIN_API_TOKEN");
});
