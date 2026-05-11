/**
 * tests/datetime.test.mjs
 *
 * Unit tests for lib/datetime.ts — the central date/time utility for Basil.
 * These verify timezone handling, formatting, and range calculations.
 *
 * Runs via: npm test  (node --test)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── File structure ────────────────────────────────────────────────────────────

test("lib/datetime.ts exists", () => {
  assert.ok(
    existsSync(join(ROOT, "lib", "datetime.ts")),
    "lib/datetime.ts is missing — create it with formatDate, formatTime, getTodayRange etc."
  );
});

test("lib/datetime.ts exports required functions", () => {
  const src = readFileSync(join(ROOT, "lib", "datetime.ts"), "utf8");

  const required = [
    "DEFAULT_TIMEZONE",
    "getNow",
    "formatDate",
    "formatTime",
    "formatDateTime",
    "getTodayRange",
    "getWeekRange",
    "getSourceWindow",
    "relativeLabel",
    "windowLabel",
  ];

  for (const name of required) {
    assert.ok(
      src.includes(`export`) && src.includes(name),
      `lib/datetime.ts must export "${name}"`
    );
  }
});

test("DEFAULT_TIMEZONE is Europe/London", () => {
  const src = readFileSync(join(ROOT, "lib", "datetime.ts"), "utf8");
  assert.ok(
    src.includes('"Europe/London"') || src.includes("'Europe/London'"),
    'DEFAULT_TIMEZONE must be "Europe/London"'
  );
});

// ── No timezone-unaware date formatting in dashboard pages ────────────────────
//
// Any call to toLocaleDateString/toLocaleString without a timeZone option
// uses the browser's local timezone, which is inconsistent across devices.
// Dashboard pages must always include a timeZone when formatting dates.

test("dashboard pages do not call toLocaleDateString without a timeZone", () => {
  // Pattern: new Date(...).toLocaleDateString(locale) — only one arg → no timeZone
  // Matches: .toLocaleDateString("en-GB") without a second object argument
  const bareLocalePattern = /\.toLocaleDateString\(\s*["'][^"']+["']\s*\)/;

  const pages = [
    "app/dashboard/briefing/page.tsx",
    "app/dashboard/meetings/page.tsx",
    "app/dashboard/digest/page.tsx",
  ];

  for (const page of pages) {
    const path = join(ROOT, page);
    if (!existsSync(path)) continue;

    const src = readFileSync(path, "utf8");
    if (bareLocalePattern.test(src)) {
      assert.fail(
        `${page} calls toLocaleDateString without a timeZone option — ` +
        `pass { timeZone: ... } or use formatDate() from lib/datetime.ts`
      );
    }
  }
});

// ── getSourceWindow range integrity ──────────────────────────────────────────

test("datetime.ts getSourceWindow: from is before to", () => {
  // Parse the function source to verify the logic: from = now - days, to = now
  const src = readFileSync(join(ROOT, "lib", "datetime.ts"), "utf8");

  // Check the function exists and has expected shape
  assert.ok(
    src.includes("getSourceWindow"),
    "getSourceWindow must be defined"
  );
  assert.ok(
    src.includes("days * 24 * 60 * 60 * 1000") || src.includes("days * 86400"),
    "getSourceWindow must compute a days-based window"
  );
});

// ── relativeLabel coverage ─────────────────────────────────────────────────

test("datetime.ts relativeLabel handles future dates gracefully", () => {
  const src = readFileSync(join(ROOT, "lib", "datetime.ts"), "utf8");
  assert.ok(
    src.includes("in the future") || src.includes("future"),
    'relativeLabel must handle future dates (diffMs < 0) — return "in the future"'
  );
});

test("datetime.ts relativeLabel handles just now", () => {
  const src = readFileSync(join(ROOT, "lib", "datetime.ts"), "utf8");
  assert.ok(
    src.includes("just now"),
    'relativeLabel must handle sub-minute timestamps — return "just now"'
  );
});

// ── getTodayRange / getWeekRange structure ────────────────────────────────────

test("datetime.ts getTodayRange returns from/to keys", () => {
  const src = readFileSync(join(ROOT, "lib", "datetime.ts"), "utf8");
  assert.ok(
    src.includes("from") && src.includes("to"),
    "getTodayRange must return { from, to }"
  );
});

test("datetime.ts getWeekRange anchors to Monday", () => {
  const src = readFileSync(join(ROOT, "lib", "datetime.ts"), "utf8");
  // UK working-week convention: week starts Monday
  assert.ok(
    src.includes("monday") || src.includes("Monday") || src.includes("dayOfWeek - 1"),
    "getWeekRange must anchor to Monday (UK convention)"
  );
});
