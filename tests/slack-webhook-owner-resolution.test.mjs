/**
 * tests/slack-webhook-owner-resolution.test.mjs
 *
 * Regression guard: Slack webhook ownership must use deterministic team_id
 * matching, never first-match semantics.
 *
 * Rules enforced:
 *   – resolveSlackUserByTeam() is present in lib/webhooks/resolve-user.ts
 *   – resolveSlackUserByTeam() uses teamId for matching (not first-connected)
 *   – resolveSlackUserByTeam() returns "ambiguous" when multiple users share a workspace
 *   – The Slack webhook route uses resolveSlackUserByTeam, not resolveSlackUser
 *   – The Slack webhook route dead-letters when team_id is missing
 *   – The Slack webhook route dead-letters when team_id is unresolved
 *   – The Slack webhook route dead-letters when owner is ambiguous
 *   – UnknownSlackPayload interface includes team_id and enterprise_id fields
 *   – SlackConfig interface includes teamId, teamName, enterpriseId, authUserId,
 *     botUserId, scopes, and connectedAt fields
 *   – OAuth callback stores all workspace metadata (not just tokens)
 *
 * All tests use static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function read(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

// ── resolveSlackUserByTeam presence and shape ─────────────────────────────────

test("lib/webhooks/resolve-user.ts: exports resolveSlackUserByTeam function", () => {
  const src = read("lib/webhooks/resolve-user.ts");
  assert.ok(
    src.includes("export async function resolveSlackUserByTeam"),
    "resolve-user.ts must export resolveSlackUserByTeam"
  );
});

test("lib/webhooks/resolve-user.ts: resolveSlackUserByTeam accepts teamId parameter", () => {
  const src = read("lib/webhooks/resolve-user.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /resolveSlackUserByTeam\s*\(\s*teamId\s*:\s*string/.test(collapsed),
    "resolveSlackUserByTeam must accept teamId: string as its first parameter"
  );
});

test("lib/webhooks/resolve-user.ts: resolveSlackUserByTeam accepts optional enterpriseId parameter", () => {
  const src = read("lib/webhooks/resolve-user.ts");
  assert.ok(
    src.includes("enterpriseId"),
    "resolveSlackUserByTeam must accept an optional enterpriseId parameter"
  );
});

test("lib/webhooks/resolve-user.ts: resolveSlackUserByTeam return type includes 'ambiguous'", () => {
  const src = read("lib/webhooks/resolve-user.ts");
  assert.ok(
    src.includes('"ambiguous"'),
    'resolveSlackUserByTeam must be able to return "ambiguous" for multi-user workspaces'
  );
});

test("lib/webhooks/resolve-user.ts: resolveSlackUserByTeam matches on config.teamId", () => {
  const src = read("lib/webhooks/resolve-user.ts");
  assert.ok(
    src.includes("config.teamId"),
    "resolveSlackUserByTeam must check config.teamId for workspace matching"
  );
});

test("lib/webhooks/resolve-user.ts: resolveSlackUserByTeam returns null for empty teamId", () => {
  const src = read("lib/webhooks/resolve-user.ts");
  assert.ok(
    src.includes("if (!teamId) return null"),
    "resolveSlackUserByTeam must return null immediately when teamId is falsy"
  );
});

test("lib/webhooks/resolve-user.ts: resolveSlackUser is deprecated (not removed)", () => {
  const src = read("lib/webhooks/resolve-user.ts");
  assert.ok(
    src.includes("resolveSlackUser"),
    "resolveSlackUser must still exist for backward compatibility"
  );
  assert.ok(
    src.includes("@deprecated"),
    "resolveSlackUser must be marked @deprecated in its JSDoc"
  );
});

// ── Slack webhook route: uses deterministic resolution ────────────────────────

test("app/api/webhooks/slack/route.ts: imports resolveSlackUserByTeam (not first-match resolveSlackUser)", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  assert.ok(
    src.includes("resolveSlackUserByTeam"),
    "Slack webhook must import and use resolveSlackUserByTeam"
  );
  // The old first-match resolver must not be the one imported
  assert.ok(
    !src.includes('{ resolveSlackUser }'),
    "Slack webhook must not import the first-match resolveSlackUser by itself"
  );
});

test("app/api/webhooks/slack/route.ts: extracts team_id from parsed payload", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  assert.ok(
    src.includes("parsed.team_id"),
    "Slack webhook must extract team_id from the parsed event_callback payload"
  );
});

test("app/api/webhooks/slack/route.ts: dead-letters when team_id is missing", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  assert.ok(
    src.includes("Missing team_id") || src.includes("missing team_id"),
    "Slack webhook must dead-letter events that have no team_id"
  );
});

test("app/api/webhooks/slack/route.ts: dead-letters when owner is null (unresolved)", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  assert.ok(
    src.includes("resolved === null"),
    "Slack webhook must dead-letter when resolveSlackUserByTeam returns null"
  );
});

test("app/api/webhooks/slack/route.ts: dead-letters when owner is ambiguous", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  assert.ok(
    src.includes('resolved === "ambiguous"'),
    'Slack webhook must dead-letter when resolveSlackUserByTeam returns "ambiguous"'
  );
  assert.ok(
    src.includes("Ambiguous owner") || src.includes("ambiguous"),
    "Slack webhook dead-letter message must indicate the ambiguous-owner reason"
  );
});

test("app/api/webhooks/slack/route.ts: still calls writeDeadLetter", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  assert.ok(
    src.includes("writeDeadLetter"),
    "Slack webhook must still call writeDeadLetter for unresolvable events"
  );
});

// ── UnknownSlackPayload type includes workspace fields ────────────────────────

test("app/api/webhooks/slack/route.ts: UnknownSlackPayload has team_id field", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface UnknownSlackPayload \{[^}]*team_id\?/.test(collapsed),
    "UnknownSlackPayload must declare an optional team_id field"
  );
});

test("app/api/webhooks/slack/route.ts: UnknownSlackPayload has enterprise_id field", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface UnknownSlackPayload \{[^}]*enterprise_id\?/.test(collapsed),
    "UnknownSlackPayload must declare an optional enterprise_id field"
  );
});

// ── SlackConfig interface stores workspace metadata ───────────────────────────

test("lib/slack/client.ts: SlackConfig includes teamId field", () => {
  const src = read("lib/slack/client.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface SlackConfig \{[^}]*teamId\?/.test(collapsed),
    "SlackConfig must declare an optional teamId field"
  );
});

test("lib/slack/client.ts: SlackConfig includes teamName field", () => {
  const src = read("lib/slack/client.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface SlackConfig \{[^}]*teamName\?/.test(collapsed),
    "SlackConfig must declare an optional teamName field"
  );
});

test("lib/slack/client.ts: SlackConfig includes enterpriseId field", () => {
  const src = read("lib/slack/client.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface SlackConfig \{[^}]*enterpriseId\?/.test(collapsed),
    "SlackConfig must declare an optional enterpriseId field"
  );
});

test("lib/slack/client.ts: SlackConfig includes botUserId field", () => {
  const src = read("lib/slack/client.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface SlackConfig \{[^}]*botUserId\?/.test(collapsed),
    "SlackConfig must declare an optional botUserId field"
  );
});

test("lib/slack/client.ts: SlackConfig includes connectedAt field", () => {
  const src = read("lib/slack/client.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface SlackConfig \{[^}]*connectedAt\?/.test(collapsed),
    "SlackConfig must declare an optional connectedAt field"
  );
});

// ── OAuth callback stores workspace metadata ──────────────────────────────────

test("app/api/auth/slack/callback/route.ts: stores teamId at connect time", () => {
  const src = read("app/api/auth/slack/callback/route.ts");
  assert.ok(
    src.includes("teamId:"),
    "Slack OAuth callback must store teamId in the user config"
  );
});

test("app/api/auth/slack/callback/route.ts: stores teamName at connect time", () => {
  const src = read("app/api/auth/slack/callback/route.ts");
  assert.ok(
    src.includes("teamName:"),
    "Slack OAuth callback must store teamName in the user config"
  );
});

test("app/api/auth/slack/callback/route.ts: stores enterpriseId at connect time", () => {
  const src = read("app/api/auth/slack/callback/route.ts");
  assert.ok(
    src.includes("enterpriseId:"),
    "Slack OAuth callback must store enterpriseId in the user config"
  );
});

test("app/api/auth/slack/callback/route.ts: stores botUserId at connect time", () => {
  const src = read("app/api/auth/slack/callback/route.ts");
  assert.ok(
    src.includes("botUserId:"),
    "Slack OAuth callback must store botUserId in the user config"
  );
});

test("app/api/auth/slack/callback/route.ts: stores connectedAt timestamp", () => {
  const src = read("app/api/auth/slack/callback/route.ts");
  assert.ok(
    src.includes("connectedAt:"),
    "Slack OAuth callback must store connectedAt ISO timestamp"
  );
});

test("app/api/auth/slack/callback/route.ts: aborts when team.id is absent", () => {
  const src = read("app/api/auth/slack/callback/route.ts");
  assert.ok(
    src.includes("data.team?.id") || src.includes("data.team.id"),
    "Slack OAuth callback must guard against missing team.id"
  );
  // Should dead-letter / redirect to error when team.id is absent
  assert.ok(
    src.includes("team.id") && (src.includes("errorDest") || src.includes("cannot store")),
    "Slack OAuth callback must route to error destination when team.id is absent"
  );
});
