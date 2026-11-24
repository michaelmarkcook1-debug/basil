// Workstreams (2026-11-23): operations, platform & product, research, clients &
// sales. Rules first (the user's own, then precise built-ins), the classifier
// only for what rules cannot place, the user's choice always wins, and Today
// filters before its display cap.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));
const T = loadTs("lib/workstreams/types.ts");
const R = loadTs("lib/workstreams/rules.ts");
const L = loadTs("lib/workstreams/learn.ts");

const rule = (field, value, workstream, createdAt = "2026-11-23T00:00:00Z") => ({ id: `r-${field}-${value}`, field, value, workstream, createdAt });

test("four workstreams, clients and sales merged", () => {
  assert.deepEqual([...T.WORKSTREAM_IDS], ["operations", "product", "research", "clients"]);
  assert.equal(T.workstreamInfo("clients").label, "Clients & Sales");
  assert.equal(T.isWorkstream("sales"), false);
});

test("built-ins: Linear is product; clear words route; ambiguous or mixed lines are left for the classifier", () => {
  assert.equal(R.routeByRules({ key: "a", text: "Fix login", source: "linear" }, []).workstream, "product");
  assert.equal(R.routeByRules({ key: "a", text: "Pay the accountant's invoice" }, []).workstream, "operations");
  assert.equal(R.routeByRules({ key: "a", text: "Send Atos the proposal" }, []).workstream, "clients");
  assert.equal(R.routeByRules({ key: "a", text: "Fix the bug in staging" }, []).workstream, "product");
  assert.equal(R.routeByRules({ key: "a", text: "Send the client the bug fix" }, []), null, "two workstreams → classifier");
  assert.equal(R.routeByRules({ key: "a", text: "Deal with the onboarding" }, []), null, "ambiguous words are not rules");
  assert.equal(R.routeByRules({ key: "a", text: "Catch up", channel: "eng-platform" }, []).workstream, "product");
});

test("the user's rules beat built-ins, and an exact sender beats a domain", () => {
  const rules = [rule("domain", "atos.net", "clients"), rule("sender", "cto@atos.net", "product"), rule("keyword", "analystgenius", "research")];
  assert.equal(R.routeByRules({ key: "a", text: "Re: invoice", senderEmail: "CTO@atos.net" }, rules).workstream, "product");
  assert.equal(R.routeByRules({ key: "a", text: "Re: invoice", senderEmail: "buyer@uk.atos.net" }, rules).workstream, "clients", "subdomains count");
  assert.equal(R.routeByRules({ key: "a", text: "AnalystGenius benchmark" }, rules).workstream, "research");
  assert.equal(R.routeByRules({ key: "a", text: "analystgeniuses" }, rules), null, "keywords are whole words");
});

function classify({ store, ai }) {
  const saved = [];
  const calls = [];
  const C = loadTs("lib/workstreams/classify.ts", {
    "@/lib/ai/generate": { generateTextSafe: async (o, kind, meter) => { calls.push({ o, kind, meter }); return { text: ai(o.prompt) }; } },
    "@/lib/ai/system-prompt": { getTaskSystemPrompt: async () => "sys" },
    "@/lib/workstreams/rules": R,
    "@/lib/workstreams/types": T,
    "@/lib/workstreams/store": {
      readWorkstreams: async () => store,
      saveVerdicts: async (_u, v) => { saved.push(v); },
      filingsOf: (verdicts) => Object.values(verdicts).filter((v) => v.by === "user" && v.w).map((v) => ({ w: v.w, at: v.at, t: v.t })),
    },
    "@/lib/workstreams/learn": L,
  });
  return { C, saved, calls };
}

