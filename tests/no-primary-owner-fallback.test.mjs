/**
 * tests/no-primary-owner-fallback.test.mjs
 *
 * Regression guard: no ingestion, classification, or materialisation code
 * may fall back to PRIMARY_OWNER_USERNAME (or any other default user) when
 * the real owner cannot be resolved.
 *
 * Rules enforced:
 *   – PRIMARY_OWNER_USERNAME never appears as a default value in runtime lib/
 *     code (the only permitted use is a read-only AI personalization hint in
 *     lib/ai/system-prompt.ts, annotated with // ci-ok).
 *   – username is a required (non-optional) parameter in all materializers
 *     and classifiers.
 *   – All materializers / classifiers have an early guard that returns a safe
 *     empty result when username is empty.
 *   – Webhook handlers dead-letter events with unresolved owners.
 *   – Cron jobs resolve a real username or skip safely.
 *
 * All tests use static source analysis — no TypeScript compilation or live
 * server required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function read(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

// ── Helper: detect PRIMARY_OWNER_USERNAME as a default value ─────────────────

/**
 * Returns true if the source contains a PRIMARY_OWNER_USERNAME env-var
 * reference that is NOT suppressed with // ci-ok.
 */
function hasPrimaryOwnerFallback(src) {
  for (const line of src.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed.includes("PRIMARY_OWNER_USERNAME")) continue;
    // Allow pure comment lines
    if (/^\s*(\/\/|\*)/.test(trimmed)) continue;
    // Allow suppressed lines
    if (/\/\/\s*(ci-ok|ci:skip)/.test(trimmed)) continue;
    return true;
  }
  return false;
}

// ── PRIMARY_OWNER_USERNAME must not appear in runtime ingestion/materialisation ──

test("lib/email/classify-email.ts: no PRIMARY_OWNER_USERNAME fallback", () => {
  const src = read("lib/email/classify-email.ts");
  assert.ok(!hasPrimaryOwnerFallback(src),
    "lib/email/classify-email.ts must not use PRIMARY_OWNER_USERNAME as a default");
});

test("lib/email/materialize-email.ts: no PRIMARY_OWNER_USERNAME fallback", () => {
  const src = read("lib/email/materialize-email.ts");
  assert.ok(!hasPrimaryOwnerFallback(src),
    "lib/email/materialize-email.ts must not use PRIMARY_OWNER_USERNAME as a default");
});

test("lib/email/process-gmail-message.ts: no PRIMARY_OWNER_USERNAME fallback", () => {
  const src = read("lib/email/process-gmail-message.ts");
  assert.ok(!hasPrimaryOwnerFallback(src),
    "lib/email/process-gmail-message.ts must not use PRIMARY_OWNER_USERNAME as a default");
});

test("lib/slack/classify-slack.ts: no PRIMARY_OWNER_USERNAME fallback", () => {
  const src = read("lib/slack/classify-slack.ts");
  assert.ok(!hasPrimaryOwnerFallback(src),
    "lib/slack/classify-slack.ts must not use PRIMARY_OWNER_USERNAME as a default");
});

test("lib/slack/materialize-slack.ts: no PRIMARY_OWNER_USERNAME fallback", () => {
  const src = read("lib/slack/materialize-slack.ts");
  assert.ok(!hasPrimaryOwnerFallback(src),
    "lib/slack/materialize-slack.ts must not use PRIMARY_OWNER_USERNAME as a default");
});

test("lib/teams/materialize-teams.ts: no PRIMARY_OWNER_USERNAME fallback", () => {
  const src = read("lib/teams/materialize-teams.ts");
  assert.ok(!hasPrimaryOwnerFallback(src),
    "lib/teams/materialize-teams.ts must not use PRIMARY_OWNER_USERNAME as a default");
});

test("lib/zoom/extract-meeting.ts: no PRIMARY_OWNER_USERNAME fallback", () => {
  const src = read("lib/zoom/extract-meeting.ts");
  assert.ok(!hasPrimaryOwnerFallback(src),
    "lib/zoom/extract-meeting.ts must not use PRIMARY_OWNER_USERNAME as a default");
});

test("lib/events/drafter.ts: no PRIMARY_OWNER_USERNAME fallback", () => {
  const src = read("lib/events/drafter.ts");
  assert.ok(!hasPrimaryOwnerFallback(src),
    "lib/events/drafter.ts must not use PRIMARY_OWNER_USERNAME as a default");
});

// ── The one permitted use is read-only and annotated ─────────────────────────

