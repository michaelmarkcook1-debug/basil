/**
 * tests/audit3-fixes.test.mjs
 *
 * Guards the fixes from the 2026-07-23 full audit.
 *
 * The headline one is `apiFetchTargetsExist`: a component fetched "/api/contacts",
 * which has no route.ts (only sub-routes), so it 404'd on every load. The failure
 * was invisible — the widget just read "Loading contacts…" forever. A typo'd
 * fetch path is a whole bug CLASS that nothing else in the suite catches, so
 * this test enumerates every literal /api/... fetch in the app and asserts a
 * matching route exists.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

/** Recursively collect files under dir matching a predicate. */
function walk(dir, pred, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, pred, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

test("every literal /api/... fetch target has a route that exists", () => {
  const sources = walk(resolve(ROOT, "app"), (f) => /\.(tsx?|jsx?)$/.test(f))
    .concat(walk(resolve(ROOT, "components"), (f) => /\.(tsx?|jsx?)$/.test(f)));

  const bad = [];
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    // Only LITERAL paths — skip anything with a template placeholder, since a
    // dynamic segment can't be resolved statically.
    for (const m of src.matchAll(/fetch\(\s*["'`](\/api\/[^"'`?]*)["'`?]/g)) {
      const path = m[1].replace(/\/$/, "");
      if (path.includes("${")) continue;
      const routeFile = resolve(ROOT, "app" + path, "route.ts");
      if (existsSync(routeFile)) continue;
      // A dynamic sibling ([id]) can legitimately serve this path.
      const parent = resolve(ROOT, "app" + path, "..");
      let dynamicMatch = false;
      try {
        dynamicMatch = readdirSync(parent).some(
          (d) => d.startsWith("[") && existsSync(join(parent, d, "route.ts"))
        );
      } catch { /* parent may not exist — that's the bug we're reporting */ }
      if (!dynamicMatch) bad.push(`${file.replace(ROOT + "/", "")} → ${path}`);
    }
  }

  assert.deepEqual(bad, [], `fetch() targets with no matching API route:\n  ${bad.join("\n  ")}`);
});

test("cron routes all fail CLOSED when CRON_SECRET is unset", () => {
  const dir = resolve(ROOT, "app/api/cron");
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "route.ts");
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    assert.ok(
      /!cronSecret\s*\|\|/.test(src),
      `${name}: must guard on !cronSecret — without it an unset secret makes the ` +
      `comparison "Bearer undefined", which any caller can send`
    );
  }
});

test("the QStash job handler fails closed in production", () => {
  const src = read("app/api/jobs/handler/route.ts");
  assert.ok(
    /else if \(process\.env\.NODE_ENV === "production"\)/.test(src),
    "with no signing keys, production must 403 — never fall through to a client-supplied Host check"
  );
});

test("zoom is not locked (WCAG 1.4.4) and the warning banner is legible", () => {
  const layout = read("app/layout.tsx");
  assert.ok(!/maximumScale:\s*1/.test(layout) && !/userScalable:\s*false/.test(layout),
    "layout must not disable pinch-zoom — inputs are already 16px so it buys nothing");
  // Match the live className only (className="…"), not prose in comments that
  // quotes the old broken value for context.
  const memory = read("app/dashboard/memory/page.tsx");
  const classNames = [...memory.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
  // NB: `\b` would also match the -subtle/-border variants (a hyphen counts as a
  // word boundary), so exclude any trailing segment explicitly. Only the SOLID
  // bg paired with the SOLID text is the invisible case.
  const invisible = classNames.filter(
    (c) => /bg-signal-warning(?![-\w])/.test(c) && /text-signal-warning(?![-\w])/.test(c)
  );
  assert.deepEqual(invisible, [],
    "same token for bg and text = 1:1 contrast (invisible banner)");
});

test("a failed legacy import never deletes the only local copy", () => {
  const src = read("app/dashboard/actions/page.tsx");
  // Anchor on the destructive call itself, and look at the code ABOVE it.
  const idx = src.indexOf("removeItem(LEGACY_STORAGE_KEY)");
  assert.ok(idx > -1, "expected the legacy-import cleanup to exist");
  const block = src.slice(Math.max(0, idx - 1200), idx);
  assert.ok(/if \(!res\.ok\)/.test(block),
    "must check res.ok before removeItem — fetch() does not reject on 5xx, so a " +
    "failed import was permanently destroying every legacy action");
});

// ── Silent failure: an outage must never render as "you have nothing to do" ──
// This is the highest-severity class in the audit. For an assistant whose job is
// "I'll tell you what needs you", a failure that REASSURES is the one failure
// the user would never think to retry.

test("an upstream Linear failure surfaces as an error, not an empty backlog", () => {
  const client = read("lib/linear/client.ts");
  const idx = client.indexOf("[linear] getAllIssues error:");
  assert.ok(idx > -1, "expected the getAllIssues catch block");
  const block = client.slice(idx, idx + 200);
  assert.ok(/throw /.test(block) && !/return \[\]/.test(block),
    "getAllIssues must rethrow — returning [] made an outage indistinguishable from an empty backlog");

  const route = read("app/api/linear/issues/route.ts");
  assert.ok(/status: 502/.test(route),
    "the route must answer 502 on upstream failure so the page's !res.ok branch is reachable");
});

test("the Linear AI tool never reports an outage as 'no issues'", () => {
  const tools = read("lib/ai/tools.ts");
  const catches = [...tools.matchAll(/Couldn't reach Linear/g)];
  assert.ok(catches.length >= 2,
    "both getAllIssues call sites in the AI tools must catch and tell the model the list is UNKNOWN, " +
    "otherwise Ask Basil states the backlog is empty during a Linear outage");
});

test("the home feed fetcher throws, and a failed feed is not an all-clear", () => {
  const page = read("app/dashboard/page.tsx");
  assert.ok(!/r\.ok \? r\.json\(\) : null/.test(page),
    "swrFetch must not swallow the status — SWR then never errors and the page claims 'All clear'");
  assert.ok(/if \(!r\.ok\) throw/.test(page), "swrFetch must throw on a bad response");
  assert.ok(/error: feedError/.test(page), "the page must read SWR's error for the feed");
  assert.ok(/!isLoading && !feedError && totalNeeds === 0/.test(page),
    "the 'Nothing needs you' empty state must be gated on there being no error");
});

test("every [id] write route validates its body instead of casting", () => {
  // A `as Partial<T>` cast is a COMPILE-TIME assertion only. The stores apply
  // patches with a raw spread, so at runtime any key and any value type landed
  // in the stored record — including overwriting `id`, or setting an array
  // field to a string and breaking every downstream consumer. zod both
  // validates types AND strips unknown keys.
  const routes = [
    "app/api/actions/[id]/route.ts",
    "app/api/decisions/[id]/route.ts",
    "app/api/memory/[id]/route.ts",
    "app/api/ledger/[id]/route.ts",
    "app/api/contacts/user/[id]/route.ts",
    "app/api/contacts/overrides/[id]/route.ts",
    "app/api/linear/issues/[id]/route.ts",
  ];
  for (const p of routes) {
    const src = read(p);
    assert.ok(/parseBody\(/.test(src), `${p} must validate its body via parseBody`);
    assert.ok(!/await req\.json\(\)\) as /.test(src),
      `${p} must not cast an unvalidated body — the cast is erased at runtime`);
  }
});

test("the lock's retry budget outlasts its own TTL", () => {
  // If retries × waitMs <= ttlMs, a waiter gives up BEFORE a dead holder's lock
  // can expire — it can never outlast a stuck lock, only fail. That was the
  // live "[lock] could not acquire actions:<user> after 30 attempts" error:
  // 30 × 100ms = 3s against a 5s TTL. Invisible while the lock was a no-op
  // in-process mutex; immediate once Upstash made it real.
  const src = read("lib/storage/lock.ts");
  const ttl = Number(/opts\.ttlMs \?\? (\d+)/.exec(src)?.[1]);
  const retries = Number(/opts\.retries \?\? (\d+)/.exec(src)?.[1]);
  const wait = Number(/opts\.waitMs \?\? (\d+)/.exec(src)?.[1]);
  assert.ok(ttl > 0 && retries > 0 && wait > 0, "lock defaults must all parse");
  assert.ok(retries * wait > ttl,
    `retry budget (${retries}×${wait}=${retries * wait}ms) must exceed the lock TTL (${ttl}ms)`);
});

test("background maintenance takes ONE lock, not two on the same key", () => {
  // Two fire-and-forget withLock() calls on the same key, launched back-to-back,
  // contend with each other the moment the lock is genuinely cross-instance.
  const src = read("lib/actions/store.ts");
  const listFn = src.slice(src.indexOf("export async function listActions"));
  const body = listFn.slice(0, listFn.indexOf("\n  // ── Owner filter"));
  const locks = [...body.matchAll(/withLock\(lockKey\(username\)/g)];
  assert.equal(locks.length, 1,
    `listActions must acquire the actions lock at most once for background maintenance (found ${locks.length})`);
});

test("Redis gates accept the KV_* names the Marketplace actually provisions", () => {
  // The Vercel Upstash integration provisions KV_REST_API_URL/TOKEN, but
  // Redis.fromEnv() only reads UPSTASH_REDIS_REST_URL/TOKEN. Gating on the
  // latter alone meant a correctly-installed integration changed NOTHING —
  // locks stayed per-instance and auth rate limits stayed per-instance.
  const cfg = read("lib/storage/redis-config.ts");
  assert.ok(/KV_REST_API_URL/.test(cfg) && /KV_REST_API_TOKEN/.test(cfg),
    "the resolver must accept the Marketplace KV_* names");
  assert.ok(/UPSTASH_REDIS_REST_URL/.test(cfg) && /UPSTASH_REDIS_REST_TOKEN/.test(cfg),
    "…and still accept the SDK's own UPSTASH_* names");

  for (const p of ["lib/storage/lock.ts", "lib/rate-limit.ts"]) {
    const src = read(p);
    assert.ok(/resolveRedisRestConfig\(\)/.test(src), `${p} must resolve via the shared resolver`);
    // Match an actual ASSIGNMENT, not prose — the comments in these files
    // legitimately name Redis.fromEnv() while explaining why it isn't used.
    assert.ok(!/=\s*Redis\.fromEnv\(\)/.test(src),
      `${p} must not call Redis.fromEnv() — it ignores the KV_* names`);
    assert.ok(/console\.(warn|error)/.test(src),
      `${p} must announce the degraded path — silent degradation is what hid this`);
  }
});

test("every locked read-modify-write in actions/store reads FRESH", () => {
  // A read off the untimed per-instance /tmp cache defeats the lock entirely:
  // the write is serialised but derived from a stale snapshot, so this instance
  // overwrites actions another instance created. All 12 sites were bare.
  const src = read("lib/actions/store.ts");
  const bare = [...src.matchAll(/await readAll\(username\);/g)];
  assert.deepEqual(bare.map(() => "bare readAll"), [],
    "readAll inside a withLock must pass { fresh: true } — otherwise the lock guards a stale read");
});

// ── False success: a failed write must never show a success affordance ───────

test("the sync buttons do not claim success on a failed request", () => {
  for (const p of ["app/dashboard/memory/page.tsx", "app/dashboard/decisions/page.tsx"]) {
    const src = read(p);
    assert.ok(!/try \{ await fetch\("\/api\/events\/poll-ingest", \{ method: "POST" \}\); \} catch \{ \/\* ignore \*\/ \}/.test(src),
      `${p}: the swallowed catch + unconditional setDone reported "Syncing…" on a 500`);
    assert.ok(/setFailed\(true\)/.test(src) && /Sync failed/.test(src),
      `${p}: a failed sync must be visible to the user`);
  }
});

test("a failed explore-panel save is surfaced and the text is kept", () => {
  const src = read("components/explore-panel.tsx");
  assert.ok(/catch \(err\)/.test(src) && /setSaveError\(true\)/.test(src),
    "try/finally with no catch let a lost note read as auto-saved");
  const idx = src.indexOf("catch (err)");
  assert.ok(!/lastSaved\.current = draft/.test(src.slice(idx, idx + 300)),
    "lastSaved must NOT advance on failure, or the next blur skips the retry");
});

test("calendar reply / forward / RSVP only claim success after the server confirms", () => {
  const src = read("app/dashboard/schedule/components/DayView.tsx");
  assert.ok((src.match(/if \(!res\.ok\) throw new Error/g) || []).length >= 2,
    "reply and forward must both check res.ok before showing Sent/Forwarded");
  const rsvp = src.slice(src.indexOf("async function handleRsvp"));
  const body = rsvp.slice(0, rsvp.indexOf("\n  }"));
  assert.ok(/catch \(err\)/.test(body) && /finally/.test(body),
    "handleRsvp had neither catch nor finally — a throw disabled all three buttons forever");
  assert.ok(/role="alert"/.test(src) && /actionError/.test(src),
    "the failure must actually be RENDERED, not just stored in state");
});

// ── Interaction: escapable, reachable, tappable ──────────────────────────────

test("chat exposes a Stop control and never hides the live conversation", () => {
  const src = read("app/dashboard/chat/page.tsx");
  assert.ok(/status, error, stop \}/.test(src) || /\bstop\b[^;]*\} =\s*\n?\s*useChat/.test(src),
    "useChat must expose stop — without it a stalled stream locks the UI permanently");
  assert.ok(/aria-label="Stop generating"/.test(src), "a Stop control must be rendered while streaming");
  assert.ok(!/\{showHistory && messages\.length > 0 \?/.test(src),
    "the live conversation must not be gated on the History toggle");
});

test("Linear cards are keyboard-operable", () => {
  const src = read("app/dashboard/linear/page.tsx");
  assert.ok(/role="button"/.test(src) && /tabIndex=\{0\}/.test(src) && /onKeyDown=/.test(src),
    "Card renders a div; onClick alone made the whole Linear list keyboard-unreachable");
});

test("calendar events are keyboard-operable", () => {
  const src = read("app/dashboard/schedule/components/DayView.tsx");
  // Drag remains mouse-only (a separate concern), but OPENING an event must
  // never require a mouse — every event was a bare <div onClick>.
  assert.ok(/role="button"/.test(src) && /tabIndex=\{0\}/.test(src),
    "calendar events need button semantics");
  assert.ok(/onKeyDown=\{\(e\) => \{[\s\S]{0,200}onEventClick\(event\)/.test(src),
    "Enter/Space must open the event");
});

test("action controls keep a 44px target and a visible label on mobile", () => {
  const src = read("components/actions/action-controls.tsx");
  assert.ok(!/hidden sm:inline">\{label\}/.test(src),
    "hiding the label collapsed Done/Push/Delegate/Delete into ~22px icons");
  assert.ok(/min-h-11 sm:min-h-0/.test(src),
    "mobile needs a 44px minimum target — Delete sits beside Done");
});

test("mode-intelligence does not double-count high-priority actions", () => {
  const src = read("components/ui/mode-intelligence.tsx");
  assert.ok(!/stats\.critical \+ stats\.high/.test(src),
    "critical and high were identical filters; summing them reported 2x the real count");
  assert.ok(!/:\s*"Loading (commitments|inbox|contacts)…"/.test(src),
    "the null-stats branch runs AFTER loading is false — saying 'Loading' there is a lie");
});
