/**
 * 2026-10-08: two ideas from Anthropic's productivity plugin, built into Basil.
 *  - A glossary: the user's shorthand (AG, AIE, AP/TG…) decoded in every prompt,
 *    unknown shorthand surfaced to define once.
 *  - Promise capture: commitments the user makes in their own sent mail become
 *    actions to confirm.
 * Real modules; storage, Gmail and the model are mocked. Synthetic data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadTs, makeLock } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const zod = require("zod");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const plain = (v) => structuredClone(v);

function userStore(seed = {}) {
  const files = new Map(Object.entries(seed).map(([k, v]) => [k, plain(v)]));
  const lock = makeLock(); const key = (u, f) => `${u}/${f}`;
  const readUserStore = async (u, f, fb) => plain(files.has(key(u, f)) ? files.get(key(u, f)) : fb);
  const writeUserStore = async (u, f, v) => { files.set(key(u, f), plain(v)); };
  const updateUserStore = (u, f, mut, fb) => lock.withLock(key(u, f), async () => { const n = mut(await readUserStore(u, f, fb)); await writeUserStore(u, f, n); return n; });
  return { mocks: { readUserStore, writeUserStore, updateUserStore }, get: (u, f) => plain(files.get(key(u, f)) ?? null) };
}

const M = loadTs("lib/glossary/match.ts");
const entry = (term, meaning, over = {}) => ({ id: term, term, meaning, kind: "acronym", aliases: [], createdAt: "", updatedAt: "", ...over });

// ── Glossary ─────────────────────────────────────────────────────────────────

test("matching: word boundaries, case-sensitive for all-caps shorthand, aliases count", () => {
  const ag = entry("AG", "AnalystGenius", { kind: "project", aliases: ["Analyst Genius"] });
  const mig = entry("the migration", "Postgres move", { kind: "term" });
  assert.ok(M.mentions("Demo AG to Caylent", "AG"));
  assert.ok(!M.mentions("we agree on the AGM", "AG"), "not inside words, not 'ag' in 'agree'");
  assert.ok(M.mentions("AP/TG launch", "TG"));
  assert.ok(M.mentions("Is The Migration done?", "the migration"), "non-acronyms match any case");
  assert.equal(M.termsIn("Analyst Genius pricing", [ag, mig]).map((e) => e.term).join(), "AG", "alias hit");
  assert.equal(M.termsIn("", [ag]).length, 0);
});

test("prompt lines are sorted and stable (the chat block is cached byte-for-byte)", () => {
  const a = [entry("TG", "TalentGenius"), entry("AG", "AnalystGenius", { kind: "project", aliases: ["Analyst Genius"] })];
  const lines = M.glossaryLines(a);
  assert.equal(lines, "- **AG** — AnalystGenius (project; also: Analyst Genius)\n- **TG** — TalentGenius");
  assert.equal(M.glossaryLines([...a].reverse()), lines);
});

test("unknown shorthand: recurring, not common, not known, not dismissed — with examples", () => {
  const texts = [
    "Demo AG to the IIAR group", "AG pricing for AIE", "Send AIE deck to Ed", "Check the CEO's API notes",
    "AP/TG launch plan", "AP/TG budget", "Q3 review", "FDE onboarding",
  ];
  const out = M.findUnknownShorthand(texts, [entry("AG", "AnalystGenius")], ["IIAR"]);
  assert.equal(out.map((u) => `${u.term}:${u.count}`).join(","), "AIE:2,AP/TG:2", "AG known, IIAR dismissed, CEO/API common, Q3/FDE too rare");
  assert.match(out[0].examples[0], /AIE/);
  assert.equal(M.findUnknownShorthand(["AP/TG x", "AP/TG y"], [entry("AP", "AgentPowered"), entry("TG", "TalentGenius")], []).length, 0,
    "a compound of known parts is not unknown");
});

test("store: upsert matches by term or alias, un-dismisses, validates; remove works", async () => {
  const st = userStore({ "u/sage-glossary.json": { entries: [], dismissed: ["AG"] } });
  const S = loadTs("lib/glossary/store.ts", { "@/lib/storage/user-store": st.mocks });
  const a = await S.upsertTerm("u", { term: "AG", meaning: "AnalystGenius", kind: "project", aliases: ["Analyst Genius"] });
  const b = await S.upsertTerm("u", { term: "analyst genius", meaning: "AnalystGenius — AR analytics" });
  assert.equal(b.id, a.id, "an alias updates the same entry");
  assert.equal(st.get("u", "sage-glossary.json").entries.length, 1);
  assert.equal(st.get("u", "sage-glossary.json").dismissed.length, 0, "defining a term un-dismisses it");
  await assert.rejects(() => S.upsertTerm("u", { term: " ", meaning: "x" }), /term and its meaning are both required/);
  assert.equal(await S.removeTerm("u", a.id), true);
  assert.equal(st.get("u", "sage-glossary.json").entries.length, 0);
});

function promptModule(glossary) {
  return loadTs("lib/ai/system-prompt.ts", {
    "@/lib/contacts/user-store": { listUserContacts: async () => [] },
    "@/lib/memory/store": { memoriesForPrompt: async () => "" },
    "@/lib/settings/store": { getSettings: async () => ({ name: "Fixture Owner", timezone: "Europe/London", workStart: "09:00", workEnd: "18:00", videoTool: "Zoom", meetingUrl: "" }) },
    "@/lib/users": { findByUsername: async () => ({ profile: {} }) },
    "@/lib/glossary/store": { getGlossary: async () => ({ entries: glossary, dismissed: [] }) },
    "@/lib/glossary/match": M,
  });
}

test("Ask Basil carries the whole glossary in its cached instructions, and asks about unknown shorthand", async () => {
  const P = promptModule([entry("TG", "TalentGenius"), entry("AG", "AnalystGenius", { kind: "project" })]);
  const a = await P.getChatPromptParts("u", "Europe/London", { text: "how is AG going?" });
  const b = await P.getChatPromptParts("u", "Europe/London", { text: "anything new?" });
  assert.equal(a.instructions, b.instructions, "still byte-identical across turns — caching survives");
  assert.match(a.instructions, /## Fixture's Shorthand — decode before acting\n- \*\*AG\*\* — AnalystGenius \(project\)\n- \*\*TG\*\* — TalentGenius/);
  assert.match(a.instructions, /ask once what it means — never guess an expansion — then save the answer with `rememberTerm`/);
});

test("background prompts decode only the shorthand the email actually uses", async () => {
  const P = promptModule([entry("TG", "TalentGenius"), entry("AG", "AnalystGenius")]);
  const t = await P.getTaskSystemPrompt("u", undefined, { memories: 0, glossaryFor: "Can we move the AG demo?" });
  assert.match(t, /\*\*AG\*\* — AnalystGenius/);
  assert.doesNotMatch(t, /TalentGenius/);
  const none = await P.getTaskSystemPrompt("u", undefined, { memories: 0, glossaryFor: "Lunch on Friday?" });
  assert.doesNotMatch(none, /Shorthand/);
  for (const f of ["lib/email/classify-email.ts", "lib/slack/classify-slack.ts", "lib/zoom/extract-meeting.ts", "lib/zoom/process-meeting.ts", "app/api/generate/meeting-prep/route.ts"]) {
    assert.match(src(f), /glossaryFor:/, `${f} passes its text to the glossary`);
  }
});

test("rememberTerm is a chat tool and needs no approval (it only teaches Basil a word)", () => {
  const tools = src("lib/ai/tools.ts");
  const block = tools.slice(tools.indexOf("    rememberTerm: tool({"), tools.indexOf("    rememberThis: tool({"));
  assert.match(block, /upsertTerm\(username/);
  assert.doesNotMatch(block, /needsApproval/);
});

// ── Promise capture ──────────────────────────────────────────────────────────

const C = () => loadTs("lib/commitments/capture.ts", {
  zod,
  "@/lib/google/gmail": { getSentEmails: async () => [], getEmailBody: async () => ({ body: "" }) },
  "@/lib/actions/store": { createActionTracked: async () => ({ created: true }) },
  "@/lib/storage/user-store": userStore().mocks,
  "@/lib/settings/store": { getSettings: async () => ({ name: "Fixture Owner" }) },
  "@/lib/ai/system-prompt": { getTaskSystemPrompt: async () => "" },
  "@/lib/ai/generate": { generateTextSafe: async () => ({ text: "{}" }) },
  "@/lib/ai/model-config": { getTextModel: () => "mock" },
  "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod }),
  "@/lib/email/triage": loadTs("lib/email/triage.ts"),
  "@/lib/security/sensitive": { redactSensitive: (s) => ({ text: s }) },
});

test("only the user's own new text is read — quoted history and Outlook headers are cut", () => {
  const { ownText } = C();
  const gmail = "I'll send the deck by Friday.\n\nOn Tue, 6 Oct 2026 at 10:00, Jane Doe <jane@partner.invalid> wrote:\n> Can you send the deck? I'll review it.";
  assert.equal(ownText(gmail), "I'll send the deck by Friday.");
  const outlook = "Will do — I'll confirm by EOD.\n\nFrom: Jane Doe\nSent: Tuesday\nTo: Fixture\nSubject: deck\nI will be there.";
  assert.equal(ownText(outlook), "Will do — I'll confirm by EOD.");
  assert.equal(ownText("<p>I&#39;ll call you&nbsp;tomorrow</p><div>> old</div>"), "I'll call you tomorrow");
});

test("the cheap gate passes promises and blocks mail with none", () => {
  const { looksLikePromise } = C();
  for (const s of ["I'll send it over", "I will get back to you on pricing", "Let me check with Ed", "Will confirm by Friday", "I can send the contract tomorrow"]) assert.ok(looksLikePromise(s), s);
  for (const s of ["Thanks, see attached", "Great meeting today", "Could you send the deck?", "Sounds good"]) assert.ok(!looksLikePromise(s), s);
});

test("capture: each sent email read once, promises filed for review with your words, calendar replies skipped", async () => {
  const st = userStore();
  const created = []; const prompts = [];
  const mod = loadTs("lib/commitments/capture.ts", {
    zod,
    "@/lib/google/gmail": {},
    "@/lib/actions/store": { createActionTracked: async (_u, input) => { created.push(input); return { created: true }; } },
    "@/lib/storage/user-store": st.mocks,
    "@/lib/settings/store": { getSettings: async () => ({ name: "Fixture Owner" }) },
    "@/lib/ai/system-prompt": { getTaskSystemPrompt: async () => "" },
    "@/lib/ai/generate": {}, "@/lib/ai/model-config": {},
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod }),
    "@/lib/email/triage": loadTs("lib/email/triage.ts"),
    "@/lib/security/sensitive": { redactSensitive: (s) => ({ text: s }) },
  });
  const sent = [
    { id: "s1", to: "jane@partner.invalid", subject: "Deck", date: "2026-10-06T10:00:00Z" },
    { id: "s2", to: "ed@fixture.invalid", subject: "Thanks", date: "2026-10-06T11:00:00Z" },
    { id: "s3", to: "jane@partner.invalid", subject: "Accepted: Pipeline review", date: "2026-10-06T12:00:00Z" },
  ];
  const bodies = { s1: "I'll send the updated deck by Friday.\n\nOn Mon, Jane wrote:\n> please send", s2: "Thanks, great session." };
  const deps = {
    now: Date.parse("2026-10-08T09:00:00Z"),
    sent: async () => sent,
    body: async (_u, id) => bodies[id] ?? "",
    extract: async (prompt) => { prompts.push(prompt); return JSON.stringify({ commitments: [{ text: "Send Jane the updated deck", to: "Jane", dueDate: "2026-10-09", quote: "I'll send the updated deck by Friday." }] }); },
  };
  const out = await mod.captureSentPromises("u", {}, deps);
  assert.equal(JSON.stringify({ scanned: out.scanned, candidates: out.candidates, created: out.created }), JSON.stringify({ scanned: 2, candidates: 1, created: 1 }));
  assert.equal(prompts.length, 1, "the model only reads mail that passed the gate");
  assert.doesNotMatch(prompts[0], /please send/, "quoted history never reaches the model");
  assert.match(prompts[0], /today is 2026-10-08/);
  const a = created[0];
  assert.equal(a.text, "Send Jane the updated deck");
  assert.equal(a.needsReview, true, "you confirm every captured promise");
  assert.equal(a.sourceRef, "gmail:s1");
  assert.equal(a.dueDate, "2026-10-09");
  assert.equal(JSON.stringify(a.commitment), JSON.stringify({ to: "Jane", quote: "I'll send the updated deck by Friday.", sentAt: "2026-10-06T10:00:00Z" }));

  const again = await mod.captureSentPromises("u", {}, deps);
  assert.equal(again.skipped, "recent", "the Actions page can't re-run it within two hours");
  const forced = await mod.captureSentPromises("u", { force: true }, deps);
  assert.equal(forced.scanned, 0, "every message is read once");
  assert.equal(created.length, 1);
});

test("a captured promise closes only when the thread shows it was kept", async () => {
  const R = loadTs("lib/actions/resolve-threads.ts", {
    zod,
    "@/lib/actions/store": {}, "@/lib/google/gmail": {}, "@/lib/slack/client": {}, "@/lib/email/known-senders": {},
    "@/lib/settings/store": {}, "@/lib/ai/generate": {}, "@/lib/ai/model-config": {},
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod }),
    "@/lib/email/triage": loadTs("lib/email/triage.ts"),
  });
  const promise = { text: "Send Jane the deck", commitment: { to: "Jane", quote: "I'll send the deck", sentAt: "2026-10-06T10:00:00Z" } };
  const view = (later) => ({ subject: "Deck", bulk: false, original: { from: "Fixture Owner", date: "2026-10-06T10:00:00Z", text: "I'll send the deck" }, later });
  const modes = [];
  const judge = (stillNeeded) => async ({ mode }) => { modes.push(mode); return { stillNeeded, answeredBy: "", reason: "deck attached" }; };
  const yours = { from: "Fixture Owner", date: "2026-10-07T09:00:00Z", text: "Unrelated: lunch?", self: true };
  assert.equal((await R.decide(promise, view([yours]), judge(true), "Fixture")).kind, "open",
    "your later message is not proof — unlike an ordinary 'reply to' action");
  const kept = await R.decide(promise, view([{ ...yours, text: "Here's the deck" }]), judge(false), "Fixture");
  assert.equal(kept.kind, "promise-kept");
  assert.equal(modes.join(), "promise,promise");
  assert.equal((await R.decide(promise, view([]), judge(false), "Fixture")).kind, "open");
  assert.match(R.judgePrompt("Fixture", "Send Jane the deck", view([yours]), "promise"), /made a promise[\s\S]*Fixture \(you\)/);
});

test("wiring: daily ingest + Actions page capture; the card shows whom you promised", () => {
  assert.match(src("app/api/events/poll-ingest/route.ts"), /captureSentPromises\(username, \{ force: true \}\)/);
  assert.match(src("app/dashboard/actions/page.tsx"), /\/api\/actions\/capture-promises/);
  assert.match(src("app/dashboard/actions/page.tsx"), /You promised\{action\.commitment\.to/);
  assert.match(src("app/dashboard/memory/page.tsx"), /<GlossaryPanel \/>/);
});
