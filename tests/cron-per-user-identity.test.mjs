/**
 * tests/cron-per-user-identity.test.mjs
 *
 * Regression guard for the "paying users never get a morning brief" class of
 * bug: cron fan-out wrappers must address each user explicitly, and the worker
 * routes must honour that identity rather than collapsing onto the admin user.
 *
 * Static source analysis only — no compilation or server required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

test("generate-briefing cron sends per-user x-basil-username header", () => {
  const src = read("app/api/cron/generate-briefing/route.ts");
  assert.match(src, /"x-basil-username":\s*user\.username/, "must address each user by name");
});

test("generate-briefing cron does NOT pre-DELETE the cache (write-then-swap)", () => {
  const src = read("app/api/cron/generate-briefing/route.ts");
  assert.doesNotMatch(
    src,
    /method:\s*"DELETE"/,
    "pre-DELETE leaves the user with nothing if regeneration fails — POST overwrites on success instead"
  );
});

test("reprocess has a per-user fan-out wrapper that sends x-basil-username", () => {
  const src = read("app/api/cron/reprocess/route.ts");
  assert.match(src, /"x-basil-username":\s*user\.username/);
  assert.match(src, /\/api\/events\/reprocess/);
});

test("every cron worker honours the x-basil-username header", () => {
  // All three workers must read the per-user identity header (whether via the
  // shared resolveCronUser helper or inline) so the fan-out actually targets
  // each user instead of collapsing onto the admin.
  for (const rel of [
    "app/api/generate/briefing/route.ts",
    "app/api/events/reprocess/route.ts",
    "app/api/events/poll-ingest/route.ts",
  ]) {
    const src = read(rel);
    assert.match(src, /x-basil-username|resolveCronUser/, `${rel} must honour per-user cron identity`);
  }
  // briefing + reprocess were migrated to the shared helper.
  assert.match(read("app/api/generate/briefing/route.ts"), /resolveCronUser/);
  assert.match(read("app/api/events/reprocess/route.ts"), /resolveCronUser/);
});

test("vercel.json points the reprocess cron at the wrapper, not the worker", () => {
  const cfg = JSON.parse(read("vercel.json"));
  const paths = (cfg.crons ?? []).map((c) => c.path);
  assert.ok(paths.includes("/api/cron/reprocess"), "reprocess cron must target the fan-out wrapper");
  assert.ok(!paths.includes("/api/events/reprocess"), "direct worker route must not be the scheduled cron");
});
