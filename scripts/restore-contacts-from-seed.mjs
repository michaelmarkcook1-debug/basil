#!/usr/bin/env node
/**
 * restore-contacts-from-seed.mjs
 *
 * One-off recovery tool. The launch PII-scrub (commit a97ba1f) replaced the
 * original hand-authored seed contacts in lib/contacts-data.ts with fictional
 * "(SAMPLE)" placeholders. This script rebuilds the ORIGINAL contacts from any
 * earlier git revision of that file and writes them into a user's PRIVATE
 * contact store as user-added records — so real PII lives per-user, never in
 * committed source (multi-tenant safe).
 *
 * Generic by design: no names, emails, or usernames are hardcoded (satisfies
 * tests/no-hardcoded-users.test.mjs). You pass the git ref and the username.
 *
 * Usage:
 *   node scripts/restore-contacts-from-seed.mjs <git-ref> <username>
 *   e.g. node scripts/restore-contacts-from-seed.mjs fb031f2 alice
 *
 * Outputs:
 *   1. .data/users/<username>/sage-user-contacts.json  — restores a LOCAL instance
 *      (merged, never clobbered). Production runs on Vercel Blob, so for prod use:
 *   2. .data/restored-contacts.import.json  — a { import: [...] } payload to POST,
 *      while authenticated as the user, to /api/contacts/user (goes through the
 *      storage layer → Blob).
 *
 * Both outputs land under .data/ which is gitignored — no PII is ever committed.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , gitRef, username] = process.argv;
if (!gitRef || !username) {
  console.error("Usage: node scripts/restore-contacts-from-seed.mjs <git-ref> <username>");
  process.exit(1);
}

// 1. Pull the historical contacts-data.ts and isolate the `contacts` array literal.
const ts = execSync(`git show ${gitRef}:lib/contacts-data.ts`, { encoding: "utf8" });
const declIdx = ts.indexOf("export const contacts");
if (declIdx === -1) {
  console.error(`Could not find "export const contacts" in ${gitRef}:lib/contacts-data.ts`);
  process.exit(1);
}
// Start the search after the `=` so the `[]` in the `Contact[]` type annotation
// isn't mistaken for the array's opening bracket.
const eq = ts.indexOf("=", declIdx);
const open = ts.indexOf("[", eq);
let depth = 0;
let close = -1;
for (let i = open; i < ts.length; i++) {
  if (ts[i] === "[") depth++;
  else if (ts[i] === "]" && --depth === 0) { close = i; break; }
}
const arrayLiteral = ts.slice(open, close + 1);

// 2. Evaluate the data literal safely by importing it as an ES module (handles
//    unquoted keys, trailing commas, and // comments — none of it is executable
//    code, just object/array/string literals).
const tmp = resolve(process.cwd(), ".data", `.contacts-extract-${gitRef.replace(/[^a-z0-9]/gi, "")}.mjs`);
mkdirSync(resolve(process.cwd(), ".data"), { recursive: true });
writeFileSync(tmp, `export default ${arrayLiteral};\n`);
let seedRecords;
try {
  seedRecords = (await import(pathToFileURL(tmp).href)).default;
} finally {
  rmSync(tmp, { force: true });
}

// 3. Transform seed → user-added records (drop the _isSeedData marker).
const now = new Date().toISOString();
const restored = seedRecords.map((c) => {
  const { _isSeedData, ...rest } = c;
  return { ...rest, source: "user-added", createdAt: now };
});

// 4. Merge into the local user store (never clobber existing user contacts).
const dir = resolve(process.cwd(), ".data", "users", username);
mkdirSync(dir, { recursive: true });
const file = resolve(dir, "sage-user-contacts.json");
let existing = [];
if (existsSync(file)) {
  try { existing = JSON.parse(readFileSync(file, "utf8")); } catch { existing = []; }
}
const byId = new Map(existing.map((c) => [c.id, c]));
let addedCount = 0;
for (const c of restored) if (!byId.has(c.id)) { byId.set(c.id, c); addedCount++; }
const merged = [...byId.values()];
writeFileSync(file, JSON.stringify(merged, null, 2));

// 5. Emit a prod import payload.
const importFile = resolve(process.cwd(), ".data", "restored-contacts.import.json");
writeFileSync(importFile, JSON.stringify({ import: restored }, null, 2));

console.log(`Restored ${restored.length} contacts from ${gitRef} (${addedCount} new) → ${file}`);
console.log(`Total user contacts now: ${merged.length}`);
console.log(`Prod import payload → ${importFile}`);
console.log(`\nFor production (Vercel Blob), while logged in as "${username}":`);
console.log(`  curl -X POST https://<your-app>/api/contacts/user \\`);
console.log(`    -H "Content-Type: application/json" -H "Cookie: <your session cookie>" \\`);
console.log(`    --data @.data/restored-contacts.import.json`);
