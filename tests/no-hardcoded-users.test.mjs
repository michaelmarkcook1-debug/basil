/**
 * no-hardcoded-users.test.mjs — Basil hardcoded-user detector.
 *
 * Prevents runtime code from writing or routing data to a literal username.
 * If a webhook, cron job, or AI tool silently falls back to "michael" or
 * "admin", data goes to the wrong user — or no user at all — with no error.
 *
 * Detected patterns
 * ─────────────────
 *
 * Group A — broad match (any standalone quoted occurrence in runtime code):
 *   "michael" | 'michael'
 *   "demo-user" | "test-user" | "default-user" | "user-1"
 *
 * Group B — tighter match (only when adjacent to an auth/user variable name
 *           or used as an env-var fallback):
 *   "admin" | 'admin' — in username/userId/auth/owner context
 *                        or  process.env.X || "admin"  /  ?? "admin"
 *
 * Group C — identifier match (always, in runtime code):
 *   hardcodedUser  DEFAULT_USER
 *
 * False-positive exclusions
 * ─────────────────────────
 *   • Pure comment lines (JSDoc `*`, `//`, `/*`) — skipped entirely
 *   • ActionCategory "admin" — "admin" as a category/type value is not a username:
 *       category === "admin"   return "admin"   | "admin" |   = "admin"
 *       These are excluded unless the surrounding variable name implies identity.
 *
 * Escape hatches (per-line, must include a reason)
 * ─────────────────────────────────────────────────
 *   // basil-ci-allow-hardcoded-user: <reason>   primary annotation for this test
 *   // ci-ok: <reason>                            legacy annotation (ci-guards.mjs)
 *
 * Runs via: npm test  (node --test)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── File walker ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "coverage", "generated",
]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SCAN_ROOTS = ["app", "lib"];

const SELF_REL = relative(ROOT, fileURLToPath(import.meta.url));

function isTestFile(rel) {
  return /\.(test|spec)\.[jt]sx?$/.test(rel) || /\/__tests__\//.test(rel);
}

function isDocFile(rel) {
  return /\.(md|mdx|txt)$/i.test(rel);
}

function* walkSource(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSource(full);
    else if (CODE_EXTS.has(extname(entry.name))) yield full;
  }
}

function allRuntimeFiles() {
  const out = [];
  for (const root of SCAN_ROOTS) {
    for (const full of walkSource(join(ROOT, root))) {
      const rel = relative(ROOT, full);
      if (rel === SELF_REL) continue;
      if (isTestFile(rel) || isDocFile(rel)) continue;
      out.push({ full, rel });
    }
  }
  return out;
}

// ── Suppression ───────────────────────────────────────────────────────────────

function isSuppressed(line) {
  return (
    /\/\/\s*basil-ci-allow-hardcoded-user\b/.test(line) ||
    /\/\/\s*ci-ok\b/.test(line) ||
    /\{\/\*[^*]*\b(ci-ok|basil-ci-allow-hardcoded-user)\b/.test(line)
  );
}

/** Pure comment line — JSDoc, line comment, or opening block comment. */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

// ── Pattern definitions ───────────────────────────────────────────────────────

// Group A — standalone quoted strings (matching quote characters).
// "michael" or 'michael' — the name must be the entire quoted value.
const GROUP_A_LITERALS = ["michael", "demo-user", "test-user", "default-user", "user-1"];

// Build two regexes: one for double-quoted, one for single-quoted.
// Require matching quotes to avoid false positives like "Michael's note" (mixed quotes).
const _a = GROUP_A_LITERALS.join("|");
// More precise: double-quote form and single-quote form as separate alternations.
const GROUP_A_DOUBLE = new RegExp(`"(${_a})"`, "i");
const GROUP_A_SINGLE = new RegExp(`'(${_a})'`, "i");

function matchesGroupA(line) {
  return GROUP_A_DOUBLE.test(line) || GROUP_A_SINGLE.test(line);
}

// Group B — "admin" only when in a user-identity context.
//
// EXCLUDED (false positives):
//   category === "admin"         — ActionCategory value
//   return "admin"               — returning a category string
//   | "admin" |                  — TypeScript union member
//   : "admin"                    — object property value for non-user properties
//   .includes("admin")           — string search, not user identity
//
// INCLUDED (real violations):
//   username === "admin"         — direct username comparison
//   userId === "admin"           — user ID comparison
//   process.env.X || "admin"     — env-var fallback used as identity
//   process.env.X ?? "admin"     — same
//   adminUser = "admin"          — variable assignment
//   const owner = "admin"        — owner variable