test("lib/ai/system-prompt.ts: PRIMARY_OWNER_USERNAME use is ci-ok annotated (read-only hint only)", () => {
  const src = read("lib/ai/system-prompt.ts");
  assert.ok(
    src.includes("PRIMARY_OWNER_USERNAME"),
    "lib/ai/system-prompt.ts must still reference PRIMARY_OWNER_USERNAME for personalization"
  );
  // Every non-comment line referencing it must carry a ci-ok annotation
  for (const line of src.split("\n")) {
    if (!line.includes("PRIMARY_OWNER_USERNAME")) continue;
    if (/^\s*(\/\/|\*)/.test(line)) continue; // pure comment — ok
    assert.ok(
      /\/\/\s*(ci-ok|ci:skip)/.test(line),
      `lib/ai/system-prompt.ts line without ci-ok annotation: "${line.trim()}"`
    );
  }
});

// ── username must be required (not optional) in all input types ───────────────

test("lib/email/classify-email.ts: ClassifyEmailInput.username is required (not optional)", () => {
  const src = read("lib/email/classify-email.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface ClassifyEmailInput \{[^}]*username: string/.test(collapsed),
    "ClassifyEmailInput.username must be a required string, not username?: string"
  );
  assert.ok(
    !/interface ClassifyEmailInput \{[^}]*username\?:/.test(collapsed),
    "ClassifyEmailInput.username must not be optional (username?:)"
  );
});

test("lib/email/materialize-email.ts: MaterializeEmailInput.username is required", () => {
  const src = read("lib/email/materialize-email.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface MaterializeEmailInput \{[^}]*username: string/.test(collapsed),
    "MaterializeEmailInput.username must be a required string"
  );
  assert.ok(
    !/interface MaterializeEmailInput \{[^}]*username\?:/.test(collapsed),
    "MaterializeEmailInput.username must not be optional"
  );
});

test("lib/email/process-gmail-message.ts: ProcessEmailOpts.username is required", () => {
  const src = read("lib/email/process-gmail-message.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface ProcessEmailOpts \{[^}]*username: string/.test(collapsed),
    "ProcessEmailOpts.username must be a required string"
  );
});

test("lib/email/process-gmail-message.ts: ProcessZoomEmailOpts.username is required", () => {
  const src = read("lib/email/process-gmail-message.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface ProcessZoomEmailOpts \{[^}]*username: string/.test(collapsed),
    "ProcessZoomEmailOpts.username must be a required string"
  );
});

test("lib/slack/classify-slack.ts: ClassifySlackInput.username is required", () => {
  const src = read("lib/slack/classify-slack.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface ClassifySlackInput \{[^}]*username: string/.test(collapsed),
    "ClassifySlackInput.username must be a required string"
  );
  assert.ok(
    !/interface ClassifySlackInput \{[^}]*username\?:/.test(collapsed),
    "ClassifySlackInput.username must not be optional"
  );
});

test("lib/slack/materialize-slack.ts: MaterializeSlackInput.username is required", () => {
  const src = read("lib/slack/materialize-slack.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface MaterializeSlackInput \{[^}]*username: string/.test(collapsed),
    "MaterializeSlackInput.username must be a required string"
  );
});

test("lib/teams/materialize-teams.ts: MaterializeTeamsInput.username is required", () => {
  const src = read("lib/teams/materialize-teams.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /interface MaterializeTeamsInput \{[^}]*username: string/.test(collapsed),
    "MaterializeTeamsInput.username must be a required string"
  );
});

// ── Classifiers / materializers have early username guards ────────────────────

test("lib/email/classify-email.ts: has early guard when username is empty", () => {
  const src = read("lib/email/classify-email.ts");
  assert.ok(
    src.includes("!username") && src.includes("[email-classify]"),
    "classifyEmail must return early with an error log when username is empty"
  );
});

test("lib/email/materialize-email.ts: has early guard when username is empty", () => {
  const src = read("lib/email/materialize-email.ts");
  assert.ok(
    src.includes("!username") && src.includes("[email-materialize]"),
    "materializeEmailIntelligence must return early with an error log when username is empty"
  );
});

test("lib/email/process-gmail-message.ts: processRegularEmail has early guard", () => {
  const src = read("lib/email/process-gmail-message.ts");
  assert.ok(
    src.includes("[process-gmail]") && src.includes("!username"),
    "processRegularEmail must log and return early when username is empty"
  );
});

test("lib/email/process-gmail-message.ts: processZoomEmail has early guard", () => {
  const src = read("lib/email/process-gmail-message.ts");
  assert.ok(
    src.includes("[process-zoom-email]"),
    "processZoomEmail must log and return early when username is empty"
  );
});

test("lib/slack/classify-slack.ts: has early guard when username is empty", () => {
  const src = read("lib/slack/classify-slack.ts");
  assert.ok(
    src.includes("!username") && src.includes("[slack-classify]"),
    "classifySlack must return early with an error log when username is empty"
  );
});

