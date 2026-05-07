/**
 * tests/self-identity.test.mjs
 *
 * Regression guard: self-identity must be user-scoped.
 *
 * Rules enforced:
 *   – No hardcoded personal email in runtime lib/ or app/ code
 *   – No hardcoded personal name constant in runtime code
 *   – getSelfIdentity() is exported and requires a username parameter
 *   – isSelf() and stripSelf() accept a SelfIdentity argument (not global constants)
 *   – No SELF_EMAILS or SELF_NAMES constants in lib/self-identity.ts
 *   – All callers pass getSelfIdentity(username) before using isSelf/stripSelf
 *   – lib/google/calendar.ts does not call isSelf/stripSelf without identity
 *   – No data-write path uses hardcoded self identity
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

// ── No hardcoded personal email in runtime code ───────────────────────────────

const RUNTIME_FILES = [
  "lib/self-identity.ts",
  "lib/google/calendar.ts",
  "lib/email/process-gmail-message.ts",
  "app/api/contacts/suggest/route.ts",
  "app/api/generate/meeting-prep/route.ts",
  "app/api/events/poll-ingest/route.ts",
];

for (const file of RUNTIME_FILES) {
  test(`${file}: no hardcoded michael@talentgenius.io`, () => {
    const src = read(file);
    // Allowed in pure comment lines (// or * comment blocks)
    const badLines = src.split("\n").filter((line) => {
      if (/^\s*(\/\/|\*)/.test(line.trimStart())) return false; // pure comment
      if (/\/\/\s*(ci-ok|ci:skip)/.test(line)) return false;   // suppressed
      return line.includes("michael@talentgenius.io");
    });
    assert.deepEqual(
      badLines,
      [],
      `${file} must not contain hardcoded personal email. Found:\n${badLines.join("\n")}`
    );
  });
}

// ── lib/self-identity.ts: user-scoped design ──────────────────────────────────

test("lib/self-identity.ts: exports getSelfIdentity function", () => {
  const src = read("lib/self-identity.ts");
  assert.ok(
    src.includes("export async function getSelfIdentity"),
    "lib/self-identity.ts must export getSelfIdentity"
  );
});

test("lib/self-identity.ts: getSelfIdentity accepts username parameter", () => {
  const src = read("lib/self-identity.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /getSelfIdentity\s*\(\s*username\s*:\s*string\s*\)/.test(collapsed),
    "getSelfIdentity must accept username: string as its parameter"
  );
});

test("lib/self-identity.ts: exports SelfIdentity interface", () => {
  const src = read("lib/self-identity.ts");
  assert.ok(
    src.includes("export interface SelfIdentity"),
    "lib/self-identity.ts must export SelfIdentity interface"
  );
});

test("lib/self-identity.ts: isSelf accepts identity parameter (not global constants)", () => {
  const src = read("lib/self-identity.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /function isSelf\s*\([^)]*SelfIdentity/.test(collapsed),
    "isSelf must accept a SelfIdentity argument, not use global constants"
  );
});

test("lib/self-identity.ts: stripSelf accepts identity parameter (not global constants)", () => {
  const src = read("lib/self-identity.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /function stripSelf\s*\([^)]*SelfIdentity/.test(collapsed),
    "stripSelf must accept a SelfIdentity argument, not use global constants"
  );
});

test("lib/self-identity.ts: no SELF_EMAILS or SELF_NAMES hardcoded constants", () => {
  const src = read("lib/self-identity.ts");
  assert.ok(
    !src.includes("SELF_EMAILS"),
    "lib/self-identity.ts must not export SELF_EMAILS constant"
  );
  assert.ok(
    !src.includes("SELF_NAMES"),
    "lib/self-identity.ts must not export SELF_NAMES constant"
  );
});

test("lib/self-identity.ts: resolves identity from user record (findByUsername)", () => {
  const src = read("lib/self-identity.ts");
  assert.ok(
    src.includes("findByUsername"),
    "getSelfIdentity must resolve identity from the user record via findByUsername"
  );
});

test("lib/self-identity.ts: returns empty identity on missing username (safe fallback)", () => {
  const src = read("lib/self-identity.ts");
  assert.ok(
    src.includes("if (!username) return { emails: [], names: [] }"),
    "getSelfIdentity must return an empty identity when username is falsy"
  );
});

// ── Callers: getSelfIdentity used before isSelf/stripSelf ────────────────────

test("app/api/contacts/suggest/route.ts: imports getSelfIdentity", () => {
  const src = read("app/api/contacts/suggest/route.ts");
  assert.ok(
    src.includes("getSelfIdentity"),
    "suggest route must import getSelfIdentity from lib/self-identity"
  );
});

test("app/api/contacts/suggest/route.ts: calls isSelf with identity argument", () => {
  const src = read("app/api/contacts/suggest/route.ts");
  assert.ok(
    src.includes("isSelf(name, identity)") || src.includes("isSelf(m.author, identity)"),
    "suggest route must call isSelf(identifier, identity) — not isSelf(identifier)"
  );
});

test("app/api/generate/meeting-prep/route.ts: imports getSelfIdentity", () => {
  const src = read("app/api/generate/meeting-prep/route.ts");
  assert.ok(
    src.includes("getSelfIdentity"),
    "meeting-prep route must import getSelfIdentity"
  );
});

test("app/api/generate/meeting-prep/route.ts: calls stripSelf with identity argument", () => {
  const src = read("app/api/generate/meeting-prep/route.ts");
  // stripSelf(list, identity) — second argument required
  assert.ok(
    /stripSelf\([^,]+,\s*\w+Identity\b/.test(src) ||
    /stripSelf\([^)]+selfIdentity/.test(src),
    "meeting-prep route must call stripSelf(list, identity) — not stripSelf(list)"
  );
});

test("app/api/events/poll-ingest/route.ts: imports getSelfIdentity", () => {
  const src = read("app/api/events/poll-ingest/route.ts");
  assert.ok(
    src.includes("getSelfIdentity"),
    "poll-ingest route must import getSelfIdentity"
  );
});

test("app/api/events/poll-ingest/route.ts: calls isSelf with identity argument", () => {
  const src = read("app/api/events/poll-ingest/route.ts");
  // All three isSelf calls must pass an identity
  const matches = [...src.matchAll(/isSelf\(([^)]+)\)/g)].map((m) => m[0]);
  assert.ok(
    matches.length > 0,
    "poll-ingest must call isSelf at least once"
  );
  for (const call of matches) {
    assert.ok(
      call.includes(","),
      `isSelf call in poll-ingest must pass identity: ${call}`
    );
  }
});

test("lib/email/process-gmail-message.ts: imports getSelfIdentity", () => {
  const src = read("lib/email/process-gmail-message.ts");
  assert.ok(
    src.includes("getSelfIdentity"),
    "process-gmail-message must import getSelfIdentity"
  );
});

test("lib/email/process-gmail-message.ts: calls isSelf with identity argument", () => {
  const src = read("lib/email/process-gmail-message.ts");
  assert.ok(
    /isSelf\([^,]+,\s*\w+Identity\b/.test(src) ||
    /isSelf\([^)]+selfIdentity/.test(src),
    "process-gmail-message must call isSelf(identifier, identity) — not isSelf(identifier)"
  );
});

test("lib/google/calendar.ts: imports getSelfIdentity", () => {
  const src = read("lib/google/calendar.ts");
  assert.ok(
    src.includes("getSelfIdentity"),
    "lib/google/calendar.ts must import getSelfIdentity and pass identity to mapEvent"
  );
});

test("lib/google/calendar.ts: mapEvent accepts SelfIdentity parameter", () => {
  const src = read("lib/google/calendar.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /function mapEvent\s*\([^)]*SelfIdentity/.test(collapsed),
    "mapEvent must accept a SelfIdentity parameter — not use global constants"
  );
});

test("lib/google/calendar.ts: stripSelf called with identity argument", () => {
  const src = read("lib/google/calendar.ts");
  assert.ok(
    /stripSelf\([^,]+,\s*identity\b/.test(src),
    "lib/google/calendar.ts must call stripSelf(list, identity) — not stripSelf(list)"
  );
});

// ── No remaining global isSelf/stripSelf calls without identity ──────────────

test("no runtime file calls isSelf without identity argument", () => {
  for (const file of RUNTIME_FILES) {
    const src = read(file);
    // Match isSelf(something) with no second argument — single-arg calls
    const singleArgCalls = [...src.matchAll(/\bisSelf\(([^)]+)\)/g)]
      .filter((m) => !m[1].includes(","));
    assert.deepEqual(
      singleArgCalls.map((m) => m[0]),
      [],
      `${file} must not call isSelf without a SelfIdentity argument. Found: ${singleArgCalls.map((m) => m[0]).join(", ")}`
    );
  }
});

test("no runtime file calls stripSelf without identity argument", () => {
  for (const file of RUNTIME_FILES) {
    const src = read(file);
    const singleArgCalls = [...src.matchAll(/\bstripSelf\(([^)]+)\)/g)]
      .filter((m) => !m[1].includes(","));
    assert.deepEqual(
      singleArgCalls.map((m) => m[0]),
      [],
      `${file} must not call stripSelf without a SelfIdentity argument. Found: ${singleArgCalls.map((m) => m[0]).join(", ")}`
    );
  }
});
