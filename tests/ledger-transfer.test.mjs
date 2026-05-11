/**
 * Ledger cross-module transfer tests.
 *
 * These are static/import-level tests — they verify that the route files
 * exist and import the correct store functions.  No running server needed.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// ── File existence checks ──────────────────────────────────────────────────────

test("convertLedgerItem exists in lib/ledger/convert.ts", () => {
  const p = resolve(ROOT, "lib/ledger/convert.ts");
  assert.ok(existsSync(p), `Missing: ${p}`);
});

test("/api/ledger/convert route exists", () => {
  const p = resolve(ROOT, "app/api/ledger/convert/route.ts");
  assert.ok(existsSync(p), `Missing: ${p}`);
});

test("/api/signals/convert route exists", () => {
  const p = resolve(ROOT, "app/api/signals/convert/route.ts");
  assert.ok(existsSync(p), `Missing: ${p}`);
});

test("/api/ledger/chat-save route exists", () => {
  const p = resolve(ROOT, "app/api/ledger/chat-save/route.ts");
  assert.ok(existsSync(p), `Missing: ${p}`);
});

// ── Content checks — verify correct store imports ──────────────────────────────

import { readFileSync } from "node:fs";

function readRoute(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

test("convertLedgerItem calls createAction for type=action", () => {
  const src = readRoute("lib/ledger/convert.ts");
  assert.ok(src.includes("createAction"), "convertLedgerItem should import createAction");
  assert.ok(src.includes(`case "action"`), "should handle action case");
});

test("convertLedgerItem calls createDecision for type=decision", () => {
  const src = readRoute("lib/ledger/convert.ts");
  assert.ok(src.includes("createDecision"), "convertLedgerItem should import createDecision");
  assert.ok(src.includes(`case "decision"`), "should handle decision case");
});

test("convertLedgerItem calls createMemory for type=memory", () => {
  const src = readRoute("lib/ledger/convert.ts");
  assert.ok(src.includes("createMemory"), "convertLedgerItem should import createMemory");
  assert.ok(src.includes(`case "memory"`), "should handle memory case");
});

test("/api/signals/convert POST handles action, decision, memory targets", () => {
  const src = readRoute("app/api/signals/convert/route.ts");
  assert.ok(src.includes("createAction"),   "signals/convert should call createAction");
  assert.ok(src.includes("createDecision"), "signals/convert should call createDecision");
  assert.ok(src.includes("createMemory"),   "signals/convert should call createMemory");
  assert.ok(src.includes(`case "action"`),  "should handle action target");
  assert.ok(src.includes(`case "decision"`), "should handle decision target");
  assert.ok(src.includes(`case "memory"`),  "should handle memory target");
});

test("/api/ledger/chat-save POST handles action and memory types", () => {
  const src = readRoute("app/api/ledger/chat-save/route.ts");
  assert.ok(src.includes("createAction"), "chat-save should call createAction");
  assert.ok(src.includes("createMemory"), "chat-save should call createMemory");
  assert.ok(src.includes(`"action"`),    "should handle action type");
  assert.ok(src.includes(`"memory"`),    "should handle memory type");
});

test("action store uses writeUserStore (durable persistence)", () => {
  const src = readRoute("lib/actions/store.ts");
  assert.ok(src.includes("writeUserStore"), "action store must use writeUserStore");
  assert.ok(src.includes("createAction"),   "must export createAction");
  assert.ok(src.includes("listActions"),    "must export listActions");
});

test("decision store uses writeUserStore (durable persistence)", () => {
  const src = readRoute("lib/decisions/store.ts");
  assert.ok(src.includes("writeUserStore"), "decision store must use writeUserStore");
  assert.ok(src.includes("createDecision"), "must export createDecision");
  assert.ok(src.includes("listDecisions"),  "must export listDecisions");
});

test("memory store uses writeUserStore (durable persistence)", () => {
  const src = readRoute("lib/memory/store.ts");
  assert.ok(src.includes("writeUserStore"), "memory store must use writeUserStore");
  assert.ok(src.includes("createMemory"),   "must export createMemory");
  assert.ok(src.includes("listMemories"),   "must export listMemories");
});

test("ledger store uses writeUserStore (durable persistence)", () => {
  const src = readRoute("lib/ledger/store.ts");
  assert.ok(src.includes("writeUserStore"), "ledger store must use writeUserStore");
});