test("lib/slack/materialize-slack.ts: has early guard when username is empty", () => {
  const src = read("lib/slack/materialize-slack.ts");
  assert.ok(
    src.includes("!username") && src.includes("[slack-materialize]"),
    "materializeSlackIntelligence must return early when username is empty"
  );
});

test("lib/teams/materialize-teams.ts: has early guard when username is empty", () => {
  const src = read("lib/teams/materialize-teams.ts");
  assert.ok(
    src.includes("!username") && src.includes("[teams-materialize]"),
    "materializeTeamsIntelligence must return early when username is empty"
  );
});

test("lib/zoom/extract-meeting.ts: has early guard when username is empty", () => {
  const src = read("lib/zoom/extract-meeting.ts");
  assert.ok(
    src.includes("!username") && src.includes("[zoom-extract]"),
    "extractZoomMeeting must return early when username is empty"
  );
});

test("lib/events/drafter.ts: generateDraftForEvent has early guard when username is empty", () => {
  const src = read("lib/events/drafter.ts");
  assert.ok(
    src.includes("!username") && src.includes("[drafter]"),
    "generateDraftForEvent must return early with an error log when username is empty"
  );
});

// ── Webhook handlers dead-letter unresolved owners ────────────────────────────

test("app/api/webhooks/gmail/route.ts: dead-letters events with unresolved owner", () => {
  const src = read("app/api/webhooks/gmail/route.ts");
  assert.ok(
    src.includes("writeDeadLetter"),
    "Gmail webhook must write to dead-letter when owner cannot be resolved"
  );
  assert.ok(
    src.includes("resolveGmailUser"),
    "Gmail webhook must resolve owner via resolveGmailUser"
  );
  assert.ok(
    !src.includes("PRIMARY_OWNER_USERNAME"),
    "Gmail webhook must not fall back to PRIMARY_OWNER_USERNAME"
  );
});

test("app/api/webhooks/slack/route.ts: dead-letters events with unresolved owner", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  assert.ok(
    src.includes("writeDeadLetter"),
    "Slack webhook must write to dead-letter when owner cannot be resolved"
  );
  assert.ok(
    src.includes("resolveSlackUser"),
    "Slack webhook must resolve owner via resolveSlackUser"
  );
  assert.ok(
    !src.includes("PRIMARY_OWNER_USERNAME"),
    "Slack webhook must not fall back to PRIMARY_OWNER_USERNAME"
  );
});

test("app/api/webhooks/microsoft/calendar/route.ts: dead-letters unresolved subscription", () => {
  const src = read("app/api/webhooks/microsoft/calendar/route.ts");
  assert.ok(
    src.includes("writeDeadLetter"),
    "Microsoft calendar webhook must dead-letter when subscription owner is unresolved"
  );
  assert.ok(
    src.includes("resolveMicrosoftSubscriptionUser"),
    "Microsoft calendar webhook must resolve owner from subscription ID"
  );
});

// ── Cron jobs resolve a real username or skip ─────────────────────────────────

test("app/api/cron/renew-subscriptions/route.ts: uses getUsers() not PRIMARY_OWNER_USERNAME", () => {
  const src = read("app/api/cron/renew-subscriptions/route.ts");
  assert.ok(
    src.includes("getUsers"),
    "renew-subscriptions cron must iterate real users via getUsers()"
  );
  assert.ok(
    !hasPrimaryOwnerFallback(src),
    "renew-subscriptions cron must not fall back to PRIMARY_OWNER_USERNAME"
  );
});

test("app/api/events/poll-ingest/route.ts: uses getUsers() for cron calls", () => {
  const src = read("app/api/events/poll-ingest/route.ts");
  assert.ok(
    src.includes("getUsers"),
    "poll-ingest must call getUsers() when handling cron-triggered requests"
  );
  assert.ok(
    !hasPrimaryOwnerFallback(src),
    "poll-ingest must not fall back to PRIMARY_OWNER_USERNAME"
  );
});

// ── No user-owned write uses a hardcoded username ─────────────────────────────

test("lib/jobs/executor.ts: accepts username as explicit parameter (no fallback)", () => {
  const src = read("lib/jobs/executor.ts");
  assert.ok(
    !hasPrimaryOwnerFallback(src),
    "lib/jobs/executor.ts must not reference PRIMARY_OWNER_USERNAME"
  );
  // The dispatch function must accept username as an explicit parameter
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /async function dispatch[^(]*\([^)]*username\s*:\s*string/.test(collapsed),
    "executor.ts dispatch must accept username as an explicit typed parameter"
  );
});
