/**
 * tests/self-origin.test.mjs
 *
 * A week of total silence, from one stale environment variable.
 *
 * Basil's crons fan out to their own API over HTTP, resolving the target from
 * APP_URL. APP_URL held `ag-contracts.vercel.app` — a host later REASSIGNED to a
 * different Vercel project. Every nightly run therefore POSTed into another
 * application and took a 404: ingest, reprocess, briefing generation and
 * sync-now. Basil read no mail for a week.
 *
 * Two independent faults, both pinned here:
 *
 *   1. A SELF-call was resolved from a configurable PUBLIC address. Those are
 *      different questions and must not share a source.
 *   2. Every cron returned `ok: true` regardless of per-user results, so a run
 *      where EVERY user failed reported success. That is why nobody noticed.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const origin = read("lib/http/origin.ts");

test("selfOrigin prefers the deployment's own URL, never a configurable one", () => {
  const fn = origin.slice(origin.indexOf("export function selfOrigin"));
  const vercel = fn.indexOf("VERCEL_URL");
  const app = fn.indexOf("APP_URL");
  assert.ok(vercel > -1, "self-calls must be able to address this deployment");
  assert.ok(vercel < app,
    "VERCEL_URL must be checked BEFORE APP_URL — APP_URL is public, configurable, " +
    "and can be repointed at a different project, which is exactly what happened");
});

test("publicOrigin keeps APP_URL first — it must match registered URIs", () => {
  const fn = origin.slice(origin.indexOf("export function publicOrigin"));
  const app = fn.indexOf("APP_URL");
  const vercel = fn.indexOf("VERCEL_URL");
  assert.ok(app < vercel,
    "a per-deployment URL would rot in emails and never match an OAuth redirect URI");
});

test("no internal fan-out resolves its host from APP_URL directly", () => {
  // The whole class: any self-call built on the public address inherits the bug.
  const internal = [
    "app/api/cron/poll-ingest/route.ts",
    "app/api/cron/reprocess/route.ts",
    "app/api/cron/generate-briefing/route.ts",
    "app/api/settings/sync-now/route.ts",
    "lib/onboarding/backfill.ts",
  ];
  const offenders = [];
  for (const p of internal) {
    const src = read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/process\.env\.APP_URL/.test(src)) offenders.push(p);
    if (!/selfOrigin\(\)/.test(src)) offenders.push(`${p} (does not use selfOrigin)`);
  }
  assert.deepEqual(offenders, [],
    "these call Basil's own API using the public address:\n  " + offenders.join("\n  "));
});

test("no stale host remains in shipped code", () => {
  const files = ["app/layout.tsx"];
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/ag-contracts\.vercel\.app/.test(src),
      `${f} still defaults to a host that belongs to another project`);
  }
});

test("a cron that failed for every user does not report success", () => {
  // The reporting fault. Hardcoded ok:true meant a total outage looked healthy
  // to anything checking the top-level flag — which is everything.
  for (const name of readdirSync(resolve(ROOT, "app/api/cron"))) {
    const p = resolve(ROOT, "app/api/cron", name, "route.ts");
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    if (!/results\[user\.username\]/.test(src)) continue;   // not a fan-out cron
    assert.ok(!/ok:\s*true,\s*\n\s*users:/.test(src),
      `${name}: top-level ok is hardcoded true despite per-user results`);
    assert.ok(/ok:\s*failed === 0/.test(src),
      `${name}: ok must be derived from the per-user outcomes`);
  }
});
