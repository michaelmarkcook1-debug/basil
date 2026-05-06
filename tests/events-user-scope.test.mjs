/**
 * tests/events-user-scope.test.mjs
 *
 * Regression guard: the event store must be fully user-scoped.
 *
 * All tests use static source analysis so they run without TypeScript
 * compilation and without a live server.  They assert the STRUCTURAL
 * properties of the code that enforce user isolation — if anyone removes a
 * username parameter, introduces a global write, or adds a fallback default,
 * a test here fails in CI.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function read(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

// ── store.ts structural checks ───────────────────────────────────────────────

test("store uses readUserStore / writeUserStore (not readStore / writeStore)", () => {
  const src = read("lib/events/store.ts");
  assert.ok(
    src.includes("readUserStore") && src.includes("writeUserStore"),
    "store must use user-scoped storage helpers"
  );
  assert.ok(
    !src.includes('readStore(') && !src.includes('writeStore('),
    "store must NOT use the global readStore / writeStore"
  );
});

test("all exported functions accept username as first parameter", () => {
  const src = read("lib/events/store.ts");

  const exported = [
    "listEvents",
    "listPendingEvents",
    "listActiveEvents",
    "getEvent",
    "createEvent",
    "updateEvent",
    "updateEventStatus",
    "deleteEvent",
    "replaceAll",
    "compactEvents",
    "hasExternalId",
  ];

  for (const fn of exported) {
    // The export declaration may span multiple lines, so we collapse whitespace
    // before matching.  We look for the function declaration followed (after any
    // whitespace) by "username" as the first parameter token.
    const collapsed = src.replace(/\s+/g, " ");
    const pattern = new RegExp(`export (async )?function ${fn}\\( *username`);
    assert.ok(
      pattern.test(collapsed),
      `${fn}() must accept username as first parameter`
    );
  }
});

test("store never writes to sage-events.json without a user subdir", () => {
  const src = read("lib/events/store.ts");
  // writeStore(EVENTS_FILE, ...) would be a global write — must not exist
  assert.ok(
    !src.includes("writeStore(EVENTS_FILE"),
    "store must not call writeStore(EVENTS_FILE, ...) — use writeUserStore"
  );
  assert.ok(
    !src.includes("readStore(EVENTS_FILE"),
    "store must not call readStore(EVENTS_FILE, ...) — use readUserStore"
  );
});

test("lock key is per-user (not a global constant)", () => {
  const src = read("lib/events/store.ts");
  // Per-user lock key must be derived from username — not a bare constant
  assert.ok(
    src.includes("lockKey(username)"),
    "lock key must be derived per-user to avoid cross-user contention"
  );
  assert.ok(
    !src.includes('const LOCK_KEY ='),
    "there must be no global LOCK_KEY constant — use lockKey(username)"
  );
});

// ── Route caller checks ───────────────────────────────────────────────────────

const ROUTES = [
  "app/api/events/route.ts",
  "app/api/events/[id]/route.ts",
  "app/api/events/[id]/draft/route.ts",
  "app/api/events/ingest/route.ts",
  "app/api/events/poll-ingest/route.ts",
  "app/api/events/reprocess/route.ts",
  "app/api/events/seed/route.ts",
  "app/api/events/stream/route.ts",
  "app/api/email/route.ts",
  "app/api/linear/route.ts",
  "app/api/slack/route.ts",
];

for (const route of ROUTES) {
  test(`${route}: every store call passes username`, () => {
    const src = read(route);

    // These store calls must ALL have a username argument — never bare ()
    const calls = [
      "listEvents(",
      "listActiveEvents(",
      "listPendingEvents(",
      "getEvent(",
      "createEvent(",
      "updateEvent(",
      "updateEventStatus(",
      "deleteEvent(",
      "replaceAll(",
      "compactEvents(",
      "hasExternalId(",
    ];

    for (const call of calls) {
      if (!src.includes(call)) continue; // not used in this file — skip
      // Escape special regex chars in the call string (the leading paren)
      const escaped = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Bare no-arg call: await listEvents() — i.e. opening paren immediately closed
      const noArgPattern = new RegExp(`await ${escaped}\\)`);
      assert.ok(
        !noArgPattern.test(src),
        `${route}: ${call}) called without arguments — must pass username`
      );
    }
  });
}

// ── Webhook routes: dead-letter on unresolved user ───────────────────────────

test("gmail webhook writes dead-letter when user cannot be resolved", () => {
  const src = read("app/api/webhooks/gmail/route.ts");
  assert.ok(
    src.includes("writeDeadLetter"),
    "gmail webhook must write dead-letter when webhookUsername is null"
  );
  assert.ok(
    src.includes("unresolved owner") || src.includes("No user found"),
    "gmail webhook must log a reason when owner cannot be resolved"
  );
});

test("slack webhook writes dead-letter when user cannot be resolved", () => {
  const src = read("app/api/webhooks/slack/route.ts");
  assert.ok(
    src.includes("writeDeadLetter"),
    "slack webhook must write dead-letter when webhookUsername is null"
  );
});

test("calendar webhook writes dead-letter when user cannot be resolved", () => {
  const src = read("app/api/webhooks/calendar/route.ts");
  assert.ok(
    src.includes("writeDeadLetter"),
    "calendar webhook must write dead-letter when webhookUsername is null"
  );
});

test("microsoft calendar webhook writes dead-letter when user cannot be resolved", () => {
  const src = read("app/api/webhooks/microsoft/calendar/route.ts");
  assert.ok(
    src.includes("writeDeadLetter"),
    "ms-calendar webhook must write dead-letter when webhookUsername is null"
  );
});

test("microsoft mail webhook writes dead-letter when user cannot be resolved", () => {
  const src = read("app/api/webhooks/microsoft/mail/route.ts");
  assert.ok(
    src.includes("writeDeadLetter"),
    "ms-mail webhook must write dead-letter when webhookUsername is null"
  );
});

// ── No global fallback in store itself ───────────────────────────────────────

test("store has no PRIMARY_OWNER_USERNAME fallback", () => {
  const src = read("lib/events/store.ts");
  assert.ok(
    !src.includes("PRIMARY_OWNER_USERNAME"),
    "event store must never fall back to PRIMARY_OWNER_USERNAME — callers must supply username"
  );
});

test("audit.ts createEvent call passes username", () => {
  const src = read("lib/events/audit.ts");
  assert.ok(
    src.includes("createEvent(input.username,"),
    "audit.ts must pass input.username to createEvent"
  );
});
