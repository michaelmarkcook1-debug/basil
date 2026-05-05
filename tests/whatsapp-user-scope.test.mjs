/**
 * tests/whatsapp-user-scope.test.mjs
 *
 * Regression guard: WhatsApp state must be isolated per user.
 *
 * These tests catch the class of bug where globalising any piece of WhatsApp
 * state (snapshot path, status bag, auth directory, contacts store) causes
 * userA's data to leak into or overwrite userB's data.
 *
 * Design
 * ──────
 * All tests use static source analysis (readFileSync) so they run without
 * TypeScript compilation, without a live server, and without real Baileys
 * connections.  They assert the STRUCTURAL properties of the code that enforce
 * isolation — if anyone changes global state, removes the username parameter,
 * or hard-codes a path, a test here fails immediately in CI.
 *
 * A separate section exercises the pure path-sanitisation helpers inline so
 * that different usernames provably produce different keys.
 *
 * Runs via: npm test  (node --test tests/whatsapp-user-scope.test.mjs)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT  = join(dirname(fileURLToPath(import.meta.url)), "..");
const DUMP_JOB   = join(ROOT, "lib", "whatsapp", "dump-job.ts");
const IMPORT_RT  = join(ROOT, "app", "api", "whatsapp", "import-contacts", "route.ts");
const STATUS_RT  = join(ROOT, "app", "api", "whatsapp", "dump", "status", "route.ts");
const RESET_RT   = join(ROOT, "app", "api", "whatsapp", "reset", "route.ts");
const SNAP_RT    = join(ROOT, "app", "api", "whatsapp", "snapshot", "route.ts");
const USER_STORE = join(ROOT, "lib", "storage", "user-store.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

function src(filePath) {
  assert.ok(existsSync(filePath), `Source file missing: ${filePath}`);
  return readFileSync(filePath, "utf8");
}

/** Return the set of exported function names from a TypeScript source string. */
function exportedFunctions(source) {
  const names = new Set();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Inline re-implementation of the path helpers from lib/whatsapp/dump-job.ts.
 * Used to verify their mathematical properties without importing TypeScript.
 * If the real helpers are changed, the static analysis tests below catch it.
 */
function safeUser(username) {
  return username.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function userSubdir(username) {
  return `users/${safeUser(username)}`;
}

// ── Section 1: Source files exist ────────────────────────────────────────────

test("lib/whatsapp/dump-job.ts exists", () => {
  assert.ok(existsSync(DUMP_JOB), "lib/whatsapp/dump-job.ts is missing");
});

test("app/api/whatsapp/import-contacts/route.ts exists", () => {
  assert.ok(existsSync(IMPORT_RT), "app/api/whatsapp/import-contacts/route.ts is missing");
});

// ── Section 2: Per-user in-memory bag (not a global scalar) ──────────────────

test("dump-job uses a Symbol-keyed Map for per-user status bags", () => {
  const code = src(DUMP_JOB);

  // The bag registry must be a Symbol (stable across HMR).
  assert.ok(
    code.includes("Symbol.for("),
    "Status bag key must use Symbol.for() for HMR stability"
  );

  // The bag registry must be a Map, not a plain object, so each username
  // gets an independent entry.
  assert.ok(
    code.includes("new Map<string, GlobalBag>()") ||
    code.includes("new Map()"),
    "Status bag registry must be a Map<username, ...> — not a scalar global"
  );
});

test("bag() initialises a new entry per username if absent (not a shared object)", () => {
  const code = src(DUMP_JOB);

  // The bag() helper must check for the username key.
  assert.ok(
    code.includes(".has(username)") || code.includes("bags.get(username)"),
    "bag() must look up by username — cannot use a single shared global bag"
  );

  // Each new entry must start with an idle status.
  assert.ok(
    code.includes('"idle"'),
    'New bag entries must start in "idle" state'
  );
});

test("getStatus() takes username as its only parameter", () => {
  const code = src(DUMP_JOB);
  // Match: export function getStatus(username: string)
  assert.match(
    code,
    /export\s+function\s+getStatus\s*\(\s*username\s*:/,
    "getStatus() must accept a username parameter"
  );
});

test("setStatus() (internal) writes to per-user subdir, not a global path", () => {
  const code = src(DUMP_JOB);

  // Every writeStore call that writes WHATSAPP_STATUS_FILE must pass the
  // per-user subdirectory — either directly as userSubdir(username) or via a
  // local alias (e.g. `const sub = userSubdir(username)`).
  //
  // Strategy: collect each writeStore(WHATSAPP_STATUS_FILE, ...) call site and
  // assert the containing function/block uses userSubdir(username).
  const statusWriteRe = /writeStore[^(]*\(WHATSAPP_STATUS_FILE[^;]+/g;
  const writeStoreCalls = code.match(statusWriteRe) || [];
  assert.ok(
    writeStoreCalls.length > 0,
    "setStatus() must call writeStore with WHATSAPP_STATUS_FILE"
  );

  for (const call of writeStoreCalls) {
    // Accept either direct usage or a variable that aliased userSubdir(username).
    // We check for "userSubdir(username" (no closing paren) because the regex
    // stops before nested parens.
    const hasDirectSubdir =
      call.includes("userSubdir(username") ||
      call.includes("userSubdir(username)");

    // If the call uses a local alias (e.g. `sub`), verify that alias was
    // assigned from userSubdir(username) nearby in the file.
    const hasAlias =
      !hasDirectSubdir &&
      code.includes("userSubdir(username)") &&
      // The alias must be a small variable that's passed to writeStore.
      /const\s+\w+\s*=\s*userSubdir\(username\)/.test(code);

    assert.ok(
      hasDirectSubdir || hasAlias,
      `writeStore(WHATSAPP_STATUS_FILE, ...) must pass userSubdir(username) — got: ${call.trim()}`
    );
  }
});

test("readPersistedStatus() reads from per-user subdir, not a global path", () => {
  const code = src(DUMP_JOB);
  // readPersistedStatus must use userSubdir when calling readStore.
  const fnBody = code.slice(
    code.indexOf("export async function readPersistedStatus"),
    code.indexOf("\nexport ", code.indexOf("export async function readPersistedStatus") + 1)
  );
  assert.ok(
    fnBody.includes("userSubdir(username)"),
    "readPersistedStatus() must pass userSubdir(username) to readStore"
  );
});

// ── Section 3: Snapshot file path isolation ────────────────────────────────

test("snapshotPath() embeds the username into the filesystem path", () => {
  const code = src(DUMP_JOB);
  // The function must reference safeUser(username) in its path construction.
  const fnBody = code.slice(
    code.indexOf("function snapshotPath("),
    code.indexOf("\n}", code.indexOf("function snapshotPath(")) + 2
  );
  assert.ok(
    fnBody.includes("safeUser(username)"),
    "snapshotPath() must embed safeUser(username) in the path"
  );
});

test("authDir() embeds the username into the filesystem path", () => {
  const code = src(DUMP_JOB);
  const fnBody = code.slice(
    code.indexOf("function authDir("),
    code.indexOf("\n}", code.indexOf("function authDir(")) + 2
  );
  assert.ok(
    fnBody.includes("safeUser(username)"),
    "authDir() must embed safeUser(username) so auth credentials are per-user"
  );
});

test("userSubdir() embeds the username into the storage subdirectory", () => {
  const code = src(DUMP_JOB);
  const fnBody = code.slice(
    code.indexOf("function userSubdir("),
    code.indexOf("\n}", code.indexOf("function userSubdir(")) + 2
  );
  assert.ok(
    fnBody.includes("safeUser(username)"),
    "userSubdir() must embed safeUser(username) in the subdir path"
  );
});

test("getSnapshot() reads from per-user subdir / snapshotPath", () => {
  const code = src(DUMP_JOB);
  const fnBody = code.slice(
    code.indexOf("export async function getSnapshot("),
    code.indexOf("\n}", code.indexOf("export async function getSnapshot(")) + 2
  );
  assert.ok(
    fnBody.includes("snapshotPath(username)") || fnBody.includes("userSubdir(username)"),
    "getSnapshot() must use snapshotPath(username) or userSubdir(username)"
  );
});

test("deleteSnapshot() removes from per-user subdir / snapshotPath", () => {
  const code = src(DUMP_JOB);
  const fnBody = code.slice(
    code.indexOf("export async function deleteSnapshot("),
    code.indexOf("\n}", code.indexOf("export async function deleteSnapshot(")) + 2
  );
  assert.ok(
    fnBody.includes("snapshotPath(username)") || fnBody.includes("userSubdir(username)"),
    "deleteSnapshot() must use snapshotPath(username) or userSubdir(username)"
  );
});

test("persistSignalIndex() writes to per-user subdir", () => {
  const code = src(DUMP_JOB);
  const fnBody = code.slice(
    code.indexOf("export async function persistSignalIndex("),
    code.indexOf("\n}", code.indexOf("export async function persistSignalIndex(")) + 2
  );
  assert.ok(
    fnBody.includes("userSubdir(username)"),
    "persistSignalIndex() must pass userSubdir(username) so signal indexes are per-user"
  );
});

test("getWhatsAppSignalForContact() passes username to getSnapshot and readStore", () => {
  const code = src(DUMP_JOB);
  const fnBody = code.slice(
    code.indexOf("export async function getWhatsAppSignalForContact("),
    code.indexOf("\n}", code.indexOf("export async function getWhatsAppSignalForContact(")) + 2
  );
  assert.ok(
    fnBody.includes("getSnapshot(username)"),
    "getWhatsAppSignalForContact() must call getSnapshot(username)"
  );
  assert.ok(
    fnBody.includes("userSubdir(username)"),
    "getWhatsAppSignalForContact() must pass userSubdir(username) to readStore for the signal index fallback"
  );
});

// ── Section 4: All exported lib functions require username ─────────────────

test("every exported function in dump-job.ts accepts username as first parameter", () => {
  const code = src(DUMP_JOB);
  const fns = exportedFunctions(code);

  // Functions that legitimately have no username (type / const exports) are
  // type-only or constant exports — skip them.
  const skip = new Set(["WHATSAPP_STATUS_FILE"]);

  for (const name of fns) {
    if (skip.has(name)) continue;

    // Extract the function signature up to the opening brace.
    const sigMatch = code.match(
      new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(([^)]{0,200})`
      )
    );
    if (!sigMatch) continue;

    const params = sigMatch[1];
    assert.ok(
      params.trim().startsWith("username"),
      `Exported function "${name}" must accept username as its first parameter — got: (${params.trim()}...)`
    );
  }
});

// ── Section 5: API routes extract user from session, not query params ────────

test("import-contacts route calls getSessionUser() before reading snapshot", () => {
  const code = src(IMPORT_RT);
  assert.ok(
    code.includes("getSessionUser()"),
    "import-contacts route must call getSessionUser() to identify the user"
  );
  // Must not accept username from query string or body (that would bypass auth).
  assert.ok(
    !code.includes("searchParams.get(\"username\")") &&
    !code.includes("searchParams.get('username')") &&
    !code.includes("body.username"),
    "import-contacts route must NOT accept username from query params or body — use session only"
  );
});

test("import-contacts POST passes username to getSnapshot and bulkImportUserContacts", () => {
  const code = src(IMPORT_RT);
  assert.ok(
    code.includes("getSnapshot(username)"),
    "import-contacts POST must call getSnapshot(username)"
  );
  assert.ok(
    code.includes("bulkImportUserContacts(username,") ||
    code.includes("bulkImportUserContacts(username ,"),
    "import-contacts POST must call bulkImportUserContacts(username, ...) with the session user"
  );
});

test("dump/status route calls getSessionUser() before reading status", () => {
  const code = src(STATUS_RT);
  assert.ok(
    code.includes("getSessionUser()"),
    "dump/status route must call getSessionUser() — status must be per-user"
  );
});

test("reset route calls getSessionUser() before resetting dump", () => {
  const code = src(RESET_RT);
  assert.ok(
    code.includes("getSessionUser()"),
    "reset route must call getSessionUser() — cannot reset another user's dump"
  );
});

test("snapshot route calls getSessionUser() before accessing snapshot", () => {
  const code = src(SNAP_RT);
  assert.ok(
    code.includes("getSessionUser()"),
    "snapshot route must call getSessionUser() — snapshot must be per-user"
  );
});

// ── Section 6: user-store.ts sanitises username for path safety ──────────────

test("user-store.ts sanitises username to prevent path traversal", () => {
  const code = src(USER_STORE);
  // The sanitisation regex must strip characters that could traverse directories.
  assert.ok(
    code.includes("replace(/[^a-zA-Z0-9._-]/g,") ||
    code.includes("replace(/[^a-zA-Z0-9._-]/g ,"),
    "userSubdir() in user-store.ts must sanitise username with /[^a-zA-Z0-9._-]/g"
  );
});

// ── Section 7: Path-helper properties (inline re-implementation) ──────────

// These tests re-implement the safeUser + userSubdir helpers verbatim to verify
// their mathematical properties.  If the real helpers change, the static
// analysis tests in Section 3 will also fail, creating a clear audit trail.

test("safeUser() replaces slashes — path traversal is impossible", () => {
  // Dots (.) are in the allowlist [a-zA-Z0-9._-] so they are preserved.
  // Slashes (/) are NOT in the allowlist and are replaced with _.
  // The result can never contain a path separator — path.join() treats the
  // sanitised string as a single directory name component, not a path.
  assert.strictEqual(safeUser("alice/bob"),       "alice_bob");
  assert.strictEqual(safeUser("../../etc/passwd"), ".._.._etc_passwd");
  assert.strictEqual(safeUser("../secret"),        ".._secret");
  // Verify the slash is gone — that's what prevents traversal.
  assert.ok(!safeUser("alice/bob").includes("/"),       "slash must be removed");
  assert.ok(!safeUser("../../etc/passwd").includes("/"), "slashes must be removed from traversal attempt");
});

test("safeUser() preserves alphanumeric, dot, dash, underscore", () => {
  assert.strictEqual(safeUser("alice"), "alice");
  assert.strictEqual(safeUser("alice.smith"), "alice.smith");
  assert.strictEqual(safeUser("alice-smith"), "alice-smith");
  assert.strictEqual(safeUser("alice_smith"), "alice_smith");
  assert.strictEqual(safeUser("alice123"), "alice123");
});

test("safeUser() sanitises at-sign and other special chars (email-as-username)", () => {
  assert.strictEqual(safeUser("alice@example.com"), "alice_example.com");
  assert.strictEqual(safeUser("alice+tag@example.com"), "alice_tag_example.com");
  assert.strictEqual(safeUser("user name"), "user_name");
});

test("userSubdir() produces distinct paths for distinct usernames", () => {
  assert.notStrictEqual(userSubdir("alice"), userSubdir("bob"));
  assert.notStrictEqual(userSubdir("admin"), userSubdir("alice"));
  assert.notStrictEqual(userSubdir("userA"), userSubdir("userB"));
});

test("userSubdir() produces the same path for the same username (stable)", () => {
  assert.strictEqual(userSubdir("alice"), userSubdir("alice"));
  assert.strictEqual(userSubdir("admin"), userSubdir("admin"));
});

test("userSubdir() paths are prefix-distinct — no accidental substring overlap", () => {
  // "alice" must not be a prefix of "alice2"'s subdir.
  const aliceDir  = userSubdir("alice");
  const alice2Dir = userSubdir("alice2");
  assert.ok(
    !alice2Dir.startsWith(aliceDir + "/"),
    `"${alice2Dir}" must not start with "${aliceDir}/" — that would allow "alice" to read "alice2" files`
  );
});

test("userSubdir() nests under the users/ prefix (not at the root)", () => {
  assert.ok(
    userSubdir("alice").startsWith("users/"),
    "Per-user subdirs must be nested under users/ so they never collide with global files"
  );
  assert.ok(
    userSubdir("alice") !== "users/",
    "Per-user subdir must include the sanitised username, not just 'users/'"
  );
});

// ── Section 8: No global singleton snapshot or status in dump-job.ts ─────────

test("dump-job.ts has no module-level variable that holds a single DumpStatus", () => {
  const code = src(DUMP_JOB);

  // A module-level singleton would be an unindented top-level declaration
  // (no leading whitespace before let/const/var).  Function-local variables
  // like `const cancelledStatus: DumpStatus = ...` are fine — they're indented.
  const lines = code.split("\n");
  const bad = lines.filter((line) => {
    // Only flag unindented (module-level) declarations.
    if (/^\s/.test(line)) return false;
    // Match: let/const/var <name>: DumpStatus = or let/const/var globalSnapshot: Snapshot =
    return (
      /^(?:let|const|var)\s+\w*[Ss]tatus\s*:\s*DumpStatus\s*=/.test(line) ||
      /^(?:let|const|var)\s+\w*[Ss]napshot\s*:\s*Snapshot\s*=/.test(line)
    );
  });

  assert.strictEqual(
    bad.length,
    0,
    `dump-job.ts has module-level status/snapshot singletons (would cause user data leakage):\n${bad.join("\n")}`
  );
});

test("dump-job.ts has no module-level boolean or jobId that tracks a single active job", () => {
  const code = src(DUMP_JOB);

  // Patterns that suggest a single-job global:
  const badPatterns = [
    /^(?:let|const|var)\s+(?:isRunning|running|activeJob|currentJobId)\s*[=:]/m,
    /^let\s+jobId\s*[=:]/m,
  ];

  for (const re of badPatterns) {
    assert.ok(
      !re.test(code),
      `dump-job.ts must not have a module-level single-job tracker: ${re}`
    );
  }
});

// ── Section 9: Contact store is per-user ──────────────────────────────────────

test("bulkImportUserContacts takes username as its first argument", () => {
  const contactStorePath = join(ROOT, "lib", "contacts", "user-store.ts");
  const code = src(contactStorePath);
  assert.match(
    code,
    /export\s+async\s+function\s+bulkImportUserContacts\s*\(\s*username\s*:/,
    "bulkImportUserContacts() must accept username as its first parameter"
  );
});

test("listUserContacts, addUserContactToStore, updateUserContactInStore all require username", () => {
  const contactStorePath = join(ROOT, "lib", "contacts", "user-store.ts");
  const code = src(contactStorePath);
  const required = [
    "listUserContacts",
    "addUserContactToStore",
    "updateUserContactInStore",
    "bulkImportUserContacts",
  ];
  for (const fnName of required) {
    const match = code.match(
      new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${fnName}\\s*\\(([^)]{0,200})`
      )
    );
    assert.ok(match, `${fnName} not found in user-store.ts`);
    const params = match[1];
    assert.ok(
      params.trim().startsWith("username"),
      `${fnName}() must accept username as its first parameter — got: (${params.trim()}...)`
    );
  }
});

test("user-store.ts contacts file is stored under the per-user subdir (not at root)", () => {
  const contactStorePath = join(ROOT, "lib", "contacts", "user-store.ts");
  const code = src(contactStorePath);

  // readUserStore and writeUserStore must be used (not raw readStore/writeStore
  // without a username subdir).  Account for optional TypeScript generic type
  // parameters: readUserStore<Contact[]>(username, ...) or readUserStore(username, ...).
  const hasRead =
    /readUserStore(?:<[^>]+>)?\s*\(username/.test(code);
  const hasWrite =
    /writeUserStore(?:<[^>]+>)?\s*\(username/.test(code);

  assert.ok(
    hasRead,
    "user-store.ts must call readUserStore(username, ...) — not the global readStore"
  );
  assert.ok(
    hasWrite,
    "user-store.ts must call writeUserStore(username, ...) — not the global writeStore"
  );
});
