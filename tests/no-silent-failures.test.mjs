/**
 * no-silent-failures.test.mjs — Basil silent-catch detector.
 *
 * Prevents new silent catch blocks from being merged. Silent catches swallow
 * errors completely — the user sees nothing, logs show nothing, and bugs
 * become invisible.
 *
 * Detected patterns
 * ─────────────────
 *   .catch(() => {})          — inline chain, empty body
 *   .catch(() => null)        — inline chain, silently returns null
 *   catch (e|err|error) {}    — block form, empty body (multi-line aware)
 *
 * Escape hatches (per-line annotations)
 * ─────────────────────────────────────
 *   // basil-ci-allow-silent-catch: <reason>   primary annotation for this test
 *   // ci-ok: <reason>                          legacy annotation (ci-guards.mjs)
 *   // fire-and-forget                          intentional background call
 *   // dedup handles                            dedup logic owns the failure path
 *
 * All annotations must include a reason so reviewers understand the intent.
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
const SCAN_ROOTS = ["app", "lib", "components"];

const SELF_REL = relative(ROOT, fileURLToPath(import.meta.url));

function* walkSource(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSource(full);
    else if (CODE_EXTS.has(extname(entry.name))) yield full;
  }
}

function allSourceFiles() {
  const out = [];
  for (const root of SCAN_ROOTS) {
    for (const full of walkSource(join(ROOT, root))) {
      const rel = relative(ROOT, full);
      if (rel !== SELF_REL) out.push({ full, rel });
    }
  }
  return out;
}

// ── Suppression ───────────────────────────────────────────────────────────────

/** True when the line (or nearby annotation) suppresses a silent-catch violation. */
function isSuppressed(line) {
  return (
    /\/\/\s*basil-ci-allow-silent-catch\b/.test(line) ||
    /\/\/\s*ci-ok\b/.test(line) ||
    /\/\/\s*fire-and-forget\b/.test(line) ||
    /\/\/\s*dedup handles\b/.test(line) ||
    /\{\/\*[^*]*\b(ci-ok|basil-ci-allow-silent-catch)\b/.test(line)
  );
}

/** True when the line is purely a comment (JSDoc, line, or block). */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

// ── Detectors ────────────────────────────────────────────────────────────────

/**
 * Patterns that are fully detectable on a single line.
 * Returns a label string if the line matches, otherwise undefined.
 */
const INLINE_PATTERNS = [
  {
    label: ".catch(() => {})  — empty catch swallows error silently",
    re: /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
  },
  {
    label: ".catch(() => null)  — null return hides errors from callers",
    re: /\.catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/,
  },
];

/**
 * Block-form empty catch: `catch (e|err|error) {` where the body contains
 * only whitespace before the closing `}`.
 *
 * Uses a small sliding window so it handles both:
 *   catch (e) {}           ← single line
 *   catch (e) {            ← opening line
 *   }                      ← closing line (body empty)
 */
function detectEmptyBlockCatches(lines) {
  const hits = [];
  const CATCH_OPEN = /\bcatch\s*\(\s*(?:e|err|error)\s*\)\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CATCH_OPEN.test(line)) continue;
    if (isCommentLine(line)) continue;
    if (isSuppressed(line)) continue;

    // Single-line form: catch (e) {}
    if (/\bcatch\s*\(\s*(?:e|err|error)\s*\)\s*\{\s*\}/.test(line)) {
      hits.push({ lineNum: i + 1, text: line.trim() });
      continue;
    }

    // Multi-line form: scan ahead for closing } with nothing in between.
    // We accept up to 4 blank/whitespace-only lines before the closing brace.
    // A non-empty, non-whitespace line means the body has content — not silent.
    let empty = true;
    let closingLine = -1;
    for (let j = i + 1; j <= i + 5 && j < lines.length; j++) {
      const body = lines[j].trim();
      if (body === "") continue;          // blank line inside block — keep looking
      if (body === "}") {
        closingLine = j;
        break;                            // empty body confirmed
      }
      // Any non-empty, non-closing content means the block has real logic.
      empty = false;
      break;
    }

    if (empty && closingLine !== -1) {
      // Check suppression on both the catch line and the closing brace line.
      if (!isSuppressed(lines[closingLine])) {
        hits.push({ lineNum: i + 1, text: line.trim() });
      }
    }
  }
  return hits;
}

// ── Core scanner ──────────────────────────────────────────────────────────────

function scanForSilentCatches() {
  /** @type {Array<{rel: string, lineNum: number, text: string, pattern: string}>} */
  const violations = [];

  for (const { full, rel } of allSourceFiles()) {
    const raw = readFileSync(full, "utf8");
    const lines = raw.split("\n");

    // ── Inline patterns (single-line) ─────────────────────────────────────
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (isSuppressed(line)) continue;

      for (const { re, label } of INLINE_PATTERNS) {
        if (re.test(line)) {
          violations.push({ rel, lineNum: i + 1, text: line.trim(), pattern: label });
        }
      }
    }

    // ── Block-form empty catches ──────────────────────────────────────────
    for (const { lineNum, text } of detectEmptyBlockCatches(lines)) {
      violations.push({
        rel,
        lineNum,
        text,
        pattern: "catch (e|err|error) {}  — empty block, error completely discarded",
      });
    }
  }

  return violations;
}

// ── Test ──────────────────────────────────────────────────────────────────────

test("no silent catch blocks — catch(() => {}), catch(() => null), empty catch (e) {}", () => {
  const violations = scanForSilentCatches();

  if (violations.length === 0) return;

  // Group by pattern for readable output.
  /** @type {Map<string, typeof violations>} */
  const byPattern = new Map();
  for (const v of violations) {
    if (!byPattern.has(v.pattern)) byPattern.set(v.pattern, []);
    byPattern.get(v.pattern).push(v);
  }

  const lines = [
    `\n${violations.length} silent catch block(s) found.\n`,
    `Fix: add error logging, or annotate with a justified comment:`,
    `  .catch((err) => { console.error("[context] failed:", err); return null; })`,
    `  .catch(() => null); // basil-ci-allow-silent-catch: body parsing, null handled below`,
    `  .catch(() => null); // ci-ok: <reason>`,
    "",
  ];

  for (const [pattern, items] of byPattern) {
    lines.push(`Pattern: ${pattern}`);
    for (const { rel, lineNum, text } of items) {
      lines.push(`  ${rel}:${lineNum}`);
      lines.push(`  ${text}`);
    }
    lines.push("");
  }

  assert.fail(lines.join("\n"));
});
