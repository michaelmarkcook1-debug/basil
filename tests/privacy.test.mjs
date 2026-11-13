// People profiles: consent and memory controls (2026-11-10, lib/privacy).
// Basil builds a read of the people the user works with; they never agreed to
// it. One switch turns it off for everyone; per person, "Forget" deletes what
// Basil inferred and stops it building another. The user's own notes are theirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs, makeLock } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const P = loadTs("lib/privacy/rules.ts");
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

const full = {
  personality: "Direct", whatMakesThemTick: "Shipping", watchOut: "Hates surprises", recentActivity: "Asked for the SOW",
  activitySource: "gmail", generatedAt: "2026-11-01T09:00:00Z", summary: "12 signals", changes: "warmer",
  toneHistory: [{ date: "2026-11-01", person: "Dana", direction: "cooling", summary: "curt", source: "email" }],
  ownerNotes: "Met at SaaStr. Prefers calls.",
};

test("forgetting keeps the user's own notes unless asked, and removes everything Basil inferred", () => {
  same(P.stripInferred(full), { ownerNotes: "Met at SaaStr. Prefers calls." });
  assert.equal(P.stripInferred(full, { notes: true }), null, "nothing left: the entry goes");
  assert.equal(P.stripInferred(undefined), null);
  for (const f of ["personality", "whatMakesThemTick", "watchOut", "toneHistory", "generatedAt"]) assert.ok(P.INFERRED_FIELDS.includes(f), f);
  assert.ok(!P.INFERRED_FIELDS.includes("ownerNotes"));
});

test("with profiles off, or for an excluded person, readers get only the user's notes", () => {
  const all = { dana: full, ed: { personality: "Quiet" } };
  same(P.applyPrivacy(all, P.DEFAULT_PRIVACY), all, "on, nobody excluded: unchanged");
  const excluded = { profiling: true, optedOut: { dana: { name: "Dana Lee", at: "2026-11-10T09:00:00Z" } } };
  same(P.applyPrivacy(all, excluded), { dana: { ownerNotes: full.ownerNotes }, ed: { personality: "Quiet" } });
  same(P.applyPrivacy(all, { profiling: false, optedOut: {} }), { dana: { ownerNotes: full.ownerNotes } });
  assert.equal(P.profilingAllowed(excluded, "dana"), false);
  assert.equal(P.profilingAllowed(excluded, "ed"), true);
  assert.equal(P.profilingAllowed({ profiling: false, optedOut: {} }, "ed"), false);
  same(P.normalisePrivacy(null), { profiling: true, optedOut: {} }, "default: on");
});

test("memories filed under the person are matched by their whole name only", () => {
  assert.equal(P.isAboutPerson("Dana Lee", "dana lee"), true);
  assert.equal(P.isAboutPerson("Dana", "Dana Lee"), false, "a first name could be someone else");
  assert.equal(P.isAboutPerson(undefined, "Dana Lee"), false);
});

// ── Store + forget, end to end over a fake Blob ──────────────────────────────

function world() {
  const files = new Map();
  const key = (u, f) => `${u}/${f}`;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const store = {
    readUserStore: async (u, f, fb) => clone(files.get(key(u, f)) ?? fb),
    writeUserStore: async (u, f, d) => { files.set(key(u, f), clone(d)); },
    updateUserStore: async (u, f, fn, fb) => { const next = fn(clone(files.get(key(u, f)) ?? fb)); files.set(key(u, f), clone(next)); return next; },
  };
  const privacyStore = loadTs("lib/privacy/store.ts", { "@/lib/storage/user-store": store, "@/lib/privacy/rules": P });
  const overrides = loadTs("lib/contacts/overrides-store.ts", { "@/lib/storage/user-store": store, "@/lib/events/lock": makeLock(), "@/lib/privacy/store": privacyStore, "@/lib/privacy/rules": P });
  const memories = [{ id: "m1", entity: "Dana Lee", content: "Prefers calls" }, { id: "m2", entity: "Ed Baum", content: "x" }];
  const forget = loadTs("lib/privacy/forget.ts", {
    "@/lib/contacts/overrides-store": overrides,
    "@/lib/contacts/sentiment": { forgetSentiment: async (u, id) => {
      const s = clone(files.get(key(u, "contact-sentiment.json")) ?? {});
      const had = Boolean(s[id]); delete s[id]; files.set(key(u, "contact-sentiment.json"), s); return had;
    } },
    "@/lib/memory/store": { listMemories: async () => memories.slice(), deleteMemory: async (_u, id) => { const i = memories.findIndex((m) => m.id === id); if (i < 0) return false; memories.splice(i, 1); return true; } },
    "@/lib/privacy/store": privacyStore,
    "@/lib/privacy/rules": P,
  });
  files.set(key("u", "sage-contact-overrides.json"), { dana: full, ed: { personality: "Quiet" } });
  files.set(key("u", "contact-sentiment.json"), { dana: { tone: "cool" }, ed: { tone: "warm" } });
  return { files, key, privacyStore, overrides, forget, memories };
}

