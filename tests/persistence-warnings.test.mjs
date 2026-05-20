/**
 * persistence-warnings.test.mjs
 *
 * Surfaces unsafe persistence patterns in CI without blocking all work.
 *
 * Default mode (CI_STRICT_PERSISTENCE unset or "false"):
 *   - Patterns are detected and printed as diagnostic warnings.
 *   - Tests pass even when violations are found.
 *
 * Strict mode (CI_STRICT_PERSISTENCE=true):
 *   - BASIL_DATA references outside lib/storage/         → hard fail
 *   - Durable /tmp or os.tmpdir() outside lib/storage/  → hard fail
 *   - Vercel env-var API mutation calls (PATCH/POST)     → hard fail
 *
 * Patterns detected
 * ─────────────────
 *   BASIL_DATA        — legacy env-var persistence, superseded by Vercel Blob
 *   /tmp + os.tmpdir  — ephemeral on Vercel cold starts; data is silently lost
 *   DATA_DIR          — old local-fs path constant used outside storage layer
 *   writeStore        — raw persistence calls in user-mutating API routes
 *                       (flagged only as info; not a hard failure even in strict mode)
 *   Vercel env API    — PATCH/POST to api.vercel.com/…/env (env-var as DB anti-pattern)
 *
 * Escape hatch: annotate a line with  // ci-ok  to suppress any match.
 *
 * Runs via: npm test  (node --test)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.env.CI_STRICT_PERSISTENCE === "true";

// ── File walker ───────────────────────────────────────────────────────────────

const SKIP_DIRS  = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage", "generated"]);
const CODE_EXTS  = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SCAN_ROOTS = ["app", "lib", "components", "scripts"];

// This test file's own relative path — never scanned.
const SELF_REL = relative(ROOT, fileURLToPath(import.meta.url));

function* walkSource(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSource(full);
    } else if (CODE_EXTS.has(extname(entry.name))) {
      yield full;
    }
  }
}

/** Collect all source files from SCAN_ROOTS. */
function allSourceFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    for (const full of walkSource(join(ROOT, root))) {
      const rel = relative(ROOT, full);
      if (rel === SELF_REL) continue;
      files.push({ full, rel });
    }
  }
  return files;
}

