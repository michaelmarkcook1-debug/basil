/**
 * Workstream learning (2026-11-24): Basil learns from how the user files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const L = loadTs("lib/workstreams/learn.ts");
const f = (w, feat, at = "2026-11-20T00:00:00Z", extra = {}) => ({ w, f: feat, at, ...extra });
const ids = () => { let n = 0; return () => `L${n++}`; };

test("two filings from one sender, same workstream → a learned rule; one is not enough", () => {
  const one = L.learnRules([f("clients", { sender: "jane@acme.com" })], [], { newId: ids() });
  assert.equal(one.added.length, 0);
  const two = L.learnRules([f("clients", { sender: "jane@acme.com" }), f("clients", { sender: "jane@acme.com" })], [], { newId: ids() });
  const sender = two.added.find((r) => r.field === "sender");
  assert.equal(sender.value, "jane@acme.com");
  assert.equal(sender.workstream, "clients");
  assert.deepEqual({ ...sender.learned }, { from: 2 });
});

test("a company domain needs three agreeing filings, and free mail or your own domain never becomes one", () => {
  const acme = [f("clients", { sender: "a@acme.com" }), f("clients", { sender: "b@acme.com" }), f("clients", { sender: "c@acme.com" })];
  assert.ok(L.learnRules(acme, [], { newId: ids() }).added.some((r) => r.field === "domain" && r.value === "acme.com"));
  assert.ok(!L.learnRules(acme.slice(0, 2), [], { newId: ids() }).added.some((r) => r.field === "domain"));
  const gmail = [f("clients", { sender: "a@gmail.com" }), f("clients", { sender: "b@gmail.com" }), f("clients", { sender: "c@gmail.com" })];
  assert.ok(!L.learnRules(gmail, [], { newId: ids() }).added.some((r) => r.field === "domain"));
  const own = [f("operations", { sender: "a@tg.io" }), f("operations", { sender: "b@tg.io" }), f("operations", { sender: "c@tg.io" })];
  assert.ok(!L.learnRules(own, [], { ownDomains: ["tg.io"], newId: ids() }).added.some((r) => r.field === "domain"));
});

test("disagreeing filings learn nothing, and a contradiction removes a learned rule", () => {
  const mixed = [f("clients", { project: "atlas" }), f("product", { project: "atlas" }), f("clients", { project: "atlas" })];
  assert.equal(L.learnRules(mixed, [], { newId: ids() }).added.length, 0);
  const learned = { id: "x", field: "project", value: "atlas", workstream: "clients", createdAt: "", learned: { from: 2 } };
  const r = L.learnRules(mixed, [learned], { newId: ids() });
  assert.equal(r.removed.length, 1);
  assert.ok(!r.rules.some((x) => x.id === "x"));
});

test("rules you made are never touched; a learned rule you deleted is not learned again", () => {
  const mine = { id: "m", field: "sender", value: "jane@acme.com", workstream: "operations", createdAt: "" };
  const filings = [f("clients", { sender: "jane@acme.com" }), f("clients", { sender: "jane@acme.com" })];
  const r = L.learnRules(filings, [mine], { newId: ids() });
  assert.ok(r.rules.some((x) => x.id === "m" && x.workstream === "operations"));
  assert.ok(!r.added.some((x) => x.field === "sender"));
  const s = L.learnRules(filings, [], { suppressed: ["sender:jane@acme.com"], newId: ids() });
  assert.ok(!s.added.some((x) => x.field === "sender"));
});

test("near-identical items reuse your filing (numbers ignored); short or ambiguous ones do not", () => {
  const filed = [{ w: "operations", t: "Pay invoice 1043 from Smith Accountants Ltd" }, { w: "clients", t: "Weekly pipeline review with sales team" }];
  assert.equal(L.nearestFiling("Pay invoice 1077 from Smith Accountants Ltd", filed), "operations");
  assert.equal(L.nearestFiling("Weekly pipeline review with the sales team", filed), "clients");
  assert.equal(L.nearestFiling("Call", filed), undefined);
  assert.equal(L.nearestFiling("Something else entirely about hiring", filed), undefined);
  const torn = [...filed, { w: "research", t: "Pay invoice 2001 from Smith Accountants Ltd" }];
  assert.equal(L.nearestFiling("Pay invoice 1077 from Smith Accountants Ltd", torn), undefined, "your filings disagree: ask the classifier");
});

test("examples: the most similar filings first, recent ones when nothing is similar", () => {
  const filings = [
    { w: "research", t: "Read the Gartner market note", at: "2026-11-01T00:00:00Z" },
    { w: "product", t: "Fix login bug on staging", at: "2026-11-22T00:00:00Z" },
  ];
  assert.equal(L.similarExamples(["Gartner market sizing note"], filings, 1)[0].w, "research");
  assert.equal(L.similarExamples(["zzz"], filings, 1)[0].w, "product");
});

test("score: how often Basil was right when you checked, and recently", () => {
  const fl = [];
  for (let i = 0; i < 10; i++) fl.push(f("clients", {}, `2026-11-0${i % 9 + 1}T00:00:00Z`, { was: { w: "product", by: "ai" } }));
  for (let i = 0; i < 20; i++) fl.push(f("clients", {}, `2026-11-2${i % 9}T00:00:00Z`, { was: { w: "clients", by: "ai" } }));
  fl.push(f("research", {}));
  const s = L.scoreOf(fl);
  assert.equal(s.checked, 30);
  assert.equal(s.right, 20);
  assert.equal(s.accuracy, 0.67);
  assert.equal(s.filings, 31);
});