test("Forget deletes the read, the warmth trend and (if asked) memories; the person is then left alone", async () => {
  const w = world();
  const out = await w.forget.forgetPerson("u", { id: "dana", name: "Dana Lee" }, { memories: true });
  same(out, { profile: true, sentiment: true, memories: 1, optedOut: true });
  same(w.files.get(w.key("u", "sage-contact-overrides.json")).dana, { ownerNotes: full.ownerNotes }, "the user's notes stay");
  assert.equal(w.files.get(w.key("u", "contact-sentiment.json")).dana, undefined);
  same(w.memories.map((m) => m.id), ["m2"], "only memories filed under Dana go");
  assert.equal((await w.privacyStore.getPrivacy("u")).optedOut.dana.name, "Dana Lee");
  await assert.rejects(w.privacyStore.assertProfilingAllowed("u", "dana"), /not to build a profile of this person/);
  await w.privacyStore.assertProfilingAllowed("u", "ed");
});

test("Forget with notes deletes the whole entry; without opt-out Basil may build again", async () => {
  const w = world();
  await w.forget.forgetPerson("u", { id: "dana", name: "Dana Lee" }, { notes: true, optOut: false });
  assert.equal(w.files.get(w.key("u", "sage-contact-overrides.json")).dana, undefined);
  await w.privacyStore.assertProfilingAllowed("u", "dana");
});

test("the profiles switch hides inferred reads from every reader and blocks new profiles", async () => {
  const w = world();
  await w.privacyStore.setProfiling("u", false);
  same(await w.overrides.getAllOverridesFromStore("u"), { dana: { ownerNotes: full.ownerNotes } });
  await assert.rejects(w.privacyStore.assertProfilingAllowed("u", "ed"), /turned off in Settings/);
  await w.privacyStore.setProfiling("u", true);
  assert.equal((await w.overrides.getAllOverridesFromStore("u")).ed.personality, "Quiet", "back on: shown again (it was hidden, not deleted)");
  await w.privacyStore.optOutContact("u", "ed", "Ed Baum");
  await w.privacyStore.optInContact("u", "ed");
  await w.privacyStore.assertProfilingAllowed("u", "ed");
});

test("an unreadable privacy file means do not profile this time", async () => {
  const S = loadTs("lib/privacy/store.ts", { "@/lib/storage/user-store": { readUserStore: async () => { throw new Error("blob down"); } }, "@/lib/privacy/rules": P });
  same(await S.getPrivacyOrClosed("u"), { profiling: false, optedOut: {} });
  await assert.rejects(S.assertProfilingAllowed("u", "x"), /turned off/);
});

test("every builder of a people profile checks the switches", () => {
  assert.match(src("lib/contacts/generate-profile.ts"), /await assertProfilingAllowed\(username, contactId\)/);
  const sentiment = src("lib/contacts/sentiment.ts");
  assert.match(sentiment, /if \(!profilingAllowed\(await getPrivacyOrClosed\(username\), contact\.id\)\) return \{ sentiment: null, interactions: 0 \}/);
  assert.match(sentiment, /const contacts = allContacts\.filter\(\(c\) => profilingAllowed\(privacy, c\.id\)\)/);
  assert.match(src("lib/contacts/tone-store.ts"), /if \(!profilingAllowed\(privacy, contactId\)\) continue;/);
  assert.match(src("app/api/contacts/generate-profile/route.ts"), /e instanceof ProfilingOffError/);
});

test("the controls are where people look: Contacts, Settings and the privacy policy", () => {
  const contacts = src("app/dashboard/contacts/page.tsx");
  assert.match(contacts, /<ForgetPerson contactId=\{contact\.id\}/);
  assert.match(contacts, /<ContactDetail\s+key=\{selected\.id\}/, "a fresh panel per contact (B13: drafts and edits leaked between people)");
  assert.match(contacts, /\(zoomMeetingCount \?\? 0\) > 0 &&/, "no stray 0 when there were no meetings");
  assert.match(src("app/dashboard/settings/page.tsx"), /<PeopleProfilesCard \/>/);
  const policy = src("app/privacy/page.tsx");
  assert.match(policy, /Information about the people you work with/);
  assert.match(policy, /Forget what Basil inferred/);
});
