/**
 * Pipedrive (2026-11-24): the client directory, client routing, due
 * activities, and the shape of the integration (read-only, encrypted token,
 * degraded-not-empty).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const S = loadTs("lib/pipedrive/shape.ts");
const R = loadTs("lib/workstreams/rules.ts");
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("website → domain", () => {
  assert.equal(S.domainFromWebsite("https://www.Acme.co.uk/about"), "acme.co.uk");
  assert.equal(S.domainFromWebsite("acme.com"), "acme.com");
  assert.equal(S.domainFromWebsite(""), undefined);
  assert.equal(S.domainFromWebsite("not a url"), undefined);
});

test("directory: people's emails and their organisations' domains; free mail and your own domain never count", () => {
  const persons = [
    { id: 1, name: "Jane", emails: ["Jane@Acme.com"], orgId: 10 },
    { id: 2, name: "Solo", emails: ["solo@gmail.com"], orgId: null },
    { id: 3, name: "Colleague", emails: ["me2@talentgenius.io"], orgId: 10 },
    { id: 4, name: "No org", emails: ["x@loose.io"], orgId: null },
  ];
  const orgs = [{ id: 10, name: "Acme", website: "https://acme.com" }, { id: 11, name: "Beta", domain: "beta.org" }];
  const d = S.buildDirectory(persons, orgs, ["talentgenius.io"]);
  assert.ok(d.emails.has("jane@acme.com"));
  assert.ok(d.emails.has("solo@gmail.com"), "a person's own address still counts");
  assert.ok(!d.emails.has("me2@talentgenius.io"), "your own colleagues are not clients");
  assert.ok(d.domains.has("acme.com") && d.domains.has("beta.org"));
  assert.ok(!d.domains.has("gmail.com"), "a client's gmail must not make every gmail sender a client");
  assert.ok(!d.domains.has("loose.io"), "a person with no organisation does not claim a whole domain");
  assert.equal(S.isClientSender(d, "bob@ACME.com"), true);
  assert.equal(S.isClientSender(d, "bob@eu.acme.com"), true);
  assert.equal(S.isClientSender(d, "random@gmail.com"), false);
  assert.equal(S.isClientSender(d, "solo@gmail.com"), true);
  assert.equal(S.isClientSender(undefined, "bob@acme.com"), false);
});

test("due activities: overdue oldest first, today's by time; undated and future are not due", () => {
  const a = (id, dueDate, dueTime = null) => ({ id, subject: `a${id}`, type: "call", dueDate, dueTime, dealId: null, personId: null, orgId: null, updateTime: "" });
  const { overdue, dueToday } = S.dueActivities([a(1, "2026-11-20"), a(2, "2026-11-24", "15:00"), a(3, "2026-11-24", "09:00"), a(4, "2026-11-10"), a(5, null), a(6, "2026-11-30")], "2026-11-24");
  assert.deepEqual(overdue.map((x) => x.id), [4, 1]);
  assert.deepEqual(dueToday.map((x) => x.id), [3, 2]);
  assert.equal(S.daysBetween("2026-11-20", "2026-11-24"), 4);
});

test("routing: Pipedrive items and client senders go to Clients & Sales; your own rule still wins", () => {
  const isClient = (e) => e === "jane@acme.com";
  assert.deepEqual({ ...R.routeByRules({ key: "p", text: "Call", source: "pipedrive" }, []) }, { workstream: "clients", rule: "builtin:pipedrive" });
  assert.equal(R.routeByRules({ key: "f", text: "Quick question about the invoice", source: "gmail", senderEmail: "jane@acme.com" }, [], isClient).workstream, "clients");
  const mine = [{ id: "r1", field: "sender", value: "jane@acme.com", workstream: "operations", createdAt: "2026-11-01" }];
  assert.equal(R.routeByRules({ key: "f", text: "x", source: "gmail", senderEmail: "jane@acme.com" }, mine, isClient).workstream, "operations");
  assert.equal(R.routeByRules({ key: "f", text: "hello", source: "gmail", senderEmail: "bob@else.com" }, [], isClient), null);
});

test("integration shape: read-only, token encrypted per user, failures are degraded not empty", () => {
  const client = src("lib/pipedrive/client.ts");
  assert.doesNotMatch(client, /method:\s*"(POST|PUT|PATCH|DELETE)"/, "Basil never writes to Pipedrive");
  assert.match(client, /saveIntegrationToken\(username, "pipedrive"/);
  assert.match(client, /"x-api-token"/, "token in a header, never in a URL");
  const feed = src("lib/today/feed.ts");
  assert.match(feed, /pipedriveFailed = true/);
  assert.match(feed, /\["Pipedrive"\]/);
  const tools = src("lib/ai/tools.ts");
  assert.match(tools, /do NOT say there are no deals/);
  assert.match(src("lib/ai/injection-guard.ts"), /"listPipedrive"/, "CRM notes are outside content");
});
