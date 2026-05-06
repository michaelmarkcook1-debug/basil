#!/usr/bin/env node
/**
 * ci-guards.mjs — CI guardrails for Basil.
 *
 * Hard-fail guards (always exit 1):
 *   1. silent-catch    — catch(() => {}), catch(() => null), catch (e) {}
 *   2. hardcoded-user  — literal username values in runtime code
 *
 * Persistence guards (behaviour depends on CI_STRICT_PERSISTENCE):
 *   3. basil-data      — process.env.BASIL_DATA outside lib/storage/
 *                        warning  when CI_STRICT_PERSISTENCE=false  (default)
 *                        FAILURE  when CI_STRICT_PERSISTENCE=true
 *   4. tmp-durable     — /tmp, DATA_DIR, tmpdir() in route handlers
 *                        warning  when CI_STRICT_PERSISTENCE=false  (default)
 *                        FAILURE  when CI_STRICT_PERSISTENCE=true
 *
 * Informational checks (always exit 0):
 *   5. missing-routes  — key API directories that should exist
 *
 * Escape hatch: annotate a line with  // ci-ok  to suppress any guard.
 * Silent catches: also suppressed by  // fire-and-forget  or  // dedup handles.
 *
 * When to flip the switch
 * ───────────────────────
 * Set CI_STRICT_PERSISTENCE=true in basil-ci.yml once all exit criteria in
 * docs/stability-sprint-exit-criteria.md are met:
 *   • No BASIL_DATA references remain outside lib/storage/
 *   • No route handler writes user data to /tmp without a Blob mirror
 *   • All user data confirmed durable across Vercel cold starts
 *
 * Usage:
 *   npm run ci:guards                           # default (warnings only)
 *   CI_STRICT_PERSISTENCE=true npm run ci:guards # strict (failures)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ── Config ─────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const STRICT = process.env.CI_STRICT_PERSISTENCE === "true";

// Never scan these directory names (at any depth).
const IGNORE_DIRS = new Set([
  "node_modules", ".next", ".git", "coverage", "dist", "build",
  "generated", "__generated__",
]);

// Source roots to walk.
const SCAN_ROOTS = ["app", "components", "lib", "scripts"];

// Source file extensions.
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

// This script's own path relative to ROOT — never scanned.
const SELF_REL = relative(ROOT, fileURLToPath(import.meta.url));

// ── Colour helpers ─────────────────────────────────────────────────────────────

const C = {
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── File collection ────────────────────────────────────────────────────────────

/** Yield all files under absDir, respecting IGNORE_DIRS. */
function* walkDir(absDir) {
  if (!existsSync(absDir)) return;
  for (const entry of readdirSync(absDir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(absDir, entry);
    try {
      const s = statSync(full);
      if (s.isDirectory()) yield* walkDir(full);
      else yield full;
    } catch { /* broken symlink or permission error — skip */ }
  }
}

/** Returns true for test/spec files. */
function isTestFile(rel) {
  return /\.(test|spec)\.[jt]sx?$/.test(rel) || /\/__tests__\//.test(rel);
}

/** Returns true for documentation files. */
function isDocFile(rel) {
  return /\.(md|mdx|txt)$/i.test(rel) || basename(rel, extname(rel)).toUpperCase() === "README";
}

/** Collect all source files from SCAN_ROOTS. */
const ALL_FILES = (() => {
  const out = [];
  for (const dir of SCAN_ROOTS) {
    for (const full of walkDir(join(ROOT, dir))) {
      const rel = relative(ROOT, full);
      if (rel === SELF_REL) continue; // never flag this script
      if (CODE_EXTS.has(extname(full))) {
        out.push({ full, rel, isTest: isTestFile(rel), isDoc: false });
      } else if (isDocFile(full)) {
        out.push({ full, rel, isTest: false, isDoc: true });
      }
    }
  }
  return out;
})();

/** Read a file and return its lines. */
function lines(full) {
  return readFileSync(full, "utf8").split("\n");
}

// ── Line-level predicates ──────────────────────────────────────────────────────

/** True when the content of this line (after the grep-style prefix) is purely a comment. */
function isCommentLine(raw) {
  const t = raw.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** True when the line carries a suppression annotation (JS or JSX comment style). */
function isSuppressed(raw) {
  // JS/TS line comments:  // ci-ok
  if (/\/\/\s*(ci-ok|fire-and-forget|dedup handles|ci:skip)/.test(raw)) return true;
  // JSX block comments:   {/* ci-ok */}
  if (/\{\/\*[^*]*\b(ci-ok|fire-and-forget|dedup handles|ci:skip)\b/.test(raw)) return true;
  return false;
}

// ── Result accumulators ────────────────────────────────────────────────────────

/** @type {Array<{guard:string, rel:string, line:number, text:string}>} */
const FAILURES = [];

/** @type {Array<{guard:string, detail:string}>} */
const WARNINGS = [];

function fail(guard, rel, lineNum, rawLine) {
  FAILURES.push({ guard, rel, line: lineNum, text: rawLine.trim() });
}

function warn(guard, detail) {
  WARNINGS.push({ guard, detail });
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 1 — Silent catch blocks
// ─────────────────────────────────────────────────────────────────────────────
//
// All four patterns produce genuinely lost errors — either the exception is
// completely swallowed or replaced with a silent null without any log entry.
//
// Fix: add a console.error(), or annotate with // ci-ok: <reason>.
//   Bad:  .catch(() => null)
//   Good: .catch((err) => { console.error("[context] failed:", err); return null; })
//   Also good: .catch(() => null); // ci-ok: body parsing, null handled below

const SILENT_CATCH_RE = [
  // Inline chained: .catch(() => {})
  /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
  // Inline chained: .catch(() => null)
  /\.catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/,
  // Block form, single line: catch (e) {} / catch (err) {} / catch (error) {}
  /\bcatch\s*\(\s*(?:e|err|error)\s*\)\s*\{\s*\}/,
];

for (const { full, rel, isTest } of ALL_FILES) {
  if (isTest) continue; // empty catches in test helpers are acceptable
  for (let i = 0, ls = lines(full); i < ls.length; i++) {
    const line = ls[i];
    if (isCommentLine(line)) continue; // JSDoc/inline comments may contain pattern examples
    if (isSuppressed(line)) continue;
    if (SILENT_CATCH_RE.some((re) => re.test(line))) {
      fail("silent-catch", rel, i + 1, line);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 2 — Hardcoded user identifiers
// ─────────────────────────────────────────────────────────────────────────────
//
// Literal username values hard-coded into runtime logic cause single-user
// lock-in and can create security bypasses.
//
// Allowed: tests, documentation, and comment-only lines.
// Suppressed per-line with: // ci-ok
//
// For admin: only flagged in auth/username comparison or fallback contexts
// to avoid false positives with ActionCategory ("admin") and route labels.

// These literals are assembled at runtime so this source file doesn't contain
// bare quoted strings that would trigger the guard on itself.
const USERNAME_LITERALS = [
  ["m","i","c","h","a","e","l"].join(""),
  ["d","e","m","o","-","u","s","e","r"].join(""),
  ["t","e","s","t","-","u","s","e","r"].join(""),
  ["d","e","f","a","u","l","t","-","u","s","e","r"].join(""),
];

// Broad match: the literal appears as a standalone quoted string.
// Requires matching quote characters to avoid false positives like "Michael's…"
// (mixed quotes). "Michael Cook" won't match because the space before "Cook"
// separates it from the closing quote. Template literals (${ }) won't match either.
const _ul = USERNAME_LITERALS.join("|");
const BROAD_USER_RE = new RegExp(
  `"(${_ul})"|'(${_ul})'`,
  "i"
);

// Admin is checked with tighter context — only equality operators and
// fallback/default patterns where the variable name implies auth/user context.
// This prevents false positives from ActionCategory literals and UI strings.
const ADMIN_LITERAL = ["a","d","m","i","n"].join("");
const ADMIN_CONTEXT_RE = new RegExp(
  // Equality: username === "admin"
  `(?:username|userId|user_?id|session|auth|owner|principal|adminUser(?:name)?)` +
  `\\s*[!=]=\\s*["']${ADMIN_LITERAL}["']` +
  // Fallback default: = process.env.X || "admin" or ?? "admin"
  `|` +
  `(?:process\\.env\\.\\w+\\s*(?:\\|\\||\\?\\?)\\s*)["']${ADMIN_LITERAL}["']`,
  "i"
);

for (const { full, rel, isTest, isDoc } of ALL_FILES) {
  if (isTest || isDoc) continue;
  for (let i = 0, ls = lines(full); i < ls.length; i++) {
    const line = ls[i];
    if (isCommentLine(line)) continue;
    if (isSuppressed(line)) continue;

    if (BROAD_USER_RE.test(line)) {
      fail("hardcoded-user", rel, i + 1, line);
      continue;
    }
    if (ADMIN_CONTEXT_RE.test(line)) {
      fail("hardcoded-user", rel, i + 1, line);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 3 — BASIL_DATA env-var persistence
// ─────────────────────────────────────────────────────────────────────────────
//
// BASIL_DATA is the legacy env-var persistence layer, superseded by Vercel Blob.
// lib/storage/ is exempt (it owns the migration path).
// Set CI_STRICT_PERSISTENCE=true to promote this to a hard failure.

const BASIL_DATA_RE = /process\.env\.BASIL_DATA/;

for (const { full, rel } of ALL_FILES) {
  if (rel.startsWith("lib/storage/")) continue; // storage layer owns this
  for (let i = 0, ls = lines(full); i < ls.length; i++) {
    const line = ls[i];
    if (isSuppressed(line)) continue;
    if (!BASIL_DATA_RE.test(line)) continue;

    const detail = `${rel}:${i + 1} — ${line.trim()}`;
    if (STRICT) fail("basil-data", rel, i + 1, line);
    else warn("basil-data", detail);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 4 — Durable /tmp storage
// ─────────────────────────────────────────────────────────────────────────────
//
// /tmp is ephemeral on Vercel — cold starts discard it. Using /tmp for durable
// user data causes silent data loss. lib/storage/ is exempt (it owns the path
// constant and knows it's ephemeral within a function invocation).
// Set CI_STRICT_PERSISTENCE=true to promote this to a hard failure.

const TMP_PATTERNS = [
  // String literal path starting with /tmp
  /["'`]\/tmp\//,
  // os.tmpdir() or bare tmpdir()
  /\bos\.tmpdir\s*\(\s*\)|\btmpdir\s*\(\s*\)/,
  // DATA_DIR in route handlers (app/api routes defining or reading it locally)
  /\bDATA_DIR\b/,
];

for (const { full, rel } of ALL_FILES) {
  // lib/storage/ owns these constants — exempt
  if (rel.startsWith("lib/storage/")) continue;
  // Only warn in route handlers and lib code where durable storage is likely intended
  const isRoute = rel.startsWith("app/api/") || rel.startsWith("lib/");
  if (!isRoute) continue;

  for (let i = 0, ls = lines(full); i < ls.length; i++) {
    const line = ls[i];
    if (isCommentLine(line)) continue;
    if (isSuppressed(line)) continue;
    if (!TMP_PATTERNS.some((re) => re.test(line))) continue;

    const detail = `${rel}:${i + 1} — ${line.trim()}`;
    if (STRICT) fail("tmp-durable", rel, i + 1, line);
    else warn("tmp-durable", detail);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 5 — Plaintext OAuth token storage
// ─────────────────────────────────────────────────────────────────────────────
//
// OAuth/integration tokens must be stored via secure-token-store (encrypted).
// Direct writeUserStore calls with known token filenames are a hard failure.
// Direct readUserStore calls with known token filenames are a hard failure.
//
// Token files that must be written only via secure-token-store:
//   google-tokens.json, microsoft-tokens.json, zoom-tokens.json,
//   slack-config.json, linear-config.json
//
// Exempt: lib/storage/secure-token-store.ts (the store itself migrates them),
//         test files.
//
// Suppress with // ci-ok only if intentional and documented.

const TOKEN_FILE_NAMES = [
  "google-tokens.json",
  "microsoft-tokens.json",
  "zoom-tokens.json",
  "slack-config.json",
  "linear-config.json",
];

// Matches: writeUserStore(anything, "google-tokens.json",  or readUserStore(anything, "google-tokens.json",
const TOKEN_WRITE_RES = TOKEN_FILE_NAMES.map(
  (f) => new RegExp(`(?:write|read)(?:User)?Store\\s*\\([^)]*["']${f.replace(".", "\\.")}["']`)
);

for (const { full, rel, isTest } of ALL_FILES) {
  if (isTest) continue;
  if (rel === "lib/storage/secure-token-store.ts") continue; // exempt: owns migration
  if (rel === "lib/storage/user-store.ts") continue;
  if (rel === "lib/storage/persistent.ts") continue;

  const ls = lines(full);
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (isCommentLine(line)) continue;
    if (isSuppressed(line)) continue;
    if (TOKEN_WRITE_RES.some((re) => re.test(line))) {
      fail("plaintext-token-storage", rel, i + 1, line);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 6 — Token values in API responses
// ─────────────────────────────────────────────────────────────────────────────
//
// Route handler files must not include OAuth token field names in NextResponse.json()
// calls.  We use a heuristic: flag route files that both import a token-holding
// object AND spread it or return its raw token fields in a response.
//
// This is a warning (not a hard failure) because the pattern can have legitimate
// uses (e.g. the settings route returns githubToken intentionally for the UI).
// Use // ci-ok to suppress confirmed-safe cases.

const TOKEN_FIELD_RE = /["'`](?:access_token|refresh_token|id_token)["'`]/;

for (const { full, rel, isTest } of ALL_FILES) {
  if (isTest) continue;
  if (!rel.startsWith("app/api/")) continue; // only route handlers

  const ls = lines(full);
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (isCommentLine(line)) continue;
    if (isSuppressed(line)) continue;
    if (!TOKEN_FIELD_RE.test(line)) continue;

    // Hard failure only if the line also looks like a JSON response field
    const inResponse = /NextResponse\.json|JSON\.stringify|return\s+\{/.test(line);
    if (inResponse) {
      fail("token-in-response", rel, i + 1, line);
    } else {
      warn("token-in-response", `${rel}:${i + 1} — ${line.trim()}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 6a — Auth secrets in API responses
// ─────────────────────────────────────────────────────────────────────────────
//
// Route handlers must never return raw auth-sensitive fields in
// NextResponse.json() calls.  Hard-fail on password/passwordHash fields;
// hard-fail on resetToken fields.  Warn on console.log/error calls that
// mention password or resetToken (potential log leakage).
//
// The `password: _pw` destructuring pattern (stripping the hash) is a false
// positive — the regex `["']password["']\s*:\s*_` is excluded.

const PASSWORD_RESPONSE_RE  = /["'`]password["'`]\s*:(?!\s*_)/;
const RESET_TOKEN_RESPONSE_RE = /["'`](?:resetToken|tokenHash)["'`]\s*:(?!\s*_)/;
const PASSWORD_LOG_RE = /console\.(?:log|error|warn|info)\s*\(.*(?:password|passwordHash|resetToken)/i;

for (const { full, rel, isTest } of ALL_FILES) {
  if (isTest) continue;

  const ls = lines(full);
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (isCommentLine(line)) continue;
    if (isSuppressed(line)) continue;

    // Hard failure: auth hash/token as response field in a route handler
    if (rel.startsWith("app/api/")) {
      if (PASSWORD_RESPONSE_RE.test(line)) {
        const inResponse = /NextResponse\.json|JSON\.stringify|return\s+\{/.test(line);
        if (inResponse) fail("auth-secret-in-response", rel, i + 1, line);
      }
      if (RESET_TOKEN_RESPONSE_RE.test(line)) {
        const inResponse = /NextResponse\.json|JSON\.stringify|return\s+\{/.test(line);
        if (inResponse) fail("auth-secret-in-response", rel, i + 1, line);
      }
    }

    // Warning: password/reset token appearing in a log call (any file)
    if (PASSWORD_LOG_RE.test(line)) {
      warn("auth-secret-in-log", `${rel}:${i + 1} — ${line.trim()}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 6b — Direct auth store writes outside allowed modules
// ─────────────────────────────────────────────────────────────────────────────
//
// users.json and password-reset-tokens.json must only be written through the
// secure-auth-store (which encrypts them).  Direct writeStore calls to these
// files from any other module are a hard failure.

const AUTH_STORE_FILES = ["users.json", "password-reset-tokens.json"];
// Modules that are explicitly allowed to write these files (migration only)
const AUTH_STORE_ALLOWED = new Set([
  "lib/storage/secure-auth-store.ts",
  "lib/users.ts",                // legacy USERS_FILE constant still referenced in comments
  "lib/auth/reset-tokens.ts",    // old file kept as reference during migration
]);

for (const { full, rel, isTest } of ALL_FILES) {
  if (isTest) continue;
  if (AUTH_STORE_ALLOWED.has(rel)) continue;

  const ls = lines(full);
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (isCommentLine(line)) continue;
    if (isSuppressed(line)) continue;

    const hasWrite = /writeStore\s*\(|writeUserStore\s*\(/.test(line);
    if (!hasWrite) continue;

    const hasAuthFile = AUTH_STORE_FILES.some((f) => line.includes(`"${f}"`) || line.includes(`'${f}'`));
    if (hasAuthFile) {
      fail("auth-store-direct-write", rel, i + 1, line);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 6c — PRIMARY_OWNER_USERNAME fallback in runtime ingestion paths
// ─────────────────────────────────────────────────────────────────────────────
//
// process.env.PRIMARY_OWNER_USERNAME must never be used as a fallback for
// user-owned data writes.  Any ingestion, classification, or materialisation
// function that defaults to this env var silently assigns data to the wrong
// user when the actual owner cannot be resolved.
//
// Allowed: lib/ai/system-prompt.ts (read-only AI personalization hint — annotated ci-ok).
// All other uses in runtime code are a hard failure.
//
// Fix: make username a required parameter; dead-letter or reject when absent.
// Suppress with // ci-ok only if the line is provably non-write (e.g. read-only AI prompt context).

const PRIMARY_OWNER_RE = /process\.env\.PRIMARY_OWNER_USERNAME/;

for (const { full, rel, isTest } of ALL_FILES) {
  if (isTest) continue; // test fixtures may reference the env var name
  const ls = lines(full);
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (isCommentLine(line)) continue;
    if (isSuppressed(line)) continue;
    if (PRIMARY_OWNER_RE.test(line)) {
      fail("primary-owner-fallback", rel, i + 1, line);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard 7 — Missing key routes
// ─────────────────────────────────────────────────────────────────────────────
//
// These routes are referenced by clients or health checks. Their absence
// suggests a missing implementation or a directory rename that broke the path.

const KEY_ROUTES = [
  "app/api/contacts/user",
  "app/api/integrations/linear",
  "app/api/whatsapp/status",
  "app/api/whatsapp/import-contacts",
  "app/api/health",
];

for (const route of KEY_ROUTES) {
  if (!existsSync(join(ROOT, route))) {
    warn("missing-route", `Route directory not found: ${route}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

const LABELS = {
  "silent-catch":            "Silent catch block",
  "hardcoded-user":          "Hardcoded user identifier",
  "basil-data":              "BASIL_DATA env-var persistence",
  "tmp-durable":             "Potential durable /tmp or DATA_DIR usage", // ci-ok: label string, not a code reference
  "plaintext-token-storage": "Plaintext OAuth token storage (bypasses encryption)",
  "token-in-response":       "OAuth token field in API response",
  "auth-secret-in-response": "Auth secret (password/resetToken) in API response",
  "auth-secret-in-log":      "Auth secret mentioned in console.log/error",
  "auth-store-direct-write":  "Direct write to auth store file (bypasses encryption)",
  "primary-owner-fallback":   "PRIMARY_OWNER_USERNAME used as default-user fallback",
  "missing-route":            "Missing key route",
};

const HINTS = {
  "silent-catch": [
    "Log the error before suppressing it:",
    "  .catch((err) => { console.error('[context]', err); return null; })",
    "Or annotate intentional fire-and-forget uses:",
    "  .catch(() => null); // ci-ok: <reason>",
  ],
  "hardcoded-user": [
    "Move to an environment variable or user settings lookup:",
    "  process.env.PRIMARY_OWNER_USERNAME",
    "Suppress legitimate uses (tests, UI labels):",
    "  // ci-ok: <reason>",
  ],
  "basil-data": [
    "Replace with Vercel Blob via lib/storage/persistent.ts:",
    "  await writeStore('file.json', data, userSubdir(username));",
    "Or annotate confirmed-ephemeral usage:",
    "  // ci-ok: migration path — reads BASIL_DATA only on first cold start",
    "Enable strict enforcement once all BASIL_DATA usage is removed:",
    "  Set CI_STRICT_PERSISTENCE=true in .github/workflows/basil-ci.yml",
    "  See docs/stability-sprint-exit-criteria.md for full exit criteria.",
  ],
  "tmp-durable": [
    "Use writeStore (Blob-backed) for data that must survive cold starts:",
    "  await writeStore('file.json', data, userSubdir(username), { durability: 'strong' });",
    "Or annotate confirmed cache-only usage:",
    "  // ci-ok: /tmp is intentional L1 cache — Blob is the durable source of truth",
    "Enable strict enforcement once all durable /tmp writes are removed:",
    "  Set CI_STRICT_PERSISTENCE=true in .github/workflows/basil-ci.yml",
    "  See docs/stability-sprint-exit-criteria.md for full exit criteria.",
  ],
  "plaintext-token-storage": [
    "Use secure-token-store for all OAuth/integration token writes:",
    "  import { saveIntegrationToken, getIntegrationToken } from '@/lib/storage/secure-token-store';",
    "  await saveIntegrationToken(username, 'google', tokens);",
    "Direct writeUserStore calls with token file names bypass AES-256-GCM encryption.",
    "Suppress only if the file has been intentionally migrated away from token use:",
    "  // ci-ok: <reason>",
  ],
  "token-in-response": [
    "Never return raw OAuth token fields (access_token, refresh_token, id_token) in API responses.",
    "Return only connection status (connected: boolean, expiresAt, scopes) to clients.",
    "If the token field is needed server-side only, remove it from the JSON response object.",
    "Suppress with // ci-ok if the field name coincidentally appears in a safe context.",
  ],
  "auth-secret-in-response": [
    "Never return password hashes or reset token values in API responses.",
    "Use toSafeUser() from lib/users.ts to strip the password field before returning user data.",
    "Reset tokens must not appear in response objects — return only { ok: true } after consumption.",
    "Suppress with // ci-ok if the pattern is a false positive (e.g. a field named differently).",
  ],
  "auth-secret-in-log": [
    "Never log password hashes, raw passwords, or reset tokens.",
    "If you need to log auth events, log only the username and timestamp.",
    "Suppress with // ci-ok if the pattern match is a false positive.",
  ],
  "auth-store-direct-write": [
    "users.json and password-reset-tokens.json must only be written through secure-auth-store.ts.",
    "All writes are encrypted at rest via AES-256-GCM before reaching blob storage.",
    "Replace direct writeStore('users.json', ...) with writeUserRecords() from secure-auth-store.",
    "Replace direct writeStore('password-reset-tokens.json', ...) with writeResetTokenRecords().",
  ],
  "primary-owner-fallback": [
    "process.env.PRIMARY_OWNER_USERNAME must never be used as a default owner in runtime code.",
    "If username is missing: dead-letter the event, return early, or reject with 400/401.",
    "Make username a required parameter — remove any '= process.env.PRIMARY_OWNER_USERNAME ?? \"\"' defaults.",
    "The only permitted use is read-only AI system-prompt personalization, annotated with // ci-ok.",
  ],
};

process.stdout.write("\n");

// ── Hard failures ──

if (FAILURES.length > 0) {
  // Annotate strict-mode failures so the author knows which env var controls them.
  const hasPersistenceFailure = FAILURES.some(
    (f) => f.guard === "basil-data" || f.guard === "tmp-durable"
  );
  if (hasPersistenceFailure) {
    process.stderr.write(
      C.bold(C.red("CI_STRICT_PERSISTENCE=true — persistence guards are hard failures.\n")) +
      C.dim("  Set CI_STRICT_PERSISTENCE=false to downgrade back to warnings.\n") +
      C.dim("  See docs/stability-sprint-exit-criteria.md for exit criteria.\n\n")
    );
  }

  // Group by guard for readable output.
  const byGuard = Object.groupBy(FAILURES, (f) => f.guard);

  for (const [guard, items] of Object.entries(byGuard)) {
    const label = LABELS[guard] ?? guard;
    const count = items.length;
    process.stderr.write(
      C.bold(C.red(`╳  ${label}  (${count} violation${count !== 1 ? "s" : ""})`)) + "\n"
    );

    for (const { rel, line, text } of items) {
      process.stderr.write(`   ${C.dim(`${rel}:${line}`)}\n`);
      process.stderr.write(`   ${C.cyan(text)}\n`);
    }

    const hints = HINTS[guard];
    if (hints) {
      process.stderr.write("\n");
      for (const h of hints) process.stderr.write(`   ${C.dim(h)}\n`);
    }
    process.stderr.write("\n");
  }
}

// ── Warnings ──
// Note: when CI_STRICT_PERSISTENCE=true, basil-data and tmp-durable violations
// go directly to FAILURES above — they never appear here.

if (WARNINGS.length > 0) {
  // Group by guard.
  const byGuard = Object.groupBy(WARNINGS, (w) => w.guard);

  for (const [guard, items] of Object.entries(byGuard)) {
    const label = LABELS[guard] ?? guard;
    process.stdout.write(C.bold(C.yellow(`⚠  ${label}  (${items.length})`)) + "\n");
    for (const { detail } of items) {
      process.stdout.write(`   ${detail}\n`);
    }
    process.stdout.write("\n");
  }

  const hasPersistenceWarning = WARNINGS.some(
    (w) => w.guard === "basil-data" || w.guard === "tmp-durable"
  );
  if (hasPersistenceWarning) {
    process.stdout.write(
      C.dim(
        "  To make these persistence warnings block merges, set\n" +
        "  CI_STRICT_PERSISTENCE=true in .github/workflows/basil-ci.yml.\n" +
        "  See docs/stability-sprint-exit-criteria.md for when to do this.\n"
      ) + "\n"
    );
  }
}

// ── Summary ──

const totalProblems = FAILURES.length + WARNINGS.length;

if (totalProblems === 0) {
  process.stdout.write(C.bold(C.green("✓  ci:guards — all checks passed.\n")));
  process.exit(0);
}

if (FAILURES.length > 0) {
  process.stderr.write(
    C.bold(C.red(
      `ci:guards — ${FAILURES.length} hard failure${FAILURES.length !== 1 ? "s" : ""}` +
      (WARNINGS.length > 0 ? ` + ${WARNINGS.length} warning${WARNINGS.length !== 1 ? "s" : ""}` : "") +
      `. Fix hard failures before merging.\n`
    ))
  );
  process.exit(1);
}

// Only warnings remain.
process.stdout.write(
  C.bold(C.yellow(
    `ci:guards — ${WARNINGS.length} warning${WARNINGS.length !== 1 ? "s" : ""}. No hard failures.\n`
  ))
);
process.exit(0);