// Patterns that ARE dangerous (admin as user identity):
const ADMIN_IDENTITY_RE = new RegExp(
  // username/userId/user/session/auth/owner/principal variable equality (==, ===, !=, !==)
  `(?:username|user_?id|userId|session\\.user|auth\\.user|owner|principal|adminUser(?:name)?)` +
  `\\s*[!=]==?\\s*["']admin["']` +
  `|` +
  // env-var fallback with double-pipe or null-coalescing — explicitly double-pipe to avoid
  // matching single-pipe union member patterns.
  `process\\.env\\.\\w+\\s*(?:\\|\\||\\?\\?)\\s*["']admin["']` +
  `|` +
  // direct variable assignment: const user = "admin"  /  let username = "admin"
  `(?:const|let|var)\\s+(?:user|username|userId|owner|adminUser)\\s*=\\s*["']admin["']`,
  "i"
);

// Patterns that are NOT dangerous (admin as a category/type value, not a username).
// Must be narrow: never exclude actual auth-context matches.
const ADMIN_CATEGORY_RE = new RegExp(
  // .category === "admin" or { category: "admin" }
  `\\.?\\bcategory\\b\\s*[!=:]=?\\s*["']admin["']` +
  `|` +
  // return "admin"  — returning a category enum string
  `\\breturn\\s+["']admin["']` +
  `|` +
  // TypeScript type union (single pipe only — double pipe is logical OR, not a union):
  //   | "admin" |    | "admin";    | "admin",    "admin" |
  // Negative lookahead/lookbehind ensures we only match single-pipe union separators.
  `(?<!\\|)\\|(?!\\|)\\s*["']admin["']\\s*[|;,]` +
  `|` +
  `["']admin["']\\s*\\|(?!\\|)` +
  `|` +
  // .includes("admin")  — string content search, not identity
  `\\.includes\\(["']admin["']\\)` +
  `|` +
  // regex literal containing admin: /admin/  /\badmin\b/
  `/[^/]*admin[^/]*/`
);

function matchesGroupB(line) {
  // Must match the identity pattern AND not match the category exclusion.
  return ADMIN_IDENTITY_RE.test(line) && !ADMIN_CATEGORY_RE.test(line);
}

// Group C — identifier forms, not string-quoted.
const GROUP_C_RE = /\bhardcodedUser\b|\bDEFAULT_USER\b/;

function matchesGroupC(line) {
  return GROUP_C_RE.test(line);
}

// ── Scanner ───────────────────────────────────────────────────────────────────

/**
 * @returns {Array<{rel: string, lineNum: number, text: string, reason: string}>}
 */
function scanForHardcodedUsers() {
  const violations = [];

  for (const { full, rel } of allRuntimeFiles()) {
    const lines = readFileSync(full, "utf8").split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (isSuppressed(line)) continue;

      if (matchesGroupA(line)) {
        const match = (GROUP_A_DOUBLE.exec(line) ?? GROUP_A_SINGLE.exec(line));
        const literal = match?.[1] ?? match?.[2] ?? "?";
        violations.push({
          rel,
          lineNum: i + 1,
          text: line.trim(),
          reason: `Hardcoded username literal "${literal}" — use process.env.PRIMARY_OWNER_USERNAME or resolve from auth session`,
        });
        continue; // don't double-report the same line
      }

      if (matchesGroupB(line)) {
        violations.push({
          rel,
          lineNum: i + 1,
          text: line.trim(),
          reason: `Hardcoded "admin" username in auth context — use process.env.ADMIN_USERNAME or verify via isAdminUser()`,
        });
        continue;
      }

      if (matchesGroupC(line)) {
        const id = /hardcodedUser/.test(line) ? "hardcodedUser" : "DEFAULT_USER";
        violations.push({
          rel,
          lineNum: i + 1,
          text: line.trim(),
          reason: `Hardcoded user identifier "${id}" found in runtime code`,
        });
      }
    }
  }

  return violations;
}

// ── Test ──────────────────────────────────────────────────────────────────────

test(
  'no hardcoded user identifiers — "michael", "admin" (auth context), "demo-user", DEFAULT_USER, …',
  () => {
    const violations = scanForHardcodedUsers();

    if (violations.length === 0) return;

    const lines = [
      `\n${violations.length} hardcoded user identifier(s) found in runtime code.\n`,
      `Fix: replace with process.env.PRIMARY_OWNER_USERNAME, ADMIN_USERNAME, or`,
      `     resolve the username from the authenticated session (getSessionUser()).`,
      `Suppress legitimate uses with a justified annotation:`,
      `  // basil-ci-allow-hardcoded-user: <reason>`,
      `  // ci-ok: <reason>`,
      "",
    ];

    // Group by file for readable output.
    /** @type {Map<string, typeof violations>} */
    const byFile = new Map();
    for (const v of violations) {
      if (!byFile.has(v.rel)) byFile.set(v.rel, []);
      byFile.get(v.rel).push(v);
    }

    for (const [rel, items] of byFile) {
      lines.push(rel);
      for (const { lineNum, text, reason } of items) {
        lines.push(`  line ${lineNum}: ${text}`);
        lines.push(`  → ${reason}`);
      }
      lines.push("");
    }

    assert.fail(lines.join("\n"));
  }
);