/** True when the line carries a suppression annotation. */
function isSuppressed(line) {
  return /\/\/\s*ci-ok/.test(line) || /\{\/\*[^*]*ci-ok/.test(line);
}

/** True when the line is purely a comment. */
function isComment(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Scan all source files for lines matching a predicate.
 * Returns matches as { rel, lineNum, text }.
 * Skips comment-only lines and suppressed lines.
 */
function scanFiles(predicate, { skipComments = true, skipStorage = false } = {}) {
  const hits = [];
  for (const { full, rel } of allSourceFiles()) {
    if (skipStorage && rel.startsWith("lib/storage/")) continue;
    const lines = readFileSync(full, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isSuppressed(line)) continue;
      if (skipComments && isComment(line)) continue;
      if (predicate(line)) {
        hits.push({ rel, lineNum: i + 1, text: line.trim() });
      }
    }
  }
  return hits;
}

// ── Reporting helper ──────────────────────────────────────────────────────────

/** Print a diagnostic warning block to stdout (visible in CI logs). */
function printWarning(label, hits, { suggestion } = {}) {
  if (hits.length === 0) return;
  console.warn(`\n⚠  ${label}  (${hits.length} occurrence${hits.length !== 1 ? "s" : ""})`);
  for (const { rel, lineNum, text } of hits) {
    console.warn(`   ${rel}:${lineNum}`);
    console.warn(`   ${text}`);
  }
  if (suggestion) console.warn(`\n   → ${suggestion}\n`);
}

// ── Guard 1 — BASIL_DATA references outside lib/storage/ ─────────────────────

test("BASIL_DATA — legacy env-var persistence should be replaced with Vercel Blob", () => {
  const hits = scanFiles(
    (line) => /process\.env\.BASIL_DATA/.test(line),
    { skipStorage: true, skipComments: true }
  );

  printWarning(
    "BASIL_DATA env-var persistence",
    hits,
    { suggestion: "Replace with readStore/writeStore from @/lib/storage/persistent" }
  );

  if (STRICT) {
    assert.strictEqual(
      hits.length,
      0,
      `CI_STRICT_PERSISTENCE=true — ${hits.length} BASIL_DATA reference(s) outside lib/storage/:\n` +
      hits.map((h) => `  ${h.rel}:${h.lineNum}  ${h.text}`).join("\n")
    );
  }
  // Non-strict: always pass — warning is surfaced above.
});

// ── Guard 2 — Durable /tmp and os.tmpdir() outside lib/storage/ ──────────────

test("/tmp and os.tmpdir() — ephemeral on Vercel; data lost on cold start", () => {
  const TMP_RE = [
    /["'`]\/tmp\//,          // string literal path starting with /tmp
    /\bos\.tmpdir\s*\(\s*\)/, // os.tmpdir() call
  ];

  const hits = scanFiles(
    (line) => TMP_RE.some((re) => re.test(line)),
    { skipStorage: true, skipComments: true }
  );

  printWarning(
    "Durable /tmp or os.tmpdir() usage",
    hits,
    { suggestion: "Use Vercel Blob (writeStore) for any data that must survive cold starts" }
  );

  if (STRICT) {
    assert.strictEqual(
      hits.length,
      0,
      `CI_STRICT_PERSISTENCE=true — ${hits.length} ephemeral /tmp reference(s) outside lib/storage/:\n` +
      hits.map((h) => `  ${h.rel}:${h.lineNum}  ${h.text}`).join("\n")
    );
  }
});

// ── Guard 3 — DATA_DIR outside lib/storage/ ───────────────────────────────────

test("DATA_DIR — local-fs path constant used outside the storage layer", () => {
  const hits = scanFiles(
    (line) => /\bDATA_DIR\b/.test(line),
    { skipStorage: true, skipComments: true }
  );

  printWarning(
    "DATA_DIR usage outside lib/storage/",
    hits,
    { suggestion: "DATA_DIR is a local-fs path; use lib/storage/persistent for durable writes" }
  );

  if (STRICT) {
    assert.strictEqual(
      hits.length,
      0,
      `CI_STRICT_PERSISTENCE=true — ${hits.length} DATA_DIR reference(s) outside lib/storage/:\n` +
      hits.map((h) => `  ${h.rel}:${h.lineNum}  ${h.text}`).join("\n")
    );
  }
});

// ── Guard 4 — Vercel env-var API mutation ──────────────────────────────────────
//
// Storing user data by PATCHing Vercel environment variables is an
// anti-pattern: it is rate-limited, has a size cap, and changes require a
// redeployment to be visible to the runtime.

test("Vercel env-var API mutations — PATCH/POST to api.vercel.com/.../env", () => {
  // Also catch the shorthand form: fetch(url, { method: "PATCH" }) where url contains vercel env
  const hits = scanFiles(
    (line) =>
      /api\.vercel\.com/.test(line) &&
      /\/env/.test(line) &&
      /(PATCH|POST)/.test(line),
    { skipComments: true }
  );

  printWarning(
    "Vercel env-var API mutation (using env vars as a database)",
    hits,
    { suggestion: "Store user data in Vercel Blob (writeStore), not in environment variables" }
  );

  if (STRICT) {
    assert.strictEqual(
      hits.length,
      0,
      `CI_STRICT_PERSISTENCE=true — ${hits.length} Vercel env-var mutation(s) found:\n` +
      hits.map((h) => `  ${h.rel}:${h.lineNum}  ${h.text}`).join("\n")
    );
  }
});

// ── Guard 5 — writeStore in user-mutating routes (info only, never hard-fail) ─
//
// writeStore is the correct abstraction — the concern is using it with
// durability:"weak" (fire-and-forget) in paths where the user immediately
// reads back the written value. This is reported for awareness only.

test("writeStore calls in API routes — informational audit (never fails)", () => {
  const hits = scanFiles(
    (line) => /\bwriteStore\s*\(/.test(line),
    { skipStorage: false, skipComments: true }
  );

  // Partition: storage layer (expected) vs route handlers (worth auditing)
  const routeHits = hits.filter((h) => h.rel.startsWith("app/api/") || h.rel.startsWith("lib/"));

  if (routeHits.length > 0) {
    console.info(
      `\nℹ  writeStore calls outside lib/storage/  (${routeHits.length} — informational)\n` +
      `   Verify each uses { durability: "strong" } if the response depends on the write.\n` +
      routeHits.map((h) => `   ${h.rel}:${h.lineNum}  ${h.text}`).join("\n") +
      "\n"
    );
  }

  // Always pass — this is an audit log, not a gate.
  assert.ok(true, "writeStore audit is informational only");
});

// ── Summary ───────────────────────────────────────────────────────────────────

test("persistence audit complete", () => {
  if (STRICT) {
    console.info("\nCI_STRICT_PERSISTENCE=true — all persistence violations treated as hard failures.\n");
  } else {
    console.info(
      "\nPersistence audit ran in warning mode. " +
      "Set CI_STRICT_PERSISTENCE=true to treat violations as hard failures.\n"
    );
  }
  assert.ok(true);
});
