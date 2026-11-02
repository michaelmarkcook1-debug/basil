// A daily AI budget per person (2026-11-02, before a colleague joined).
// AI_PER_USER_DAILY_USD gave everyone the same number; an admin can now set
// each person's own limit in /admin, and 0 switches their AI off.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const pricing = loadTs("lib/ai/pricing.ts", { "./model-config": { RESERVE_OUTPUT_TOKENS: { fast: 2_000, balanced: 3_000, default: 6_000, long: 8_000 } } });
const ONE = pricing.worstCaseCostUsd("default", "opus55");

function guard(limits, { usersFail = false } = {}) {
  const counters = new Map();
  const g = loadTs("lib/ai/spend-guard.ts", {
    "./pricing": pricing,
    "@/lib/storage/counter": {
      incrCounter: async (key, delta) => { counters.set(key, +((counters.get(key) ?? 0) + delta).toFixed(6)); return { value: counters.get(key) }; },
      getCounter: async (key) => counters.get(key) ?? 0,
      isDurableCounter: () => true,
    },
    "./spend-log": { currentPeriod: () => "2026-11", currentDay: () => "2026-11-02", secondsUntilPeriodEnd: () => 100, secondsUntilDayEnd: () => 10, appendSpendEvent: async () => {} },
    "@/lib/users": { findByUsername: async (u) => { if (usersFail) throw new Error("store down"); return { username: u, ...(u in limits ? { aiDailyUsd: limits[u] } : {}) }; } },
  }, { AI_PER_USER_DAILY_USD: "2" });
  return { g, counters };
}
const meter = (username) => ({ username, feature: "chat", family: "opus55", maxSteps: 1 });

test("each person is held to their own limit; no limit set means the default", async () => {
  const { g } = guard({ guy: 0.5 });
  assert.ok(ONE > 0.25 && ONE < 0.5, `one step = ${ONE}`);
  await g.reserveSpend(meter("guy"), "default");                        // $0.31 of Guy's $0.50
  await assert.rejects(g.reserveSpend(meter("guy"), "default"), (e) => e.scope === "user-daily");
  for (let i = 0; i < 6; i++) await g.reserveSpend(meter("michael"), "default"); // $1.87 of the $2 default
  await assert.rejects(g.reserveSpend(meter("michael"), "default"), (e) => e.scope === "user-daily");
});

test("a limit of 0 turns that person's AI off without touching anyone else", async () => {
  const { g } = guard({ guy: 0 });
  await assert.rejects(g.reserveSpend(meter("guy"), "default"), (e) => e.scope === "user-daily");
  assert.equal((await g.checkSpendBudget("guy")).ok, false);
  assert.equal((await g.checkSpendBudget("michael")).ok, true);
});

test("an unreadable user record falls back to the default limit, never to no limit", async () => {
  const { g } = guard({}, { usersFail: true });
  assert.equal((await g.getUserSpendToday("guy")).capUsd, 2);
});

test("the admin summary lists every user with the limit they are held to", async () => {
  const { g } = guard({ guy: 0.5 });
  const s = await g.getSpendSummary(["michael", "guy"]);
  assert.equal(JSON.stringify(s.perUser.map((r) => [r.username, r.dailyCapUsd]).sort()), JSON.stringify([["guy", 0.5], ["michael", 2]]));
});

test("only an admin sets it, within $0–$100; null restores the default", () => {
  const r = src("app/api/admin/users/[id]/route.ts");
  assert.match(r, /if \(!admin\) return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/);
  assert.match(r, /body\.action === "set-ai-limit"/);
  assert.match(r, /v >= 0 && v <= 100/);
  assert.match(src("lib/users.ts"), /copy\[idx\] = usd === null \? rest : \{ \.\.\.rest, aiDailyUsd: usd \};/);
  assert.match(src("app/admin/page.tsx"), /action: "set-ai-limit", aiDailyUsd: value/);
});
