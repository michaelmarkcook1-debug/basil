/**
 * tests/redis-config-uniform.test.mjs
 *
 * EVERY Redis consumer must resolve credentials through resolveRedisRestConfig.
 *
 * This bug has now shipped twice, in two different files, with the same shape:
 * the Upstash SDK's Redis.fromEnv() only recognises UPSTASH_REDIS_REST_URL /
 * _TOKEN, but the Vercel Marketplace integration provisions KV_REST_API_URL /
 * _TOKEN. A module gated on the UPSTASH_* pair therefore finds nothing, falls
 * back silently, and reports success — the integration installs cleanly and
 * changes NOTHING.
 *
 *   1st: lib/storage/lock.ts   → withLock silently stayed a per-instance mutex
 *   2nd: lib/storage/counter.ts → the SPEND COUNTER sat on the last-write-wins
 *        Blob fallback, so `durable: false` and every spend cap was SOFT:
 *        concurrent calls lose updates, so a ceiling can be overshot. Found
 *        2026-08-03, immediately after wiring a $1/day cap that would not
 *        reliably have held.
 *
 * The failure is invisible by construction — nothing errors, the fallback works
 * — so it needs a structural guard rather than vigilance.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "core"))];

test("no module constructs a Redis client via fromEnv()", () => {
  const offenders = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    // Ignore prose in comments; look for an actual call.
    return /(?<!`)Redis\.fromEnv\(\)/.test(src.replace(/^\s*(\/\/|\*).*$/gm, ""));
  });
  assert.deepEqual(offenders.map((f) => f.replace(ROOT + "/", "")), [],
    "Redis.fromEnv() ignores the KV_REST_API_* names the Marketplace provisions — use resolveRedisRestConfig()");
});

test("no module gates Redis on the UPSTASH_* names alone", () => {
  const offenders = [];
  for (const f of files) {
    if (f.endsWith("redis-config.ts")) continue; // the resolver itself reads both
    const src = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    if (!/process\.env\.UPSTASH_REDIS_REST_/.test(src)) continue;
    // Reading it is only safe if KV_REST_API_ is considered too.
    if (!/KV_REST_API_/.test(src)) offenders.push(f.replace(ROOT + "/", ""));
  }
  assert.deepEqual(offenders, [],
    "gating on UPSTASH_* alone silently no-ops when Upstash was provisioned via the Vercel Marketplace");
});

test("both known Redis consumers use the shared resolver", () => {
  for (const rel of ["lib/storage/lock.ts", "lib/storage/counter.ts"]) {
    const src = readFileSync(resolve(ROOT, rel), "utf8");
    assert.ok(/resolveRedisRestConfig\(\)/.test(src),
      `${rel} must resolve credentials through the shared resolver`);
  }
});

test("the resolver accepts either naming convention", () => {
  const src = readFileSync(resolve(ROOT, "lib/storage/redis-config.ts"), "utf8");
  assert.ok(/UPSTASH_REDIS_REST_URL\s*\?\?\s*process\.env\.KV_REST_API_URL/.test(src),
    "URL must fall back to the Marketplace name");
  assert.ok(/UPSTASH_REDIS_REST_TOKEN\s*\?\?\s*process\.env\.KV_REST_API_TOKEN/.test(src),
    "token must fall back to the Marketplace name");
});