test("order: the user's verdict, then rules, then a stored verdict, then the classifier — and only the rest is sent", async () => {
  const store = {
    rules: [rule("sender", "ed@talentgenius.io", "operations")],
    verdicts: {
      "action:u": { w: "research", by: "user", at: "2026-11-20T00:00:00Z", t: "Read the Gartner note" },
      "action:old": { w: "clients", by: "ai", at: "2026-11-20T00:00:00Z" },
    },
  };
  const { C, saved, calls } = classify({ store, ai: () => '[{"id":"action:new","w":"product"},{"id":"gmail:x","w":"none"}]' });
  const out = await C.assignWorkstreams("michael", [
    { key: "action:u", text: "Fix the bug", source: "manual" },
    { key: "gmail:ed", text: "Re: something", senderEmail: "ed@talentgenius.io" },
    { key: "action:old", text: "Call Priya" },
    { key: "action:new", text: "Think about the scoring model" },
    { key: "gmail:x", text: "Your weekly newsletter" },
  ]);
  assert.deepEqual(plain(Object.fromEntries(out)), {
    "action:u": { workstream: "research", by: "user" },
    "gmail:ed": { workstream: "operations", by: "rule" },
    "action:old": { workstream: "clients", by: "ai" },
    "action:new": { workstream: "product", by: "ai" },
    "gmail:x": { workstream: null, by: "ai" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "fast");
  assert.equal(calls[0].meter.feature, "workstreams");
  assert.ok(calls[0].o.maxOutputTokens >= 1000, "room for the reasoning fallback");
  assert.doesNotMatch(calls[0].o.prompt, /\[action:u\]|\[gmail:ed\]|\[action:old\]/, "decided items are not sent");
  assert.match(calls[0].o.prompt, /"Read the Gartner note" → research/, "the user's filings are examples");
  assert.deepEqual(Object.keys(saved[0]).sort(), ["action:new", "gmail:x"]);
});

test("a failed classifier leaves things unsorted and never throws; aiLimit 0 never calls it", async () => {
  const { C } = classify({ store: { rules: [], verdicts: {} }, ai: () => { throw new Error("credit balance is too low"); } });
  const out = await C.assignWorkstreams("michael", [{ key: "a", text: "Think" }]);
  assert.equal(out.size, 0);
  const z = classify({ store: { rules: [], verdicts: {} }, ai: () => "[]" });
  await z.C.assignWorkstreams("michael", [{ key: "a", text: "Think" }], { aiLimit: 0 });
  assert.equal(z.calls.length, 0);
});

test("lenient parse: fences and prose around the array, unknown labels ignored", () => {
  const { C } = classify({ store: { rules: [], verdicts: {} }, ai: () => "" });
  const m = C.parseVerdicts('Sure!\n```json\n[{"id":"a","w":"clients"},{"id":"b","w":"sales"},{"id":"c","w":"none"}]\n```');
  assert.deepEqual(plain(Object.fromEntries(m)), { a: "clients", c: null });
});

test("feed items and actions share keys, so one correction shows everywhere", () => {
  const A = loadTs("lib/workstreams/attach.ts", { "@/lib/workstreams/types": T });
  const change = { id: "change:1", kind: "change", title: "Send deck", subtitle: "Due today", change: { source: "actions", entityId: "act-9" } };
  assert.equal(A.feedKey(change), "action:act-9");
  const fu = { id: "gmail:m1", kind: "followup", title: "Reply to Guy", followup: { source: "gmail", subject: "Atos", preview: "Anja, …", fromEmail: "guy@talentgenius.io" } };
  assert.deepEqual(plain(A.feedSubject(fu)), { key: "gmail:m1", text: "Atos — Anja, …", source: "gmail", senderEmail: "guy@talentgenius.io" });
  const placed = new Map([["action:act-9", { workstream: "clients", by: "user" }]]);
  assert.equal(A.stampFeed([change], placed)[0].workstream, "clients");
  assert.equal(A.stampActions([{ id: "act-9" }], placed)[0].workstream, "clients");
  assert.deepEqual(plain(A.workstreamTotals([{ workstream: "clients" }, { workstream: null }, {}])), { operations: 0, product: 0, research: 0, clients: 1, unsorted: 2 });
});

test("Today filters by workstream BEFORE the display cap; totals stay whole-feed", () => {
  const feedSrc = src("lib/today/feed.ts");
  assert.match(feedSrc, /filter BEFORE the cap/);
  assert.match(feedSrc, /assignWorkstreams\(username, uniqueSubjects[,)]/, "classified in the background compute");
  const route = src("app/api/today/route.ts");
  assert.match(route, /searchParams\.get\("workstream"\)/);
  assert.match(route, /withCurrentWorkstreams/, "corrections overlay the cached feed");
  assert.doesNotMatch(src("app/api/actions/route.ts"), /generateText/, "no model call on reading actions");
});

test("the UI: one remembered filter on Today and Actions; a label you can change on every card", () => {
  assert.match(src("app/dashboard/page.tsx"), /<WorkstreamBar value=\{ws\}/);
  assert.match(src("app/dashboard/actions/page.tsx"), /<WorkstreamBar value=\{ws\}/);
  assert.match(src("components/today/v2/needs-you-card.tsx"), /<WorkstreamChip/);
  assert.match(src("components/today/promise-row.tsx"), /<WorkstreamChip/);
  assert.match(src("components/workstreams/workstream-chip.tsx"), /Always file \{learn\.label\} here/);
});
